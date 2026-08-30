import {
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  BASE_FEE,
  Address,
  xdr,
  Account,
  rpc,
} from "@stellar/stellar-sdk";
import type { Agent, MarcConfig } from "./types.js";
import { BaseClient } from "./baseClient.js";
import type { Signer } from "./signer.js";
import { signerPublicKey } from "./signer.js";

/**
 * Typed client for the `agent_identity` Soroban contract.
 *
 * Provides methods to register, look up, update, and deregister on-chain AI
 * agent identities. Handles all ScVal encoding/decoding, transaction building,
 * signing, and submission internally — callers only work with plain JS types.
 *
 * @example
 * ```typescript
 * import { IdentityClient, TESTNET } from "marc-stellar-sdk";
 * import { Keypair } from "@stellar/stellar-sdk";
 *
 * const identity = new IdentityClient(TESTNET);
 * const keypair = Keypair.fromSecret("S...");
 *
 * // Register a new agent
 * const agentId = await identity.register(keypair, "https://ipfs.example/metadata.json");
 * console.log("Registered agent ID:", agentId);
 *
 * // Fetch the agent record
 * const agent = await identity.getAgent(agentId);
 * console.log(agent?.uri);
 * ```
 */
export class IdentityClient extends BaseClient {
  private contract: Contract;

  constructor(cfg: MarcConfig) {
    super(cfg);
    this.contract = new Contract(cfg.identityContract);
  }

  /**
   * Register a new agent on-chain and return its assigned ID.
   *
   * Handles the full transaction lifecycle automatically: fetches the account
   * sequence number, builds the transaction, calls `prepareTransaction` to
   * simulate and attach the Soroban footprint, signs with the provided keypair,
   * submits via `sendTransaction`, and polls until finalized. The caller does
   * not need to build or sign anything manually.
   *
   * @param owner - The owner's Keypair. Used as both the on-chain `owner`
   *                address and the transaction signer.
   * @param uri - Metadata URI for the agent (e.g. a DID document URL or IPFS CID).
   * @returns The assigned on-chain agent ID as a `bigint`, decoded directly
   *          from the contract's `register()` return value.
   * @throws {Error} If the account has insufficient funds, the RPC call fails,
   *                 or the transaction is rejected by the network.
   *
   * @example
   * ```typescript
   * const agentId = await identity.register(keypair, "https://ipfs.io/ipfs/Qm...");
   * // agentId is e.g. 42n
   * ```
   */
  async register(owner: Keypair, uri: string): Promise<bigint> {
    const op = this.contract.call(
      "register",
      new Address(signerPublicKey(owner)).toScVal(),
      nativeToScVal(uri, { type: "string" }),
    );
    return await this.invoke(owner, op, (v) => BigInt(scValToNative(v) as string), "identity");
  }

