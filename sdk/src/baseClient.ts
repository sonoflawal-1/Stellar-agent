import { Keypair, rpc, TransactionBuilder, BASE_FEE, xdr, Account } from "@stellar/stellar-sdk";
import type { MarcConfig } from "./types.js";
import type { Signer } from "./signer.js";
import { toSigner } from "./signer.js";

/**
 * Abstract base class for Soroban contract clients.
 *
 * Provides shared transaction submission and simulation logic used by
 * {@link IdentityClient} and {@link CommerceClient}. Handles ScVal
 * encoding/decoding, transaction building, RPC submission, polling for
 * finality, and retry logic with exponential backoff.
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

  /**
   * @param cfg - SDK configuration including the RPC URL, network passphrase,
   *              and deployed contract addresses.
   */
  constructor(protected cfg: MarcConfig) {
    this.server = new rpc.Server(cfg.rpcUrl, {
      allowHttp: cfg.rpcUrl.startsWith("http://"),
      timeout: 15000,
    });
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
  ): Promise<T> {
    const walletSigner = toSigner(signer);
    const account = await this.server.getAccount(walletSigner.publicKey);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
    const prepared = await this.server.prepareTransaction(tx);
    const signedXdr = await walletSigner.signTransaction(prepared.toXDR(), {
      networkPassphrase: this.cfg.networkPassphrase,
    });
    const signedTx = TransactionBuilder.fromXDR(signedXdr, this.cfg.networkPassphrase);
    const sent = await this.server.sendTransaction(signedTx);
    if (sent.status === "ERROR") throw new Error(`submit failed: ${sent.errorResult}`);
    let getResp = await this.server.getTransaction(sent.hash);
    while (getResp.status === "NOT_FOUND") {
      await new Promise((r) => setTimeout(r, 1000));
      getResp = await this.server.getTransaction(sent.hash);
    }
    if (getResp.status !== "SUCCESS") {
      const failed = getResp as rpc.Api.GetFailedTransactionResponse;
      const detail = failed.resultXdr?.result()?.switch()?.name ?? getResp.status;
      throw new Error(`tx failed: ${detail}`);
    }
    this.cfg.onTx?.(sent.hash, txLabel);
    return decode(getResp.returnValue!);
  }

  /**
   * Simulate a read-only contract call without submitting a transaction.
   *
   * Uses an ephemeral random keypair so no real account or funds are needed.
   * Retries up to 3 times with exponential backoff (2 s, 4 s) on transient errors.
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
        const sim = await this.server.simulateTransaction(tx);
        if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
        const result = (sim as rpc.Api.SimulateTransactionSuccessResponse).result;
        if (!result) throw new Error("no simulation result");
        return decode(result.retval);
      } catch (err) {
        if (attempt === 3) throw err;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    throw new Error("unreachable");
  }

  /**
   * Simulate a contract call whose return type is `Option<T>` (may be absent).
   *
   * Behaves like {@link simulate} but handles Soroban `ScVal::Void` (the encoding
   * of `Option::None`) by returning `null` instead of decoding. Throws on any
   * RPC/simulation error so callers can distinguish "not found" from "outage".
   *
   * Retries up to 3 times with exponential backoff on transient failures.
   *
   * @param op - The contract operation to simulate.
   * @param decode - Decoder applied to a non-void `retval` ScVal.
   * @returns The decoded value, or `null` if the contract returned `None` / `ScVal::Void`.
   * @throws {Error} On RPC/simulation failure after 3 attempts.
   */
  protected async simulateOption<T>(
    op: xdr.Operation,
    decode: (v: xdr.ScVal) => T,
  ): Promise<T | null> {
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
        const sim = await this.server.simulateTransaction(tx);
        // RPC-level error — throw so callers know the network/contract failed.
        if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
        const result = (sim as rpc.Api.SimulateTransactionSuccessResponse).result;
        // No result object means the RPC response was malformed — throw.
        if (!result) throw new Error("no simulation result");
        // ScVal::Void is how Soroban encodes Option::None — genuine not-found.
        if (result.retval.switch() === xdr.ScValType.scvVoid()) return null;
        return decode(result.retval);
      } catch (err) {
        if (attempt === 3) throw err;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    throw new Error("unreachable");
  }

  /**
   * Disconnect and clean up any resources held by this client.
   *
   * The Soroban RPC server uses stateless HTTP connections, so no active
   * connections need to be closed. This method is a no-op and exists for
   * API symmetry — call it when disposing of client instances in code that
   * manages connection lifecycles.
   */
  disconnect(): void {
    // No-op: RPC Server uses stateless HTTP, no long-lived connections to close
  }
}
