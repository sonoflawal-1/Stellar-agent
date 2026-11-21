#!/usr/bin/env node
/**
 * scripts/state-dump.ts
 *
 * Contract state snapshot export and ledger verification tool.
 *
 * Connects to a Soroban RPC endpoint, reads all persistent storage entries for
 * the agent-identity and agentic-commerce contracts, decodes the raw XDR
 * ScVal structures into typed JSON, computes a SHA-256 state root over a
 * canonical serialization of the entries, and writes a JSON manifest plus a
 * human-readable summary report.
 *
 * Usage:
 *   npm run state:dump -- [--identity <CONTRACT_ID>] [--commerce <CONTRACT_ID>]
 *                         [--out <dir>] [--dry-run|--offline] [--batch-size <n>]
 *
 * Environment:
 *   STELLAR_RPC_URL          Soroban RPC endpoint (default: testnet)
 *   IDENTITY_CONTRACT_ID     agent-identity contract id
 *   COMMERCE_CONTRACT_ID     agentic-commerce contract id
 *   STATE_DUMP_OUT           output directory (default: ./state-dump)
 *   STATE_DUMP_BATCH_SIZE    ledger entry batch size (default: 50)
 *
 * Exit codes:
 *   0  success
 *   1  RPC / decode / configuration failure
 */

