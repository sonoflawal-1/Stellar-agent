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
import type { Agent, MarcConfig, DelegateInfo } from "./types.js";
import { BaseClient } from "./baseClient.js";
import type { Signer } from "./signer.js";
import { signerPublicKey, toSigner } from "./signer.js";
import { isValidMetadataUri } from "./format.js";

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
   * @param owner - The owner's Signer. Used as both the on-chain `owner`
   *                address and the transaction signer.
   * @param uri - Metadata URI for the agent (e.g. a DID document URL or IPFS CID).
   *              Must be `https://` or `ipfs://`; see {@link isValidMetadataUri}.
   * @returns The assigned on-chain agent ID as a `bigint`, decoded directly
   *          from the contract's `register()` return value.
   * @throws {Error} If `uri` fails {@link isValidMetadataUri}, the account has
   *                 insufficient funds, the RPC call fails, or the transaction
   *                 is rejected by the network.
   *
   * @example
   * ```typescript
   * const agentId = await identity.register(keypair, "https://ipfs.io/ipfs/Qm...");
   * // agentId is e.g. 42n
   * ```
   */
  async register(owner: Signer, uri: string): Promise<bigint> {
    if (!isValidMetadataUri(uri)) {
      throw new Error(`invalid metadata uri: ${uri}`);
    }
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
   * Convenience helper: look up an agent by its owner's wallet address.
   *
   * Combines `agentOf` and `getAgent` into a single call. Returns `null` if
   * the owner has not registered an agent.
   *
   * @param ownerAddress - The owner's Stellar address in StrKey format.
   * @returns The `Agent` record, or `null` if no agent is registered for this owner.
   *
   * @example
   * const agent = await identity.getAgentByOwner('GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTBVDJ42LPBK4EK4YLYL2QQ5K');
   * if (agent) {
   *   console.log('Agent ID:', agent.id);
   * }
   */
  async getAgentByOwner(ownerAddress: string): Promise<Agent | null> {
    const id = await this.agentOf(ownerAddress);
    if (id == null) return null;
    return this.getAgent(id);
  }

  /**
   * Update an agent's metadata URI (owner-only).
   *
   * @throws {Error} If `uri` fails {@link isValidMetadataUri}.
   */
  async updateUri(owner: Signer, id: bigint, uri: string): Promise<void> {
    if (!isValidMetadataUri(uri)) {
      throw new Error(`invalid metadata uri: ${uri}`);
    }
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
   * @param owner - The current owner's Signer. Submits and signs the transaction.
   * @param id - The agent ID to transfer.
   * @param newOwner - The new owner's Signer. Must also sign to accept ownership.
   * @returns A promise that resolves when the ownership transfer is confirmed on-chain.
   * @throws {Error} If either signature is invalid or the transaction fails.
   *
   * @example
   * ```typescript
   * await identity.updateOwner(currentOwnerKeypair, 42n, newOwnerKeypair);
   * ```
   */
  async updateOwner(owner: Signer, id: bigint, newOwner: Signer): Promise<void> {
    const op = this.contract.call(
      "update_owner",
      new Address(signerPublicKey(owner)).toScVal(),
      nativeToScVal(id, { type: "u64" }),
      new Address(signerPublicKey(newOwner)).toScVal(),
    );
    await this.invokeMultiSig(owner, newOwner, op, "identity");
  }

  /**
   * Permanently remove an agent from the registry (owner-only).
   *
   * This action is irreversible. The agent ID will no longer be resolvable
   * after deregistration.
   *
   * @param owner - The current owner's Signer (must match the on-chain owner address).
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

  async registeredCount(): Promise<number> {
    const op = this.contract.call("registered_count");
    return await this.simulate(op, (v) => Number(scValToNative(v)));
  }

  /**
   * Fetch the capability badges (verified credentials) attached to an agent.
   *
   * Badges are stored on the identity contract and represent verified
   * capabilities (e.g. `"code-review"`, `"translation"`) that buyers and the
   * dashboard can display. Returns an empty array when the agent has no badges
   * or does not exist, so callers can safely iterate without null checks.
   *
   * @param agentId - The agent's unique on-chain identifier.
   * @returns An array of badge identifier strings, in contract-stored order.
   * @throws {Error} On RPC/network failure.
   *
   * @example
   * ```typescript
   * const badges = await identity.getBadges(42n);
   * console.log("Verified capabilities:", badges);
   * ```
   */
  async getBadges(agentId: bigint): Promise<string[]> {
    const op = this.contract.call("get_badges", nativeToScVal(agentId, { type: "u64" }));
    return await this.simulate(op, (v) => {
      const native = scValToNative(v);
      if (native == null) return [];
      return (native as unknown[]).map((b) => String(b));
    });
  }

  // -------------------------------------------------------------------------
  // #696 — Delegate / WebAuthn session key management
  // -------------------------------------------------------------------------

  /**
   * Grant a time-bounded delegate key for an agent (#696).
   *
   * The `owner` must sign. The delegate key (`delegateAddress`) can be an
   * ephemeral session key or a WebAuthn passkey-backed address. The contract
   * stores the record under `DataKey::Delegate(agentId, delegateAddress)`.
   *
   * @param owner           - Agent owner's Signer.
   * @param agentId         - On-chain agent ID.
   * @param delegateAddress - Stellar address of the delegate key.
   * @param opts.ttl        - Seconds from now until the delegate expires.
   * @param opts.permissions - Bitmask of allowed operations (see `DelegatePermission`).
   */
  async addDelegate(
    owner: Signer,
    agentId: bigint,
    delegateAddress: string,
    opts: { ttl: bigint; permissions: number },
  ): Promise<void> {
    const op = this.contract.call(
      "add_delegate",
      new Address(signerPublicKey(owner)).toScVal(),
      nativeToScVal(agentId, { type: "u64" }),
      new Address(delegateAddress).toScVal(),
      nativeToScVal(opts.ttl, { type: "u64" }),
      nativeToScVal(opts.permissions, { type: "u32" }),
    );
    await this.invoke(owner, op, () => undefined, "identity");
  }

  /**
   * Revoke a previously-granted delegate key (owner-only, #696).
   *
   * @param owner           - Agent owner's Signer.
   * @param agentId         - On-chain agent ID.
   * @param delegateAddress - Stellar address of the delegate to revoke.
   */
  async revokeDelegate(
    owner: Signer,
    agentId: bigint,
    delegateAddress: string,
  ): Promise<void> {
    const op = this.contract.call(
      "revoke_delegate",
      new Address(signerPublicKey(owner)).toScVal(),
      nativeToScVal(agentId, { type: "u64" }),
      new Address(delegateAddress).toScVal(),
    );
    await this.invoke(owner, op, () => undefined, "identity");
  }

  /**
   * Read a delegate record for a given (agentId, delegateAddress) pair (#696).
   *
   * Returns `null` if no delegate is stored or if the record has expired.
   *
   * @param agentId         - On-chain agent ID.
   * @param delegateAddress - Stellar address of the delegate to look up.
   * @returns The {@link DelegateInfo} record if found and non-expired, else `null`.
   */
  async getDelegate(agentId: bigint, delegateAddress: string): Promise<DelegateInfo | null> {
    const op = this.contract.call(
      "get_delegate",
      nativeToScVal(agentId, { type: "u64" }),
      new Address(delegateAddress).toScVal(),
    );
    return await this.simulate(op, (v) => {
      const native = scValToNative(v);
      if (!native) return null;
      return {
        delegateAddress: String(native.delegate_address),
        validUntil: BigInt(native.valid_until),
        permissions: Number(native.permissions),
      } as DelegateInfo;
    });
  }

  /**
   * Verify whether `callerAddress` is authorised to act on behalf of `agentId`
   * with `requiredPermission` (#696).
   *
   * Returns `true` if the caller is the agent owner or a non-expired delegate
   * with the required permission bit set. Returns `false` if the check fails
   * (rather than throwing), making it easy to use in conditional guards.
   *
   * Note: this is a *simulation* — it does not consume gas or modify state.
   *
   * @param agentId            - On-chain agent ID.
   * @param callerAddress      - Stellar address to check authorization for.
   * @param requiredPermission - Bitmask of required permissions.
   * @returns `true` if authorized, `false` otherwise.
   */
  async checkDelegate(
    agentId: bigint,
    callerAddress: string,
    requiredPermission: number,
  ): Promise<boolean> {
    const op = this.contract.call(
      "check_delegate",
      nativeToScVal(agentId, { type: "u64" }),
      new Address(callerAddress).toScVal(),
      nativeToScVal(requiredPermission, { type: "u32" }),
    );
    try {
      await this.simulate(op, () => undefined);
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------

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

  /** Submit a transaction signed by two signers (old owner + new owner). */
  private async invokeMultiSig(
    signer1: Signer,
    signer2: Signer,
    op: xdr.Operation,
    txLabel: string,
  ): Promise<void> {
    const s1 = toSigner(signer1);
    const s2 = toSigner(signer2);
    const account = await this.server.getAccount(signerPublicKey(s1));
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
    const prepared = await this.server.prepareTransaction(tx);
    await s1.sign(prepared);
    await s2.sign(prepared);
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
