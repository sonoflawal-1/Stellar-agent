import {
  Contract,
  Keypair,
  rpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  BASE_FEE,
  Address,
  xdr,
  Account,
} from "@stellar/stellar-sdk";
import type { Job, JobStatus, MarcConfig } from "./types.js";

// --- ScVal helpers (exported for custom contract interactions) ---

/** Encode a bigint as a 128-bit signed integer ScVal. */
export const i128ToScVal = (v: bigint) => nativeToScVal(v, { type: "i128" });

/** Encode a bigint as a 128-bit unsigned integer ScVal. */
export const u128ToScVal = (v: bigint) => nativeToScVal(v, { type: "u128" });

/** Encode a bigint as a 64-bit unsigned integer ScVal. */
export const u64ToScVal  = (v: bigint) => nativeToScVal(v, { type: "u64" });

/** Encode a number as a 32-bit unsigned integer ScVal. */
export const u32ToScVal  = (v: number) => nativeToScVal(v, { type: "u32" });

/** Encode a string as a string ScVal. */
export const strToScVal  = (v: string) => nativeToScVal(v, { type: "string" });

/** Encode a Stellar address string as an address ScVal. */
export const addrToScVal = (v: string) => new Address(v).toScVal();

/**
 * Typed wrapper around the `agentic_commerce` Soroban contract.
 *
 * Handles the complete job lifecycle: create → submit → complete/cancel, plus
 * admin helpers (setTreasury, setFeeBps) and read-only queries. Automatically
 * manages ScVal encoding/decoding, transaction building, and RPC submission.
 *
 * @example
 * ```typescript
 * const client = new CommerceClient(TESTNET);
 * const jobId = await client.createJob(
 *   clientKeypair,
 *   providerAddress,
 *   evaluatorAddress,
 *   tokenAddress,
 *   1_000_000n, // 1 USDC (with 6 decimals)
 *   "Build me a website"
 * );
 * await client.disconnect();
 * ```
 */
export class CommerceClient {
  private server: rpc.Server;
  private contract: Contract;

  /**
   * Initialize the CommerceClient with a configuration.
   *
   * @param cfg - Configuration containing RPC URL, network passphrase, contract address, etc.
   */
  constructor(private cfg: MarcConfig) {
    this.server = new rpc.Server(cfg.rpcUrl, {
      allowHttp: cfg.rpcUrl.startsWith("http://"),
      timeout: 15000,
    });
    this.contract = new Contract(cfg.commerceContract);
  }

  /**
   * Create a new job with token held in escrow.
   *
   * Transfers `budget` tokens from the client to the contract escrow account.
   * The client, provider, and evaluator must all have received auth-signatures
   * for the contract invocation (handled automatically by this method).
   *
   * @param client - The job creator's keypair (must sign the transaction)
   * @param provider - The service provider's Stellar address
   * @param evaluator - The evaluator's Stellar address (approves completion)
   * @param token - Token contract address (e.g., USDC SAC)
   * @param budget - Token amount in smallest units (e.g., 1_000_000 = 1 USDC with 6 decimals)
   * @param description - Human-readable job description
   * @returns The newly assigned job ID
   */
  async createJob(
    client: Keypair,
    provider: string,
    evaluator: string,
    token: string,
    budget: bigint,
    description: string,
  ): Promise<bigint> {
    const op = this.contract.call(
      "create_job",
      new Address(client.publicKey()).toScVal(),
      new Address(provider).toScVal(),
      new Address(evaluator).toScVal(),
      new Address(token).toScVal(),
      nativeToScVal(budget, { type: "i128" }),
      nativeToScVal(description, { type: "string" }),
    );
    return await this.invoke(client, op, (v) => BigInt(scValToNative(v) as string));
  }

  /**
   * Submit a deliverable for a funded job (provider-only).
   *
   * @param provider - The service provider's keypair (must match the job's provider)
   * @param jobId - The ID of the job being worked on
   * @param deliverable - IPFS hash or URL pointing to the completed work
   */
  async submit(
    provider: Keypair,
    jobId: bigint,
    deliverable: string,
  ): Promise<void> {
    const op = this.contract.call(
      "submit",
      new Address(provider.publicKey()).toScVal(),
      nativeToScVal(jobId, { type: "u64" }),
      nativeToScVal(deliverable, { type: "string" }),
    );
    await this.invoke(provider, op, () => undefined);
  }

  /**
   * Mark a submitted job as completed and trigger payout (evaluator-only).
   *
   * Splits the budget 99% to provider, 1% to treasury. Requires auth from
   * the evaluator address recorded during job creation.
   *
   * @param evaluator - The evaluator's keypair (must match the job's evaluator)
   * @param jobId - The ID of the job to complete
   */
  async complete(evaluator: Keypair, jobId: bigint): Promise<void> {
    const op = this.contract.call(
      "complete",
      new Address(evaluator.publicKey()).toScVal(),
      nativeToScVal(jobId, { type: "u64" }),
    );
    await this.invoke(evaluator, op, () => undefined);
  }

