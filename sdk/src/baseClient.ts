import { Keypair, rpc, TransactionBuilder, BASE_FEE, xdr, Account, Memo } from "@stellar/stellar-sdk";
import type { MarcConfig } from "./types.js";
import type { Signer } from "./signer.js";
import { toSigner } from "./signer.js";
import { maskSecret } from "./format.js";
import {
  ContractError,
  MarcApiError,
  SimulationError,
  TransactionTimeoutError,
  extractContractErrorCode,
  resolveContractErrorExplanation,
} from "./errors.js";
import { withSpan } from "./tracing.js";

// ---------------------------------------------------------------------------
// #781 — RPC Failover Pool
// ---------------------------------------------------------------------------

/** Health state of a single RPC endpoint tracked by the pool. */
export interface RpcEndpointHealth {
  url: string;
  healthy: boolean;
  consecutiveFailures: number;
  latencyMs: number;
  lastChecked: number;
}

/**
 * Manages a pool of Soroban RPC endpoints with automatic health checking,
 * transparent failover, and exponential-backoff recovery probing.
 *
 * ### Behaviour
 * - Calls are initially sent to the *lowest-latency* healthy endpoint.
 * - On a network error or 5xx, the endpoint's `consecutiveFailures` counter
 *   increments. Once it reaches `maxConsecutiveFailures` (default 3) the
 *   endpoint is marked **unhealthy** and removed from the active rotation.
 * - A background probe interval (default 30 s) re-tests unhealthy endpoints
 *   via `getLatestLedger()`. On success the endpoint is restored.
 * - If *all* endpoints become unhealthy the pool throws an informative error
 *   rather than silently hanging.
 *
 * @example
 * ```typescript
 * const pool = new RpcFailoverPool(
 *   ["https://soroban-testnet.stellar.org", "https://rpc.ankr.com/stellar_testnet"],
 *   { maxConsecutiveFailures: 2, probeIntervalMs: 15_000 },
 * );
 * const server = pool.pick();   // fastest healthy endpoint
 * ```
 */
export class RpcFailoverPool {
  private endpoints: RpcEndpointHealth[];
  private servers: Map<string, rpc.Server>;
  private probeTimer?: ReturnType<typeof setInterval>;
  private readonly maxConsecutiveFailures: number;
  private readonly probeIntervalMs: number;

  constructor(
    urls: string[],
    opts: { maxConsecutiveFailures?: number; probeIntervalMs?: number } = {},
  ) {
    if (urls.length === 0) throw new Error("RpcFailoverPool requires at least one URL");
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 3;
    this.probeIntervalMs = opts.probeIntervalMs ?? 30_000;

    this.endpoints = urls.map((url) => ({
      url,
      healthy: true,
      consecutiveFailures: 0,
      latencyMs: 0,
      lastChecked: 0,
    }));

    this.servers = new Map(
      urls.map((url) => [
        url,
        new rpc.Server(url, { allowHttp: url.startsWith("http://"), timeout: 15_000 }),
      ]),
    );

    // Start background probe loop
    this.probeTimer = setInterval(() => void this.probeUnhealthy(), this.probeIntervalMs);
    // Allow process to exit even if the interval is still active
    if (typeof this.probeTimer.unref === "function") this.probeTimer.unref();
  }

  /**
   * Return the healthiest `rpc.Server` instance — preferring the lowest
   * latency among healthy endpoints. Falls back to *any* endpoint if none
   * are currently marked healthy (rare transient case), throwing only when
   * the pool is empty.
   */
  pick(): rpc.Server {
    const healthy = this.endpoints.filter((e) => e.healthy);
    const candidates = healthy.length > 0 ? healthy : this.endpoints;
    if (candidates.length === 0) throw new Error("RpcFailoverPool: no endpoints available");

    // Prefer the endpoint with the lowest recorded latency (or 0 = untested = prefer first)
    const best = candidates.reduce((a, b) => {
      if (a.latencyMs === 0) return a;
      if (b.latencyMs === 0) return b;
      return a.latencyMs <= b.latencyMs ? a : b;
    });

    return this.servers.get(best.url)!;
  }

