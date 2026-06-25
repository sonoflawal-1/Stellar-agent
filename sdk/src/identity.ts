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
import type { Agent, MarcConfig } from "./types.js";

/**
 * Typed wrapper around the `agent_identity` Soroban contract.
 *
 * Provides `register`, `getAgent`, `agentOf`, `updateUri`, and `deregister`
 * methods that handle ScVal encoding/decoding, transaction building, and
 * submission via Soroban RPC.
 */
export class IdentityClient {
  private server: rpc.Server;
  private contract: Contract;

  constructor(private cfg: MarcConfig) {
    this.server = new rpc.Server(cfg.rpcUrl, {
      allowHttp: cfg.rpcUrl.startsWith("http://"),
      timeout: 15000,
    });
    this.contract = new Contract(cfg.identityContract);
  }

  /**
   * Register a new agent and return its on-chain ID.
   *
   * Accepts the owner's `Keypair` and handles the full transaction lifecycle
   * automatically: builds the transaction, fetches the account sequence number,
   * calls `prepareTransaction` to simulate and attach the Soroban footprint,
   * signs with the provided keypair, submits via `sendTransaction`, and polls
   * until the transaction is finalized on-chain. The caller does not need to
   * build or sign anything manually.
   *
   * @param owner - The owner's Keypair. Used both as the on-chain `owner`
   *                address and to sign the transaction.
   * @param uri   - Metadata URI for the agent (e.g. a DID document URL).
   * @returns The assigned on-chain agent ID as a `bigint`.
   */
  async register(owner: Keypair, uri: string): Promise<bigint> {
    const op = this.contract.call(
      "register",
      new Address(owner.publicKey()).toScVal(),
      nativeToScVal(uri, { type: "string" }),
    );
    return await this.invoke(owner, op, (v) => BigInt(scValToNative(v) as string));
  }

  /** Look up an agent by its numeric ID. Returns null if not found. */
  async getAgent(id: bigint): Promise<Agent | null> {
    const op = this.contract.call(
      "get_agent",
      nativeToScVal(id, { type: "u64" }),
    );
    return await this.simulate(op, (v) => {
      const native = scValToNative(v);
      if (!native) return null;
      return {
        id: BigInt(native.id),
        owner: native.owner,
        uri: native.uri,
      } as Agent;
    });
  }

  /** Reverse-lookup: find the agent ID owned by `owner`. */
  async agentOf(owner: string): Promise<bigint | null> {
    const op = this.contract.call(
      "agent_of",
      new Address(owner).toScVal(),
    );
    return await this.simulate(op, (v) => {
      const native = scValToNative(v);
      return native == null ? null : BigInt(native);
    });
  }

  /** Update an agent's metadata URI (owner-only). */
  async updateUri(owner: Keypair, id: bigint, uri: string): Promise<void> {
    const op = this.contract.call(
      "update_uri",
      new Address(owner.publicKey()).toScVal(),
      nativeToScVal(id, { type: "u64" }),
      nativeToScVal(uri, { type: "string" }),
    );
    await this.invoke(owner, op, () => undefined);
  }

  /** List all registered agents by scanning sequential IDs until a gap. */
  async listAgents(maxId = 200n): Promise<Agent[]> {
    const agents: Agent[] = [];
    for (let id = 1n; id <= maxId; id++) {
      const agent = await this.getAgent(id);
      if (!agent) break;
      agents.push(agent);
    }
    return agents;
  }

  /** Permanently remove an agent (owner-only). */
  async deregister(owner: Keypair, id: bigint): Promise<void> {
    const op = this.contract.call(
      "deregister",
      new Address(owner.publicKey()).toScVal(),
      nativeToScVal(id, { type: "u64" }),
    );
    await this.invoke(owner, op, () => undefined);
  }

  // --- internals ---

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
    this.cfg.onTx?.(sent.hash, "identity");
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
