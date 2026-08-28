import { Keypair, rpc, TransactionBuilder, BASE_FEE, xdr, Account } from "@stellar/stellar-sdk";
import type { MarcConfig } from "./types.js";

/**
 * Base class for Soroban contract clients.
 *
 * Provides shared transaction submission and simulation logic used by
 * IdentityClient and CommerceClient. Handles ScVal encoding/decoding,
 * transaction building, RPC submission, and retry logic.
 */
export abstract class BaseClient {
  protected server: rpc.Server;

  constructor(protected cfg: MarcConfig) {
    this.server = new rpc.Server(cfg.rpcUrl, {
      allowHttp: cfg.rpcUrl.startsWith("http://"),
      timeout: 15000,
    });
  }

  /**
   * Submit a transaction signed by a single keypair.
   *
   * @param signer - The keypair to sign the transaction
   * @param op - The contract operation to execute
   * @param decode - Function to decode the return value from ScVal
   * @param txLabel - Label for the onTx callback (e.g., "identity", "commerce")
   * @returns The decoded return value
   */
  protected async invoke<T>(
    signer: Keypair,
    op: xdr.Operation,
    decode: (scVal: xdr.ScVal) => T,
    txLabel: string,
  ): Promise<T> {
    const account = await this.server.getAccount(signer.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(signer);
    const sent = await this.server.sendTransaction(prepared);
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
   * Simulate a transaction without submitting it.
   *
   * Uses retry logic with exponential backoff for transient errors.
   *
   * @param op - The contract operation to simulate
   * @param decode - Function to decode the return value from ScVal
   * @returns The decoded return value
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
   * Simulate a contract call that returns `Option<T>` (Soroban `ScVal::Void` = None).
   * Throws on RPC/simulation errors so callers can distinguish network failures
   * from a genuine not-found (which returns `null`).
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
   * Clean up resources (no-op for stateless HTTP clients).
   * Call this when the client is no longer needed for symmetry with other clients.
   * The RPC server uses stateless HTTP connections, so no cleanup is required.
   */
  disconnect(): void {
    // No-op: RPC Server uses stateless HTTP, no long-lived connections to close
  }
}