import { createHash } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import {
  Address,
  Contract,
  Keypair,
  Networks,
  StrKey,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { Server, Api } from "@stellar/stellar-sdk/rpc";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_RPC_URL = "https://soroban-testnet.stellar.org";
const DEFAULT_OUT_DIR = "./state-dump";
const DEFAULT_BATCH_SIZE = 50;

interface CliConfig {
  rpcUrl: string;
  identityContractId: string | undefined;
  commerceContractId: string | undefined;
  outDir: string;
  batchSize: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliConfig {
  const args = argv.slice(2);
  let identityContractId = process.env.IDENTITY_CONTRACT_ID;
  let commerceContractId = process.env.COMMERCE_CONTRACT_ID;
  let outDir = process.env.STATE_DUMP_OUT ?? DEFAULT_OUT_DIR;
  let batchSize = Number(process.env.STATE_DUMP_BATCH_SIZE ?? DEFAULT_BATCH_SIZE);
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--identity":
        identityContractId = args[++i];
        break;
      case "--commerce":
        commerceContractId = args[++i];
        break;
      case "--out":
        outDir = args[++i];
        break;
      case "--batch-size":
        batchSize = Number(args[++i]);
        break;
      case "--dry-run":
      case "--offline":
        dryRun = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown argument: ${arg}`);
        }
    }
  }

  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    throw new Error(`Invalid batch size: ${batchSize}`);
  }

  return {
    rpcUrl: process.env.STELLAR_RPC_URL ?? DEFAULT_RPC_URL,
    identityContractId,
    commerceContractId,
    outDir,
    batchSize,
    dryRun,
  };
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(`Usage: state-dump [options]

Options:
  --identity <CONTRACT_ID>   agent-identity contract id (env: IDENTITY_CONTRACT_ID)
  --commerce <CONTRACT_ID>   agentic-commerce contract id (env: COMMERCE_CONTRACT_ID)
  --out <dir>                output directory (env: STATE_DUMP_OUT, default: ${DEFAULT_OUT_DIR})
  --batch-size <n>           ledger entry batch size (env: STATE_DUMP_BATCH_SIZE, default: ${DEFAULT_BATCH_SIZE})
  --dry-run, --offline       skip RPC calls; validate script and emit empty manifest
  -h, --help                 show this help

Environment:
  STELLAR_RPC_URL            Soroban RPC endpoint (default: ${DEFAULT_RPC_URL})
`);
}

// ---------------------------------------------------------------------------
// Typed state interfaces (mirror the contract storage layouts)
// ---------------------------------------------------------------------------

/** agent-identity: Agent record stored under DataKey::Agent(agent_id). */
export interface Agent {
  agent_id: string;
  owner: string;
  metadata_uri: string;
  registered_at: number;
  active: boolean;
}

/** agent-identity: OwnerMapping stored under DataKey::Owner(owner_address). */
export interface OwnerMapping {
  owner: string;
  agent_ids: string[];
}

/** agentic-commerce: Job record stored under DataKey::Job(job_id). */
export interface Job {
  job_id: string;
  client: string;
  provider: string;
  amount: string;
  status: string;
  created_at: number;
}

/** agentic-commerce: EscrowBalance stored under DataKey::Escrow(job_id). */
export interface EscrowBalance {
  job_id: string;
  token: string;
  amount: string;
  released: boolean;
}

export type StateEntryKind = "agent" | "owner" | "job" | "escrow" | "balance" | "unknown";

export interface StateEntry {
  /** Contract the entry belongs to ("identity" | "commerce"). */
  contract: "identity" | "commerce";
  /** Logical kind of the entry. */
  kind: StateEntryKind;
  /** Base64-encoded ledger key XDR (stable identifier). */
  key: string;
  /** Base64-encoded raw ScVal XDR of the stored value. */
  raw_value: string;
  /** Decoded native value. */
  value: unknown;
  /** Ledger sequence the entry was last modified in, if available. */
  last_modified_ledger?: number;
}

export interface StateManifest {
  generated_at: string;
  rpc_url: string;
  network_passphrase: string;
  latest_ledger: number;
  contracts: {
    identity?: string;
    commerce?: string;
  };
  entry_count: number;
  state_root: string;
  entries: StateEntry[];
}

// ---------------------------------------------------------------------------
// Storage key derivation
// ---------------------------------------------------------------------------

/**
 * Builds the ledger key for a contract data entry given a storage key ScVal.
 * Soroban persistent storage lives under the contract's instance, so we use
 * the contract data ledger key with durability = persistent.
 */
function buildContractDataKey(
  contractId: string,
  storageKey: xdr.ScVal,
): xdr.LedgerKey {
  const contract = new Contract(contractId);
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contract.address().toScAddress(),
      key: storageKey,
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

/**
 * Derives the set of persistent storage keys we expect to find for a contract.
 *
 * The contract layouts use enum DataKey variants:
 *   agent-identity:   Agent(agent_id), Owner(owner), AgentCount, OwnerCount
 *   agentic-commerce: Job(job_id), Escrow(job_id), Balance(token), JobCount
 *
 * Because we cannot enumerate dynamic ids without reading the contract, we
 * probe the well-known singleton keys and rely on getLedgerEntries returning
 * any entries whose keys we construct. For dynamic collections we additionally
 * probe a bounded id space (configurable via env) so operators can widen the
 * scan when needed.
 */
function deriveStorageKeys(
  contractId: string,
  kind: "identity" | "commerce",
): xdr.ScVal[] {
  const keys: xdr.ScVal[] = [];

  const enumKey = (variant: string, ...args: xdr.ScVal[]): xdr.ScVal =>
    xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol(variant),
      ...args,
    ]);

  if (kind === "identity") {
    // Singleton counters.
    keys.push(enumKey("AgentCount"));
    keys.push(enumKey("OwnerCount"));
  } else {
    keys.push(enumKey("JobCount"));
  }

  // Dynamic id space probe. Operators can widen this via env.
  const maxIds = Number(process.env.STATE_DUMP_MAX_IDS ?? 256);
  for (let i = 0; i < maxIds; i++) {
    const idVal = nativeToScVal(BigInt(i), { type: "u64" });
    if (kind === "identity") {
      keys.push(enumKey("Agent", idVal));
    } else {
      keys.push(enumKey("Job", idVal));
      keys.push(enumKey("Escrow", idVal));
    }
  }

  // Owner mappings and token balances cannot be enumerated without knowing
  // the address set; they are discovered from the decoded agent/job records
  // in a second pass (see discoverSecondaryKeys).
  void contractId;
  return keys;
}

/**
 * Given already-decoded primary entries, derive secondary keys (owner
 * mappings, token balances) that depend on values found in the primary pass.
 */
function discoverSecondaryKeys(
  entries: StateEntry[],
): { contract: "identity" | "commerce"; key: xdr.ScVal }[] {
  const secondary: { contract: "identity" | "commerce"; key: xdr.ScVal }[] = [];
  const seenOwners = new Set<string>();
  const seenTokens = new Set<string>();

  const enumKey = (variant: string, ...args: xdr.ScVal[]): xdr.ScVal =>
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant), ...args]);

  for (const entry of entries) {
    if (entry.kind === "agent") {
      const agent = entry.value as Agent;
      if (agent?.owner && !seenOwners.has(agent.owner)) {
        seenOwners.add(agent.owner);
        secondary.push({
          contract: "identity",
          key: enumKey("Owner", new Address(agent.owner).toScVal()),
        });
      }
    }
    if (entry.kind === "job") {
      const job = entry.value as Job;
      if (job?.client && !seenOwners.has(job.client)) {
        seenOwners.add(job.client);
        secondary.push({
          contract: "identity",
          key: enumKey("Owner", new Address(job.client).toScVal()),
        });
      }
    }
    if (entry.kind === "escrow") {
      const escrow = entry.value as EscrowBalance;
      if (escrow?.token && !seenTokens.has(escrow.token)) {
        seenTokens.add(escrow.token);
        secondary.push({
          contract: "commerce",
          key: enumKey("Balance", new Address(escrow.token).toScVal()),
        });
      }
    }
  }

  return secondary;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function classifyEntry(
  contract: "identity" | "commerce",
  storageKey: xdr.ScVal,
): StateEntryKind {
  try {
    const native = scValToNative(storageKey);
    const variant = Array.isArray(native) ? String(native[0]) : String(native);
    switch (variant) {
      case "Agent":
        return "agent";
      case "Owner":
        return "owner";
      case "Job":
        return "job";
      case "Escrow":
        return "escrow";
      case "Balance":
        return "balance";
      default:
        return "unknown";
    }
  } catch {
    void contract;
    return "unknown";
  }
}

function decodeValue(kind: StateEntryKind, raw: xdr.ScVal): unknown {
  const native = scValToNative(raw);
  switch (kind) {
    case "agent":
      return normalizeAgent(native);
    case "owner":
      return normalizeOwner(native);
    case "job":
      return normalizeJob(native);
    case "escrow":
    case "balance":
      return normalizeEscrow(native);
    default:
      return native;
  }
}

function normalizeAgent(native: any): Agent {
  return {
    agent_id: String(native?.agent_id ?? native?.id ?? ""),
    owner: String(native?.owner ?? ""),
    metadata_uri: String(native?.metadata_uri ?? native?.metadata ?? ""),
    registered_at: Number(native?.registered_at ?? native?.registeredAt ?? 0),
    active: Boolean(native?.active ?? true),
  };
}

function normalizeOwner(native: any): OwnerMapping {
  const ids = native?.agent_ids ?? native?.agents ?? native ?? [];
  return {
    owner: String(native?.owner ?? ""),
    agent_ids: Array.isArray(ids) ? ids.map((v: unknown) => String(v)) : [],
  };
}

function normalizeJob(native: any): Job {
  return {
    job_id: String(native?.job_id ?? native?.id ?? ""),
    client: String(native?.client ?? ""),
    provider: String(native?.provider ?? ""),
    amount: String(native?.amount ?? "0"),
    status: String(native?.status ?? "unknown"),
    created_at: Number(native?.created_at ?? native?.createdAt ?? 0),
  };
}

function normalizeEscrow(native: any): EscrowBalance {
  return {
    job_id: String(native?.job_id ?? native?.id ?? ""),
    token: String(native?.token ?? ""),
    amount: String(native?.amount ?? native?.balance ?? "0"),
    released: Boolean(native?.released ?? false),
  };
}

// ---------------------------------------------------------------------------
// RPC fetching
// ---------------------------------------------------------------------------

async function fetchEntries(
  server: Server,
  contractId: string,
  contract: "identity" | "commerce",
  storageKeys: xdr.ScVal[],
  batchSize: number,
): Promise<StateEntry[]> {
  const results: StateEntry[] = [];
  const ledgerKeys = storageKeys.map((k) => buildContractDataKey(contractId, k));

  for (let i = 0; i < ledgerKeys.length; i += batchSize) {
    const batch = ledgerKeys.slice(i, i + batchSize);
    const response = await server.getLedgerEntries(...batch);
    for (const entry of response.entries) {
      const decoded = decodeLedgerEntry(entry, contract);
      if (decoded) {
        results.push(decoded);
      }
    }
  }

  return results;
}

function decodeLedgerEntry(
  entry: Api.LedgerEntryResult,
  contract: "identity" | "commerce",
): StateEntry | null {
  try {
    const data = entry.val;
    if (data.switch().name !== "contractData") {
      return null;
    }
    const contractData = data.contractData();
    const storageKey = contractData.key();
    const kind = classifyEntry(contract, storageKey);
    const rawValue = contractData.val();
    const value = decodeValue(kind, rawValue);

    return {
      contract,
      kind,
      key: storageKey.toXDR("base64"),
      raw_value: rawValue.toXDR("base64"),
      value,
      last_modified_ledger: entry.lastModifiedLedgerSeq,
    };
  } catch (err) {
    throw new Error(
      `Failed to decode ledger entry: ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Canonicalization & hashing
// ---------------------------------------------------------------------------

/**
 * Deterministically serializes a value with sorted object keys so the state
 * root is stable across runs and platforms.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
  return `{${parts.join(",")}}`;
}

function sortEntries(entries: StateEntry[]): StateEntry[] {
  return [...entries].sort((a, b) => {
    if (a.contract !== b.contract) return a.contract < b.contract ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return 0;
  });
}

function computeStateRoot(entries: StateEntry[]): string {
  const canonical = canonicalize(
    entries.map((e) => ({
      contract: e.contract,
      kind: e.kind,
      key: e.key,
      raw_value: e.raw_value,
    })),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// Summary report
// ---------------------------------------------------------------------------

function buildSummary(manifest: StateManifest): string {
  const lines: string[] = [];
  lines.push("=== Contract State Snapshot Summary ===");
  lines.push(`Generated:      ${manifest.generated_at}`);
  lines.push(`RPC URL:        ${manifest.rpc_url}`);
  lines.push(`Latest ledger:  ${manifest.latest_ledger}`);
  lines.push(`Identity:       ${manifest.contracts.identity ?? "(not configured)"}`);
  lines.push(`Commerce:       ${manifest.contracts.commerce ?? "(not configured)"}`);
  lines.push(`Total entries:  ${manifest.entry_count}`);
  lines.push(`State root:     ${manifest.state_root}`);
  lines.push("");

  const agents = manifest.entries.filter((e) => e.kind === "agent");
  const owners = manifest.entries.filter((e) => e.kind === "owner");
  const jobs = manifest.entries.filter((e) => e.kind === "job");
  const escrows = manifest.entries.filter((e) => e.kind === "escrow");
  const balances = manifest.entries.filter((e) => e.kind === "balance");

  lines.push("--- Registered Agents ---");
  if (agents.length === 0) {
    lines.push("  (none)");
  } else {
    for (const e of agents) {
      const a = e.value as Agent;
      lines.push(
        `  agent_id=${a.agent_id} owner=${a.owner} active=${a.active} uri=${a.metadata_uri}`,
      );
    }
  }
  lines.push("");

  lines.push("--- Owner Mappings ---");
  if (owners.length === 0) {
    lines.push("  (none)");
  } else {
    for (const e of owners) {
      const o = e.value as OwnerMapping;
      lines.push(`  owner=${o.owner} agents=[${o.agent_ids.join(", ")}]`);
    }
  }
  lines.push("");

  lines.push("--- Jobs ---");
  if (jobs.length === 0) {
    lines.push("  (none)");
  } else {
    for (const e of jobs) {
      const j = e.value as Job;
      lines.push(
        `  job_id=${j.job_id} client=${j.client} provider=${j.provider} amount=${j.amount} status=${j.status}`,
      );
    }
  }
  lines.push("");

  lines.push("--- Active Escrows ---");
  const activeEscrows = escrows.filter((e) => !(e.value as EscrowBalance).released);
  if (activeEscrows.length === 0) {
    lines.push("  (none)");
  } else {
    for (const e of activeEscrows) {
      const s = e.value as EscrowBalance;
      lines.push(`  job_id=${s.job_id} token=${s.token} amount=${s.amount}`);
    }
  }
  lines.push("");

  lines.push("--- Token Balances ---");
  if (balances.length === 0) {
    lines.push("  (none)");
  } else {
    for (const e of balances) {
      const b = e.value as EscrowBalance;
      lines.push(`  token=${b.token} amount=${b.amount}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function validateContractId(id: string | undefined, label: string): void {
  if (!id) return;
  if (!StrKey.isValidContract(id)) {
    throw new Error(`Invalid ${label} contract id: ${id}`);
  }
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv);

  validateContractId(config.identityContractId, "identity");
  validateContractId(config.commerceContractId, "commerce");

  if (!config.identityContractId && !config.commerceContractId) {
    throw new Error(
      "No contract ids configured. Set IDENTITY_CONTRACT_ID and/or COMMERCE_CONTRACT_ID " +
        "or pass --identity / --commerce.",
    );
  }

  const networkPassphrase =
    config.rpcUrl.includes("testnet") || config.dryRun
      ? Networks.TESTNET
      : Networks.PUBLIC;

  let latestLedger = 0;
  let entries: StateEntry[] = [];

  if (config.dryRun) {
    // eslint-disable-next-line no-console
    console.log("[state-dump] dry-run mode: skipping RPC calls");
  } else {
    const server = new Server(config.rpcUrl);
    const health = await server.getLatestLedger();
    latestLedger = health.sequence;

    if (config.identityContractId) {
      const primaryKeys = deriveStorageKeys(config.identityContractId, "identity");
      const primary = await fetchEntries(
        server,
        config.identityContractId,
        "identity",
        primaryKeys,
        config.batchSize,
      );
      entries.push(...primary);

      const secondary = discoverSecondaryKeys(primary).filter(
        (s) => s.contract === "identity",
      );
      if (secondary.length > 0) {
        const secondaryEntries = await fetchEntries(
          server,
          config.identityContractId,
          "identity",
          secondary.map((s) => s.key),
          config.batchSize,
        );
        entries.push(...secondaryEntries);
      }
    }

    if (config.commerceContractId) {
      const primaryKeys = deriveStorageKeys(config.commerceContractId, "commerce");
      const primary = await fetchEntries(
        server,
        config.commerceContractId,
        "commerce",
        primaryKeys,
        config.batchSize,
      );
      entries.push(...primary);

      const secondary = discoverSecondaryKeys(primary).filter(
        (s) => s.contract === "commerce",
      );
      if (secondary.length > 0) {
        const secondaryEntries = await fetchEntries(
          server,
          config.commerceContractId,
          "commerce",
          secondary.map((s) => s.key),
          config.batchSize,
        );
        entries.push(...secondaryEntries);
      }
    }
  }

  // Deduplicate by (contract, key) in case of overlapping probes.
  const dedup = new Map<string, StateEntry>();
  for (const e of entries) {
    dedup.set(`${e.contract}:${e.key}`, e);
  }
  const sorted = sortEntries([...dedup.values()]);
  const stateRoot = computeStateRoot(sorted);

  const manifest: StateManifest = {
    generated_at: new Date().toISOString(),
    rpc_url: config.rpcUrl,
    network_passphrase: networkPassphrase,
    latest_ledger: latestLedger,
    contracts: {
      identity: config.identityContractId,
      commerce: config.commerceContractId,
    },
    entry_count: sorted.length,
    state_root: stateRoot,
    entries: sorted,
  };

  await fs.mkdir(config.outDir, { recursive: true });
  const manifestPath = path.join(config.outDir, "state-manifest.json");
  const summaryPath = path.join(config.outDir, "state-summary.txt");

  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  const summary = buildSummary(manifest);
  await fs.writeFile(summaryPath, summary, "utf8");

  // eslint-disable-next-line no-console
  console.log(summary);
  // eslint-disable-next-line no-console
  console.log(`Manifest written to: ${manifestPath}`);
  // eslint-disable-next-line no-console
  console.log(`Summary written to:  ${summaryPath}`);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[state-dump] ERROR: ${(err as Error).message}`);
  process.exit(1);
});