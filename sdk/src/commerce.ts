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
import {
  signerPublicKey,
  toSigner,
  type Signer,
} from "./signer.js";

/**
 * Typed wrapper around the `agentic_commerce` Soroban contract.
 *
 * Handles job lifecycle: create → submit → complete/cancel, plus
 * admin helpers (setTreasury, setFeeBps) and read-only queries.
 */
export class CommerceClient {
  private server: rpc.Server;
  private contract: Contract;

  constructor(private cfg: MarcConfig) {
    this.server = new rpc.Server(cfg.rpcUrl, {
      allowHttp: cfg.rpcUrl.startsWith("http://"),
      timeout: 15000,
    });
    this.contract = new Contract(cfg.commerceContract);
  }

  /**
   * Create a funded job. Pulls `budget` of `token` from `client` into escrow.
   * Returns the new job ID.
   */
  async createJob(
    client: Signer,
    provider: string,
    evaluator: string,
    token: string,
    budget: bigint,
    description: string,
  ): Promise<bigint> {
    const op = this.contract.call(
      "create_job",
      new Address(signerPublicKey(client)).toScVal(),
      new Address(provider).toScVal(),
      new Address(evaluator).toScVal(),
      new Address(token).toScVal(),
      nativeToScVal(budget, { type: "i128" }),
      nativeToScVal(description, { type: "string" }),
    );
    return await this.invoke(client, op, (v) => BigInt(scValToNative(v) as string));
  }

  /** Provider submits a deliverable for a funded job. */
  async submit(
    provider: Signer,
    jobId: bigint,
    deliverable: string,
  ): Promise<void> {
    const op = this.contract.call(
      "submit",
      new Address(signerPublicKey(provider)).toScVal(),
      nativeToScVal(jobId, { type: "u64" }),
      nativeToScVal(deliverable, { type: "string" }),
    );
    await this.invoke(provider, op, () => undefined);
  }

  /** Evaluator marks a submitted job as completed (triggers 99/1 payout). */
  async complete(evaluator: Signer, jobId: bigint): Promise<void> {
    const op = this.contract.call(
      "complete",
      new Address(signerPublicKey(evaluator)).toScVal(),
      nativeToScVal(jobId, { type: "u64" }),
    );
    await this.invoke(evaluator, op, () => undefined);
  }

  /** Client cancels a funded job (full refund). */
  async cancel(client: Signer, jobId: bigint): Promise<void> {
    const op = this.contract.call(
      "cancel",
      new Address(signerPublicKey(client)).toScVal(),
      nativeToScVal(jobId, { type: "u64" }),
    );
    await this.invoke(client, op, () => undefined);
  }

  /** Read a job by ID. Returns null if not found. */
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
      } as Job;
    });
  }

  /** Read the current fee in basis points. */
  async feeBps(): Promise<number> {
    const op = this.contract.call("fee_bps");
    return await this.simulate(op, (v) => Number(scValToNative(v)));
  }

  /** Admin: update the treasury address. */
  async setTreasury(admin: Signer, newTreasury: string): Promise<void> {
    const op = this.contract.call(
      "set_treasury",
      new Address(signerPublicKey(admin)).toScVal(),
      new Address(newTreasury).toScVal(),
    );
    await this.invoke(admin, op, () => undefined);
  }

  /** Admin: update the fee (capped at 500 bps / 5%). */
  async setFeeBps(admin: Signer, newBps: number): Promise<void> {
    const op = this.contract.call(
      "set_fee_bps",
      new Address(signerPublicKey(admin)).toScVal(),
      nativeToScVal(newBps, { type: "u32" }),
    );
    await this.invoke(admin, op, () => undefined);
  }

  // --- internals (same pattern as IdentityClient) ---

  private async invoke<T>(
    signer: Signer,
    op: xdr.Operation,
    decode: (scVal: xdr.ScVal) => T,
  ): Promise<T> {
    const s = toSigner(signer);
    const account = await this.server.getAccount(s.publicKey);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
    const prepared = await this.server.prepareTransaction(tx);
    const signedXdr = await s.signTransaction(
      prepared.toXDR(),
      { networkPassphrase: this.cfg.networkPassphrase },
    );
    const signed = TransactionBuilder.fromXDR(
      signedXdr,
      this.cfg.networkPassphrase,
    );
    const sent = await this.server.sendTransaction(signed);
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