  /**
   * Look up a registered agent by its on-chain numeric ID.
   *
   * @param id - The agent's unique on-chain identifier (as returned by {@link register}).
   * @returns The {@link Agent} record if found, or `null` if no agent exists with that ID.
   * @throws {Error} On RPC/network failure, so callers can distinguish "not found" from "outage".
   *
   * @example
   * ```typescript
   * const agent = await identity.getAgent(42n);
   * if (agent) {
   *   console.log(agent.owner, agent.uri);
   * }
   * ```
   */
  async getAgent(id: bigint): Promise<Agent | null> {
    const op = this.contract.call("get_agent", nativeToScVal(id, { type: "u64" }));
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

  /**
   * Reverse-lookup: find the agent ID owned by a given Stellar address.
   *
   * @param owner - The Stellar address (G...) to look up.
   * @returns The agent ID as a `bigint` if the address owns a registered agent,
   *          or `null` if no agent is registered for that address.
   * @throws {Error} On RPC/network failure.
   *
   * @example
   * ```typescript
   * const agentId = await identity.agentOf("GABC...");
   * if (agentId !== null) {
   *   console.log("Owner has agent:", agentId);
   * }
   * ```
   */
  async agentOf(owner: string): Promise<bigint | null> {
    const op = this.contract.call("agent_of", new Address(owner).toScVal());
    return await this.simulate(op, (v) => {
      const native = scValToNative(v);
      return native == null ? null : BigInt(native);
    });
  }

  /**
   * Update the metadata URI for an existing agent (owner-only).
   *
   * Only the current owner's keypair can authorize this transaction.
   *
   * @param owner - The current owner's Keypair (must match the on-chain owner address).
   * @param id - The agent ID to update.
   * @param uri - The new metadata URI to set.
   * @returns A promise that resolves when the update is confirmed on-chain.
   * @throws {Error} If the signer is not the agent's owner, or on network failure.
   *
   * @example
   * ```typescript
   * await identity.updateUri(ownerKeypair, 42n, "https://new-uri.example.com/metadata.json");
   * ```
   */
  async updateUri(owner: Signer, id: bigint, uri: string): Promise<void> {
    const op = this.contract.call(
      "update_uri",
      new Address(signerPublicKey(owner)).toScVal(),
      nativeToScVal(id, { type: "u64" }),
      nativeToScVal(uri, { type: "string" }),
    );
    await this.invoke(owner, op, () => undefined, "identity");
  }

  /**
   * Transfer ownership of an agent to a new wallet address.
   *
   * The contract requires authorization from both the current owner and the
   * new owner. Both keypairs are signed into the same transaction.
   *
   * @param owner - The current owner's Keypair. Submits and signs the transaction.
   * @param id - The agent ID to transfer.
   * @param newOwner - The new owner's Keypair. Must also sign to accept ownership.
   * @returns A promise that resolves when the ownership transfer is confirmed on-chain.
   * @throws {Error} If either signature is invalid or the transaction fails.
   *
   * @example
   * ```typescript
   * await identity.updateOwner(currentOwnerKeypair, 42n, newOwnerKeypair);
   * ```
   */
  async updateOwner(owner: Keypair, id: bigint, newOwner: Keypair): Promise<void> {
    const op = this.contract.call(
      "update_owner",
      new Address(owner.publicKey()).toScVal(),
      nativeToScVal(id, { type: "u64" }),
      new Address(newOwner.publicKey()).toScVal(),
    );
    await this.invokeMultiSig(owner, newOwner, op, "identity");
  }

  /**
   * Permanently remove an agent from the registry (owner-only).
   *
   * This action is irreversible. The agent ID will no longer be resolvable
   * after deregistration.
   *
   * @param owner - The current owner's Keypair (must match the on-chain owner address).
   * @param id - The agent ID to deregister.
   * @returns A promise that resolves when the deregistration is confirmed on-chain.
   * @throws {Error} If the signer is not the agent's owner, or on network failure.
   *
   * @example
   * ```typescript
   * await identity.deregister(ownerKeypair, 42n);
   * ```
   */
  async deregister(owner: Signer, id: bigint): Promise<void> {
    const op = this.contract.call(
      "deregister",
      new Address(signerPublicKey(owner)).toScVal(),
      nativeToScVal(id, { type: "u64" }),
    );
    await this.invoke(owner, op, () => undefined, "identity");
  }

  /**
   * Get the token balance of an address.
   *
   * Supports both native XLM and any Soroban token contract (SAC or custom).
   *
   * @param address - The Stellar address (G...) to query.
   * @param token - Either `"native"` for XLM (returns stroops as `bigint`),
   *                or a Soroban token contract address (C...) for SAC/custom tokens.
   * @returns The balance as a `bigint` in the smallest unit of the token
   *          (stroops for XLM, micro-USDC for USDC, etc.).
   * @throws {Error} On RPC failure or if the address does not exist on-chain.
   *
   * @example
   * ```typescript
   * // XLM balance in stroops
   * const xlm = await identity.getBalance("GABC...", "native");
   * console.log("XLM stroops:", xlm);
   *
   * // USDC balance
   * const usdc = await identity.getBalance("GABC...", TESTNET.usdcToken);
   * console.log("USDC micro-units:", usdc);
   * ```
   */
  async getBalance(address: string, token: string): Promise<bigint> {
    if (token === "native") {
      const account = await this.server.getAccount(address);
      const balances =
        (account as unknown as { balances?: Array<{ asset_type?: string; balance?: string }> })
          .balances ?? [];
      const xlmBalance = balances.find((b) => b.asset_type === "native");
      return BigInt(Math.round(Number(xlmBalance?.balance ?? "0") * 1e7));
    }
    const tokenContract = new Contract(token);
    const op = tokenContract.call("balance", new Address(address).toScVal());
    return await this.simulate(op, (v) => BigInt(scValToNative(v) as string));
  }

  /**
   * List all registered agents by scanning sequential IDs up to `maxId`.
   *
   * Iterates IDs from 1 to `maxId` (inclusive), skipping any gaps where an
   * agent is not found. This is a best-effort scan — agents deregistered mid-scan
   * will simply be absent from results.
   *
   * @param maxId - The highest agent ID to check. Default: `200n`.
   *                Increase for large registries; decrease to reduce RPC calls.
   * @returns An array of {@link Agent} records for all agents found in the range.
   *
   * @example
   * ```typescript
   * const agents = await identity.listAgents(500n);
   * console.log(`Found ${agents.length} registered agents`);
   * ```
   */
  async listAgents(maxId = 200n): Promise<Agent[]> {
    const agents: Agent[] = [];
    for (let id = 1n; id <= maxId; id++) {
      const agent = await this.getAgent(id);
      if (!agent) continue;
      agents.push(agent);
    }
    return agents;
  }

  /**
   * Disconnect and clean up any resources held by this client.
   *
   * The RPC server uses stateless HTTP connections, so this is currently a
   * no-op. Call it for symmetry when disposing of client instances.
   */
  disconnect(): void {
    // No-op for the current implementation.
  }

  // --- internals ---

  /** Submit a transaction signed by two keypairs (old owner + new owner). */
  private async invokeMultiSig(
    signer1: Keypair,
    signer2: Keypair,
    op: xdr.Operation,
    txLabel: string,
  ): Promise<void> {
    const account = await this.server.getAccount(signer1.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(signer1);
    prepared.sign(signer2);
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
  }
}
