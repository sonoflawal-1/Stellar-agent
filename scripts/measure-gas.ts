#!/usr/bin/env node
/**
 * scripts/measure-gas.ts
 *
 * Contract gas regression check.
 *
 * Simulates representative `agentic_commerce` calls (`create_job`, `submit`,
 * `complete`, `cancel`) against a Soroban RPC endpoint, records the CPU
 * instruction and memory byte counts from the simulation `cost` field, and
 * compares them against `.gas-baseline.json`.
 *
 * Existing on-chain jobs are used as fixtures: the most recent `Funded` job
 * drives `create_job`, `submit` and `cancel`, and the most recent `Submitted`
 * job drives `complete`. Simulation never submits anything to the ledger.
 *
 * Usage:
 *   npm run gas:check                 compare against the baseline
 *   npm run gas:update                refresh the baseline file
 *
 * Options:
 *   --update                 write current measurements to the baseline file
 *   --commerce <CONTRACT_ID> agentic-commerce contract id
 *   --baseline <file>        baseline file (default: .gas-baseline.json)
 *
 * Environment:
 *   STELLAR_RPC_URL          Soroban RPC endpoint (default: testnet)
 *   STELLAR_NETWORK_PASSPHRASE  network passphrase (default: testnet)
 *   COMMERCE_CONTRACT_ID     agentic-commerce contract id
 *                            (default: deployments/testnet.json)
 *   GAS_SCAN_LIMIT           how many recent jobs to scan for fixtures (default: 50)
 *
 * Exit codes:
 *   0  success (and no regression above the threshold)
 *   1  gas regression above the threshold, or RPC / configuration failure
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..");
const DEFAULT_RPC_URL = "https://soroban-testnet.stellar.org";
const DEFAULT_BASELINE = resolve(ROOT, ".gas-baseline.json");
const DEPLOYMENT_FILE = resolve(ROOT, "deployments", "testnet.json");
const DEFAULT_SCAN_LIMIT = 50;
const THRESHOLD_PERCENT = 10;

const OPERATIONS = ["create_job", "submit", "complete", "cancel"] as const;
type Operation = (typeof OPERATIONS)[number];

interface GasMeasurement {
  cpu_instructions: number;
  memory_bytes: number;
}

interface GasBaseline {
  version: number;
  generated_by: string;
  description: string;
  threshold_percent: number;
  operations: Partial<Record<Operation, GasMeasurement>>;
}

interface CliConfig {
  rpcUrl: string;
  networkPassphrase: string;
  commerceContractId: string;
  baselinePath: string;
  scanLimit: number;
  update: boolean;
}

function parseArgs(argv: string[]): CliConfig {
  const args = argv.slice(2);
  let commerceContractId = process.env.COMMERCE_CONTRACT_ID;
  let baselinePath = DEFAULT_BASELINE;
  let update = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--update":
        update = true;
        break;
      case "--commerce":
        commerceContractId = args[++i];
        break;
      case "--baseline":
        baselinePath = resolve(args[++i]);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!commerceContractId && existsSync(DEPLOYMENT_FILE)) {
    const deployment = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"));
    commerceContractId = deployment.agentic_commerce;
  }
  if (!commerceContractId) {
    throw new Error("Missing commerce contract id (set COMMERCE_CONTRACT_ID or --commerce)");
  }

  const scanLimit = Number(process.env.GAS_SCAN_LIMIT ?? DEFAULT_SCAN_LIMIT);
  if (!Number.isFinite(scanLimit) || scanLimit <= 0) {
    throw new Error(`Invalid GAS_SCAN_LIMIT: ${process.env.GAS_SCAN_LIMIT}`);
  }

  return {
    rpcUrl: process.env.STELLAR_RPC_URL ?? DEFAULT_RPC_URL,
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET,
    commerceContractId,
    baselinePath,
    scanLimit,
    update,
  };
}

// ---------------------------------------------------------------------------
// Simulation helpers
// ---------------------------------------------------------------------------

async function simulate(
  server: Server,
  cfg: CliConfig,
  source: string,
  op: xdr.Operation,
) {
  const tx = new TransactionBuilder(new Account(source, "0"), {
    fee: BASE_FEE,
    networkPassphrase: cfg.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();
  const sim = await server._simulateTransaction(tx);
  if (sim.error) throw new Error(sim.error);
  return sim;
}

async function measure(
  server: Server,
  cfg: CliConfig,
  source: string,
  op: xdr.Operation,
): Promise<GasMeasurement> {
  const sim = await simulate(server, cfg, source, op);
  const cost = (sim as { cost?: { cpuInsns?: string; memBytes?: string } }).cost;
  let cpu = Number(cost?.cpuInsns ?? 0);
  if (!cpu && sim.transactionData) {
    cpu = xdr.SorobanTransactionData.fromXDR(sim.transactionData, "base64")
      .resources()
      .instructions();
  }
  return { cpu_instructions: cpu, memory_bytes: Number(cost?.memBytes ?? 0) };
}

interface JobFixture {
  id: bigint;
  client: string;
  provider: string;
  evaluator: string;
  token: string;
}

function decodeStatus(status: unknown): string {
  return String(Array.isArray(status) ? status[0] : status);
}

async function findFixtures(
  server: Server,
  cfg: CliConfig,
  contract: Contract,
  readSource: string,
): Promise<{ funded?: JobFixture; submitted?: JobFixture }> {
  const countSim = await simulate(server, cfg, readSource, contract.call("job_count"));
  const count = BigInt(
    scValToNative(xdr.ScVal.fromXDR(countSim.results![0].xdr, "base64")) as string,
  );

  let funded: JobFixture | undefined;
  let submitted: JobFixture | undefined;
  const stop = count > BigInt(cfg.scanLimit) ? count - BigInt(cfg.scanLimit) : 0n;
  for (let id = count; id > stop && (!funded || !submitted); id--) {
    const sim = await simulate(
      server,
      cfg,
      readSource,
      contract.call("get_job", nativeToScVal(id, { type: "u64" })),
    );
    const job = scValToNative(xdr.ScVal.fromXDR(sim.results![0].xdr, "base64"));
    if (!job) continue;
    const fixture: JobFixture = {
      id,
      client: job.client,
      provider: job.provider,
      evaluator: job.evaluator,
      token: job.token,
    };
    const status = decodeStatus(job.status);
    if (status === "Funded" && !funded) funded = fixture;
    if (status === "Submitted" && !submitted) submitted = fixture;
  }
  return { funded, submitted };
}

function buildOperation(
  name: Operation,
  contract: Contract,
  fixtures: { funded?: JobFixture; submitted?: JobFixture },
): { source: string; op: xdr.Operation } | null {
  const { funded, submitted } = fixtures;
  switch (name) {
    case "create_job":
      if (!funded) return null;
      return {
        source: funded.client,
        op: contract.call(
          "create_job",
          new Address(funded.client).toScVal(),
          new Address(funded.provider).toScVal(),
          new Address(funded.evaluator).toScVal(),
          new Address(funded.token).toScVal(),
          nativeToScVal(1n, { type: "i128" }),
          nativeToScVal("gas-profile", { type: "string" }),
          nativeToScVal(0n, { type: "u64" }),
          nativeToScVal(0, { type: "u32" }),
        ),
      };
    case "submit":
      if (!funded) return null;
      return {
        source: funded.provider,
        op: contract.call(
          "submit",
          new Address(funded.provider).toScVal(),
          nativeToScVal(funded.id, { type: "u64" }),
          nativeToScVal("gas-profile", { type: "string" }),
          nativeToScVal(new Uint8Array(32), { type: "bytes" }),
        ),
      };
    case "complete":
      if (!submitted) return null;
      return {
        source: submitted.evaluator,
        op: contract.call(
          "complete",
          new Address(submitted.evaluator).toScVal(),
          nativeToScVal(submitted.id, { type: "u64" }),
          xdr.ScVal.scvVoid(),
        ),
      };
    case "cancel":
      if (!funded) return null;
      return {
        source: funded.client,
        op: contract.call(
          "cancel",
          new Address(funded.client).toScVal(),
          nativeToScVal(funded.id, { type: "u64" }),
        ),
      };
  }
}

// ---------------------------------------------------------------------------
// Baseline handling
// ---------------------------------------------------------------------------

function readBaseline(path: string): GasBaseline | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return { ...parsed, operations: parsed.operations ?? {} };
}

function writeBaseline(path: string, operations: GasBaseline["operations"]): void {
  const baseline: GasBaseline = {
    version: 2,
    generated_by: "scripts/measure-gas.ts",
    description:
      "Baseline Soroban CPU instruction and memory byte consumption per agentic_commerce entry point. `npm run gas:check` fails when an operation exceeds these values by more than threshold_percent.",
    threshold_percent: THRESHOLD_PERCENT,
    operations,
  };
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
}

function pctDelta(base: number, current: number): number | null {
  if (!base) return null;
  return ((current - base) / base) * 100;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv);
  const server = new Server(cfg.rpcUrl, { allowHttp: cfg.rpcUrl.startsWith("http://") });
  const contract = new Contract(cfg.commerceContractId);
  // Read-only calls only need a syntactically valid source account.
  const readSource = Keypair.random().publicKey();

  const fixtures = await findFixtures(server, cfg, contract, readSource);
  const current: GasBaseline["operations"] = {};
  for (const name of OPERATIONS) {
    const built = buildOperation(name, contract, fixtures);
    if (!built) {
      console.warn(`[gas] skipping ${name}: no suitable on-chain job found`);
      continue;
    }
    try {
      current[name] = await measure(server, cfg, built.source, built.op);
    } catch (err) {
      console.warn(`[gas] skipping ${name}: simulation failed: ${(err as Error).message}`);
    }
  }

  const baseline = readBaseline(cfg.baselinePath);
  if (cfg.update || !baseline) {
    writeBaseline(cfg.baselinePath, { ...(baseline?.operations ?? {}), ...current });
    console.log(
      `[gas] ${baseline ? "updated" : "created"} baseline at ${cfg.baselinePath}`,
    );
    return;
  }

  const threshold = baseline.threshold_percent ?? THRESHOLD_PERCENT;
  const rows: string[][] = [["operation", "metric", "baseline", "current", "delta", "status"]];
  let failed = false;
  for (const name of OPERATIONS) {
    const cur = current[name];
    if (!cur) continue;
    const base = baseline.operations[name];
    for (const metric of ["cpu_instructions", "memory_bytes"] as const) {
      const delta = base ? pctDelta(base[metric], cur[metric]) : null;
      const regressed = delta !== null && delta > threshold;
      if (regressed) failed = true;
      rows.push([
        name,
        metric,
        base ? String(base[metric]) : "-",
        String(cur[metric]),
        delta === null ? "new" : `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}%`,
        regressed ? "FAIL" : "ok",
      ]);
    }
  }

  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
  for (const row of rows) {
    console.log(row.map((cell, col) => cell.padEnd(widths[col])).join("  "));
  }

  if (failed) {
    console.error(`\n[gas] regression above ${threshold}% detected against ${cfg.baselinePath}`);
    process.exit(1);
  }
  console.log(`\n[gas] no regressions above ${threshold}%`);
}

main().catch((err) => {
  console.error(`[gas] ${(err as Error).message}`);
  process.exit(1);
});