  /**
   * Execute `fn` against the best healthy endpoint. On failure, mark that
   * endpoint as degraded and retry against the next candidate until one
   * succeeds or all are exhausted.
   *
   * Each retry uses exponential backoff: 200 ms * 2^attempt (capped at 2 s).
   */
  async call<T>(fn: (server: rpc.Server) => Promise<T>): Promise<T> {
    const healthy = this.endpoints.filter((e) => e.healthy);
    const order = healthy.length > 0 ? healthy : [...this.endpoints];

    let lastErr: unknown;
    for (let i = 0; i < order.length; i++) {
      const ep = order[i]!;
      const server = this.servers.get(ep.url)!;
      const t0 = Date.now();
      try {
        const result = await fn(server);
        ep.latencyMs = Date.now() - t0;
        ep.consecutiveFailures = 0;
        ep.healthy = true;
        ep.lastChecked = Date.now();
        return result;
      } catch (err) {
        lastErr = err;
        ep.consecutiveFailures += 1;
        ep.lastChecked = Date.now();
        if (ep.consecutiveFailures >= this.maxConsecutiveFailures) {
          ep.healthy = false;
        }
        // Exponential backoff before trying the next endpoint
        if (i < order.length - 1) {
          const delay = Math.min(200 * Math.pow(2, i), 2000);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error("RpcFailoverPool: all endpoints failed");
  }

  /** Re-test any unhealthy endpoints and restore them if they respond. */
  private async probeUnhealthy(): Promise<void> {
    const unhealthy = this.endpoints.filter((e) => !e.healthy);
    await Promise.allSettled(
      unhealthy.map(async (ep) => {
        const server = this.servers.get(ep.url)!;
        const t0 = Date.now();
        try {
          await server.getLatestLedger();
          ep.latencyMs = Date.now() - t0;
          ep.consecutiveFailures = 0;
          ep.healthy = true;
          ep.lastChecked = Date.now();
        } catch {
          ep.lastChecked = Date.now();
        }
      }),
    );
  }

  /** Snapshot of all endpoint health states (useful for observability). */
  healthSnapshot(): readonly RpcEndpointHealth[] {
    return this.endpoints.map((e) => ({ ...e }));
  }

  /** Stop the background probe timer. */
  destroy(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
  }
}

// ---------------------------------------------------------------------------
// #789 — Client-side sequence number tracking
// ---------------------------------------------------------------------------

/**
 * A minimal promise-chain mutex. JavaScript is single-threaded, so a
 * promise-chain is sufficient to serialize asynchronous critical sections
 * without interleaving.
 */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /** Run `fn` exclusively; the returned promise resolves with `fn`'s result. */
  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * Tracks in-flight transaction sequence numbers per account so that an agent
 * can dispatch many transactions in rapid succession without hitting
 * `txBAD_SEQ` (Horizon/Soroban RPC reject a transaction whose sequence number
 * has already been consumed by a still-pending transaction).
 *
 * ### Behaviour
 * - The first allocation for an account fetches the current sequence number
 *   from the RPC server via `getAccount()`.
 * - Subsequent allocations increment the locally cached number, so a burst of
 *   N calls produces N distinct, strictly increasing sequence numbers.
 * - Allocations are serialized through a {@link Mutex}, guaranteeing that
 *   concurrent async task loops never receive the same sequence number.
 * - {@link resync} discards the cached value and re-fetches from the network,
 *   which is required after a `txBAD_SEQ` failure or when an external wallet
 *   has submitted a transaction out-of-band.
 *
 * @example
 * ```typescript
 * const mgr = new AccountSequenceManager((pk) => server.getAccount(pk));
 * const seq1 = await mgr.next("G..."); // fetched from network
 * const seq2 = await mgr.next("G..."); // seq1 + 1, no network round-trip
 * await mgr.resync("G...");            // forget cache, re-fetch next time
 * ```
 */
export class AccountSequenceManager {
  /** Cached next sequence number (as a string) keyed by account public key. */
  private sequences = new Map<string, string>();
  /** Per-account mutexes serializing allocation for that account. */
  private locks = new Map<string, Mutex>();
  /** Global mutex guarding creation of per-account mutexes. */
  private registryLock = new Mutex();

  /**
   * @param fetchSequence - Loads the current sequence number for an account
   *                        from the network (typically `server.getAccount()`).
   */
  constructor(
    private readonly fetchSequence: (publicKey: string) => Promise<{ sequenceNumber(): string }>,
  ) {}

  /** Return (creating if necessary) the mutex for a given account. */
  private async lockFor(publicKey: string): Promise<Mutex> {
    return this.registryLock.runExclusive(() => {
      let lock = this.locks.get(publicKey);
      if (!lock) {
        lock = new Mutex();
        this.locks.set(publicKey, lock);
      }
      return lock;
    });
  }

  /**
   * Allocate the next sequence number for `publicKey`.
   *
   * The first call fetches from the network; every subsequent call increments
   * the cached value locally. Allocation is atomic per account.
   */
  async next(publicKey: string): Promise<string> {
    const lock = await this.lockFor(publicKey);
    return lock.runExclusive(async () => {
      const cached = this.sequences.get(publicKey);
      if (cached === undefined) {
        const account = await this.fetchSequence(publicKey);
        const seq = account.sequenceNumber();
        // The account's sequence number is the last *used* value; the next
        // transaction must use seq + 1.
        const next = (BigInt(seq) + 1n).toString();
        this.sequences.set(publicKey, next);
        return next;
      }
      const next = (BigInt(cached) + 1n).toString();
      this.sequences.set(publicKey, next);
      return next;
    });
  }

  /**
   * Discard the cached sequence number for `publicKey` so the next allocation
   * re-fetches from the network. Call this after a `txBAD_SEQ` failure or when
   * an external wallet may have submitted a transaction out-of-band.
   */
  async resync(publicKey: string): Promise<void> {
    const lock = await this.lockFor(publicKey);
    await lock.runExclusive(() => {
      this.sequences.delete(publicKey);
    });
  }

  /** Forget all cached sequence numbers (e.g. on a full client reset). */
  reset(): void {
    this.sequences.clear();
  }
}

/** Returns true when an error message indicates a bad sequence number. */
function isBadSequenceError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /txBAD_SEQ|bad[_ ]?seq|bad sequence/i.test(msg);
}

// ---------------------------------------------------------------------------

/**
 * Abstract base class for Soroban contract clients.
 *
 * Provides shared transaction submission and simulation logic used by
 * {@link IdentityClient} and {@link CommerceClient}. Handles ScVal
 * encoding/decoding, transaction building, RPC submission, polling for
 * finality, and retry logic with exponential backoff.
 *
 * When `cfg.rpcUrls` is provided the client instantiates an
 * {@link RpcFailoverPool} for transparent multi-endpoint failover (#781).
 * `cfg.rpcUrl` is used as a single-endpoint fallback for backward compatibility.
 *
 * Subclasses must call `super(cfg)` in their constructors and then
 * instantiate their specific `Contract` instances.
 *
 * @example
 * ```typescript
 * // You don't instantiate BaseClient directly — use IdentityClient or CommerceClient:
 * import { IdentityClient, CommerceClient, TESTNET } from "marc-stellar-sdk";
 * const identity = new IdentityClient(TESTNET);
 * const commerce = new CommerceClient(TESTNET);
 * ```
 */
export abstract class BaseClient {
  /** Soroban JSON-RPC server used for simulation and transaction submission. */
  protected server: rpc.Server;
  /** Multi-endpoint failover pool (populated when cfg.rpcUrls is provided). */
  protected rpcPool?: RpcFailoverPool;
  /** Client-side sequence number tracker preventing txBAD_SEQ on rapid calls (#789). */
  protected sequenceManager: AccountSequenceManager;

  /**
   * @param cfg - SDK configuration including the RPC URL(s), network passphrase,
   *              and deployed contract addresses. When `rpcUrls` is provided a
   *              failover pool is used; otherwise the single `rpcUrl` is used.
   */
  constructor(protected cfg: MarcConfig) {
    const urls = cfg.rpcUrls && cfg.rpcUrls.length > 0
      ? cfg.rpcUrls
      : [cfg.rpcUrl];

    this.rpcPool = new RpcFailoverPool(urls, {
      maxConsecutiveFailures: 3,
      probeIntervalMs: 30_000,
    });

    // `this.server` points to the first URL for legacy internal methods that
    // don't yet use pool.call(). pool.call() overrides this dynamically.
    this.server = new rpc.Server(urls[0]!, {
      allowHttp: urls[0]!.startsWith("http://"),
      timeout: 15000,
    });

    // #789 — sequence numbers are fetched through the failover pool so that a
    // degraded endpoint does not stall rapid successive submissions.
    this.sequenceManager = new AccountSequenceManager((publicKey) =>
      this.rpcCall((s) => s.getAccount(publicKey), "soroban.getAccount"),
    );
  }

  /**
   * Execute an RPC operation through the failover pool.
   * Falls back to `this.server` when the pool is not configured.
   *
   * The operation is wrapped in an OpenTelemetry span (issue #726) so that
   * Soroban RPC latency is visible in distributed traces.
   */
  protected async rpcCall<T>(
    fn: (server: rpc.Server) => Promise<T>,
    spanName = "soroban.rpc",
  ): Promise<T> {
    return withSpan(spanName, async (span) => {
      span.setAttribute("rpc.system", "soroban");
      span.setAttribute("rpc.pool.enabled", Boolean(this.rpcPool));
      if (this.rpcPool) return this.rpcPool.call(fn);
      return fn(this.server);
    });
  }

  /**
   * Perform an HTTP request against a dashboard `/api` route and parse the
   * structured error envelope `{ error: { code, message, requestId } }`
   * (issue #967) into a {@link MarcApiError}.
   *
   * Successful (2xx) responses are returned as parsed JSON. Any non-2xx
   * response is converted into a `MarcApiError` carrying the server-provided
   * `code`, `message`, `requestId`, and HTTP status. If the body is not a
   * valid structured error envelope, a generic `MarcApiError` is thrown so
   * callers always receive a consistent error type.
   *
   * @param url - Absolute or relative URL of the dashboard API route.
   * @param init - Optional fetch options (method, headers, body, ...).
   * @returns The parsed JSON body of a successful response.
   * @throws {MarcApiError} When the response status is not 2xx.
   */
  protected async apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);

    if (response.ok) {
      return (await response.json()) as T;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    throw MarcApiError.fromResponseBody(body, response.status);
  }

  /**
   * Build, sign, submit, and poll a contract-invocation transaction.
   *
   * Fetches the account sequence number, builds the transaction, calls
   * `prepareTransaction` to simulate and attach the Soroban footprint,
   * signs with the provided signer, submits via `sendTransaction`, and
   * polls until the transaction is finalized (SUCCESS or FAILED).
   *
   * Accepts both a `Keypair` (Node/demo flows) and a `WalletSigner`
   * (browser wallet flows) via the `Signer` union type.
   *
   * @param signer - The signer that signs and pays fees for the transaction.
   * @param op - The pre-built Soroban contract operation to include.
   * @param decode - Decoder applied to the transaction's return ScVal.
   * @param txLabel - Short label passed to the `onTx` callback (e.g. `"identity"`, `"commerce"`).
   * @returns The decoded return value of type `T`.
   * @throws {Error} If the transaction is rejected (`ERROR` status), if the on-chain
   *                 execution fails, or on any RPC/network failure.
   */
  protected async invoke<T>(
    signer: Signer,
    op: xdr.Operation,
    decode: (scVal: xdr.ScVal) => T,
    txLabel: string,
    options: { memo?: string } = {},
  ): Promise<T> {
    const walletSigner = toSigner(signer);
    const contractAddr =
      txLabel === "identity" ? this.cfg.identityContract : this.cfg.commerceContract;

    // #789 — retry loop: on a bad-sequence failure we re-sync with the network
    // and rebuild the transaction with a fresh sequence number.
    const maxSeqRetries = 3;
    let sent: rpc.Api.SendTransactionResponse | undefined;
    let tx: ReturnType<TransactionBuilder["build"]> | undefined;

    for (let attempt = 0; attempt <= maxSeqRetries; attempt++) {
      // Allocate the next sequence number atomically. The first call fetches
      // from the network; subsequent rapid calls increment locally.
      const sequence = await this.sequenceManager.next(walletSigner.publicKey);
      const account = new Account(walletSigner.publicKey, sequence);

      let builder = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.cfg.networkPassphrase,
      }).addOperation(op);
      if (options.memo) {
        builder = builder.addMemo(Memo.text(options.memo));
      }
      tx = builder.setTimeout(30).build();
      const prepared = await this.rpcCall((s) => s.prepareTransaction(tx), "soroban.simulate");
      const signedXdr = await walletSigner.signTransaction(prepared.toXDR(), {
        networkPassphrase: this.cfg.networkPassphrase,
      });
      const signedTx = TransactionBuilder.fromXDR(signedXdr, this.cfg.networkPassphrase);

      try {
        sent = await this.rpcCall((s) => s.sendTransaction(signedTx), "soroban.submit");
      } catch (err) {
        // Network error: re-sync so the next attempt starts from a known-good
        // sequence number, then retry if attempts remain.
        await this.sequenceManager.resync(walletSigner.publicKey);
        if (attempt === maxSeqRetries) throw err;
        continue;
      }

      if (sent.status === "ERROR") {
        const errStr = maskSecret(`submit failed: ${sent.errorResult}`);
        if (isBadSequenceError(errStr) && attempt < maxSeqRetries) {
          // txBAD_SEQ — our cached sequence is stale (e.g. an external wallet
          // submitted a transaction). Re-sync and retry.
          await this.sequenceManager.resync(walletSigner.publicKey);
          continue;
        }
        const code = extractContractErrorCode(errStr);
        if (code !== null) {
          throw new ContractError(
            code,
            contractAddr,
            resolveContractErrorExplanation(code, contractAddr, this.cfg.identityContract),
          );
        }
        throw new Error(errStr);
      }

      break;
    }