  /**
   * Cancel a funded job and refund the full budget (client-only).
   *
   * Only callable while the job is in the Funded state. After cancellation,
   * the full budget is returned to the client's token balance.
   *
   * @param client - The job creator's keypair (must match the job's client)
   * @param jobId - The ID of the job to cancel
   */
  async cancel(client: Keypair, jobId: bigint): Promise<void> {
    const op = this.contract.call(
      "cancel",
      new Address(client.publicKey()).toScVal(),
      nativeToScVal(jobId, { type: "u64" }),
    );
    await this.invoke(client, op, () => undefined);
  }

  /**
   * Read a job by ID.
   *
   * @param jobId - The job's ID
   * @returns The job record, or null if the ID does not exist
   */
  async getJob(jobId: bigint): Promise<Job | null> {
    const op = this.contract.call(
      "get_job",
      nativeToScVal(jobId, { type: "u64" }),
    );
    return await this.simulate(op, (v) => {
      const native = scValToNative(v);
      if (!native) return null;
      return {
        id: BigInt(native.id),
        client: native.client,
        provider: native.provider,
        evaluator: native.evaluator,
        token: native.token,
        budget: BigInt(native.budget),
        status: (Array.isArray(native.status) ? native.status[0] : native.status) as JobStatus,
        description: native.description,
        deliverable: native.deliverable,
        funded_at: BigInt(native.funded_at ?? 0),
        created_at: BigInt(native.created_at ?? 0),
        updated_at: BigInt(native.updated_at ?? 0),
      } as Job;
    });
  }

  /**
   * Read the current treasury fee in basis points (e.g., 100 = 1%).
   *
   * @returns Fee as an integer (1-500, capped at 5%)
   */
  async feeBps(): Promise<number> {
    const op = this.contract.call("fee_bps");
    return await this.simulate(op, (v) => Number(scValToNative(v)));
  }

  /**
   * Update the treasury address (admin-only).
   *
   * @param admin - The admin keypair (must be authorized in contract state)
   * @param newTreasury - The new treasury's Stellar address
   */
  async setTreasury(admin: Keypair, newTreasury: string): Promise<void> {
    const op = this.contract.call(
      "set_treasury",
      new Address(admin.publicKey()).toScVal(),
      new Address(newTreasury).toScVal(),
    );
    await this.invoke(admin, op, () => undefined);
  }

  /**
   * Update the treasury fee in basis points (admin-only, capped at 500 = 5%).
   *
   * @param admin - The admin keypair (must be authorized in contract state)
   * @param newBps - New fee in basis points (1-500)
   */
  async setFeeBps(admin: Keypair, newBps: number): Promise<void> {
    const op = this.contract.call(
      "set_fee_bps",
      new Address(admin.publicKey()).toScVal(),
      nativeToScVal(newBps, { type: "u32" }),
    );
    await this.invoke(admin, op, () => undefined);
  }

  /**
   * Clean up resources (no-op for stateless HTTP clients).
   * Call this when the client is no longer needed for symmetry with other clients.
   * The RPC server uses stateless HTTP connections, so no cleanup is required.
   */
  disconnect(): void {
    // No-op: RPC Server uses stateless HTTP, no long-lived connections to close
  }

  /**
   * Get the balance of `address` for a given token.
   * Pass `"native"` for XLM (returns stroops as bigint),
   * or a Soroban token contract address for SAC/custom tokens.
   */
  async getBalance(address: string, token: string): Promise<bigint> {
    if (token === "native") {
      const account = await this.server.getAccount(address);
      // Cast to any to access Horizon Account properties (balances)
      // Note: RPC Account doesn't have balances; this queries Horizon-compatible endpoint
      const xlmBalance = (account as any).balances?.find((b: any) => b.asset_type === "native");
      return BigInt(Math.round(Number(xlmBalance?.balance ?? "0") * 1e7));
    }
    const tokenContract = new Contract(token);
    const op = tokenContract.call("balance", new Address(address).toScVal());
    return await this.simulate(op, (v) => BigInt(scValToNative(v) as string));
  }

  // --- internals (same pattern as IdentityClient) ---

  private async invoke<T>(
    signer: Keypair,
    op: xdr.Operation,
    decode: (scVal: xdr.ScVal) => T,
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
    this.cfg.onTx?.(sent.hash, "commerce");
    return decode(getResp.returnValue!);
  }

  private async simulate<T>(op: xdr.Operation, decode: (v: xdr.ScVal) => T): Promise<T> {
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
}
