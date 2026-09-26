import { Keypair, rpc, TransactionBuilder, BASE_FEE, xdr, Account, Memo } from "@stellar/stellar-sdk";
import type { MarcConfig } from "./types.js";
import type { Signer } from "./signer.js";
import { toSigner } from "./signer.js";
import { maskSecret } from "./format.js";
import {
  ContractError,
  SimulationError,
  TransactionTimeoutError,
  extractContractErrorCode,
  resolveContractErrorExplanation,
} from "./errors.js";

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
    options: { memo?: string } = {},
  ): Promise<T> {
    const walletSigner = toSigner(signer);
    const account = await this.server.getAccount(walletSigner.publicKey);
    let builder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    }).addOperation(op);
    if (options.memo) {
      builder = builder.addMemo(Memo.text(options.memo));
    }
    const tx = builder.setTimeout(30).build();
    const prepared = await this.server.prepareTransaction(tx);
    const signedXdr = await walletSigner.signTransaction(prepared.toXDR(), {
      networkPassphrase: this.cfg.networkPassphrase,
    });
    const signedTx = TransactionBuilder.fromXDR(signedXdr, this.cfg.networkPassphrase);
    const sent = await this.server.sendTransaction(signedTx);
    const contractAddr =
      txLabel === "identity" ? this.cfg.identityContract : this.cfg.commerceContract;

    if (sent.status === "ERROR") {
      const errStr = maskSecret(`submit failed: ${sent.errorResult}`);
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

    const startTime = Date.now();
    const timeoutMs = this.cfg.pollTimeoutMs ?? 60000;
    let getResp = await this.server.getTransaction(sent.hash);
    while (getResp.status === "NOT_FOUND") {
      if (Date.now() - startTime >= timeoutMs) {
        throw new TransactionTimeoutError(sent.hash, Date.now() - startTime);
      }
      await new Promise((r) => setTimeout(r, 1000));
      getResp = await this.server.getTransaction(sent.hash);
    }
    if (getResp.status !== "SUCCESS") {
      const failed = getResp as rpc.Api.GetFailedTransactionResponse;
      const detail = failed.resultXdr?.result()?.switch()?.name ?? getResp.status;
      const resultXdrStr = failed.resultXdr ? failed.resultXdr.toXDR("base64") : "";
      const rawDetail = maskSecret(`tx failed: ${detail}`);
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
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(maskSecret(sim.error));
    const fee = (sim as rpc.Api.SimulateTransactionSuccessResponse).minResourceFee ?? BASE_FEE;
    return BigInt(fee);
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
        await new Promise((r) => setTimeout(r, 2000 * attempt))

/* … truncated 2984 chars — edit only what you need near the top … */