    if (!sent || !tx) {
      throw new Error("invoke: failed to submit transaction after retries");
    }

    const startTime = Date.now();
    const timeoutMs = this.cfg.pollTimeoutMs ?? 60000;
    let getResp = await this.rpcCall((s) => s.getTransaction(sent.hash), "soroban.getTransaction");
    while (getResp.status === "NOT_FOUND") {
      if (Date.now() - startTime >= timeoutMs) {
        throw new TransactionTimeoutError(sent.hash, Date.now() - startTime);
      }
      await new Promise((r) => setTimeout(r, 1000));
      getResp = await this.rpcCall((s) => s.getTransaction(sent.hash), "soroban.getTransaction");
    }
    if (getResp.status !== "SUCCESS") {
      const failed = getResp as rpc.Api.GetFailedTransactionResponse;
      const detail = failed.resultXdr?.result()?.switch()?.name ?? getResp.status;
      const resultXdrStr = failed.resultXdr ? failed.resultXdr.toXDR("base64") : "";
      const rawDetail = maskSecret(`tx failed: ${detail}`);
      // A bad-sequence failure surfaced at finality time means our cache is
      // stale; drop it so the next call re-fetches from the network.
      if (isBadSequenceError(rawDetail) || isBadSequenceError(resultXdrStr)) {
        await this.sequenceManager.resync(walletSigner.publicKey);
      }
      const code = extractContractErrorCode(rawDetail) ?? extractContractErrorCode(resultXdrStr);
      if (code !== null) {
        throw new ContractError(
          code,
          contractAddr,
          resolveContractErrorExplanation(code, contractAddr, this.cfg.identityContract),
        );
      }
      throw new Error(rawDetail);
    }
    this.cfg.onTx?.(sent.hash, txLabel);
    return decode(getResp.returnValue!);
  }

  /**
   * Simulate one contract operation and return the RPC-estimated resource fee.
   */
  protected async estimateOperationFee(op: xdr.Operation): Promise<bigint> {
    const ephemeral = Keypair.random();
    const dummy = new Account(ephemeral.publicKey(), "0");
    const tx = new TransactionBuilder(dummy, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
    const sim = await this.rpcCall((s) => s.simulateTransaction(tx), "soroban.simulate");
    if (rpc.Api.isSimulationError(sim)) throw new Error(maskSecret(sim.error));
    const fee = (sim as rpc.Api.SimulateTransactionSuccessResponse).minResourceFee ?? BASE_FEE;
    return BigInt(fee);
  }

  /**
   * Simulate a read-only contract call without submitting a transaction.
   *
   * Uses an ephemeral random keypair so no real account or funds are needed.
   * Retries up to 3 times with exponential backoff (2 s, 4 s) on transient errors.
   * All retry attempts are routed through the RPC failover pool (#781).
   *
   * @param op - The contract operation to simulate (must be a pure read call).
   * @param decode - Decoder applied to the simulation result's `retval` ScVal.
   * @returns The decoded return value of type `T`.
   * @throws {Error} If the simulation returns an error or after 3 failed attempts.
   */
  protected async simulate<T>(op: xdr.Operation, decode: (v: xdr.ScVal) => T): Promise<T> {
    const ephemeral = Keypair.random();
    const dummy = new Account(ephemeral.publicKey(), "0");
    const tx = new TransactionBuilder(dummy, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const sim = await this.rpcCall((s) => s.simulateTransaction(tx), "soroban.simulate");
        if (rpc.Api.isSimulationError(sim)) {
          const errMsg = maskSecret(sim.error);
          const code = extractContractErrorCode(errMsg);
          if (code !== null) {
            throw new ContractError(
              code,
              this.cfg.commerceContract,
              resolveContractErrorExplanation(code, this.cfg.commerceContract, this.cfg.identityContract),
            );
          }
          throw new SimulationError(errMsg, sim, tx.toXDR());
        }
        const result = (sim as rpc.Api.SimulateTransactionSuccessResponse).result;
        if (!result) throw new SimulationError("no simulation result", sim, tx.toXDR());
        return decode(result.retval);
      } catch (err) {
        if (err instanceof ContractError) throw err;
        if (attempt === 3) throw err;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    // TypeScript requires a return here; the loop always throws or returns above.
    throw new Error("simulate: exhausted retries");
  }

  /**
   * Simulate an optional-return contract call (returns `null` when the contract
   * returns `ScvVoid` or a missing Option).
   */
  protected async simulateOption<T>(
    op: xdr.Operation,
    decode: (v: xdr.ScVal) => T,
  ): Promise<T | null> {
    return this.simulate(op, (v) => {
      if (v.switch() === xdr.ScValType.scvVoid()) return null;
      return decode(v);
    });
  }
}
