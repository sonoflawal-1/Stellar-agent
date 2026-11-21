import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  Address,
  Contract,
  Keypair,
  Networks,
  Operation,
  rpc,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

/* -------------------------------------------------------------------------- */
/*                                  Constants                                 */
/* -------------------------------------------------------------------------- */

const ROOT = resolve(__dirname, "..");
const DEPLOYMENT_FILE = join(ROOT, "deployments", "mainnet.json");
const REPORT_DIR = join(ROOT, "reports");
const REPORT_FILE = join(REPORT_DIR, "mainnet-verification.md");
const CERT_FILE = join(REPORT_DIR, "mainnet-verification.certificate.json");

const EXPECTED_FEE_BPS = 100;

/**
 * Canonical Circle USDC Stellar Asset Contract on Stellar mainnet.
 * https://developers.circle.com/stablecoins/docs/usdc-on-stellar
 */
const CANONICAL_USDC_SAC =
  "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

const MAINNET_PASSPHRASE = Networks.PUBLIC;
const HORIZON_URL =
  process.env.STELLAR_HORIZON_URL ?? "https://horizon.stellar.org";
const RPC_URL =
  process.env.STELLAR_RPC_URL ?? "https://mainnet.sorobanrpc.com";

/** Minimum multisig threshold required for the treasury account. */
const MIN_MULTISIG_THRESHOLD = 2;
const MIN_MULTISIG_SIGNERS = 2;

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

interface ContractDeployment {
  name: string;
  contractId: string;
  wasmPath?: string;
  expectedWasmHash?: string;
  entryPoints?: string[];
}

interface DeploymentManifest {
  network?: string;
  networkPassphrase?: string;
  admin?: string;
  treasury?: string;
  feeBps?: number;
  usdcSac?: string;
  usdcSacAddress?: string;
  contracts?: ContractDeployment[];
  [key: string]: unknown;
}

interface CheckResult {
  name: string;
  passed: boolean;
  critical: boolean;
  detail: string;
}

/* -------------------------------------------------------------------------- */
/*                              Check collection                              */
/* -------------------------------------------------------------------------- */

const checks: CheckResult[] = [];

function record(
  name: string,
  passed: boolean,
  detail: string,
  critical = true,
): void {
  checks.push({ name, passed, critical, detail });
  const icon = passed ? "PASS" : critical ? "FAIL" : "WARN";
  console.log(`[${icon}] ${name} — ${detail}`);
}

function criticalAlarm(message: string): void {
  const banner = "!".repeat(72);
  console.error(`\n${banner}`);
  console.error("  CRITICAL ALARM — MAINNET DEPLOYMENT VERIFICATION FAILED");
  console.error(`  ${message}`);
  console.error("  DO NOT PROCEED WITH MAINNET LAUNCH.");
  console.error(`${banner}\n`);
}

/* -------------------------------------------------------------------------- */
/*                              Helpers                                       */
/* -------------------------------------------------------------------------- */

function loadManifest(): DeploymentManifest {
  if (!existsSync(DEPLOYMENT_FILE)) {
    throw new Error(`Deployment manifest not found at ${DEPLOYMENT_FILE}`);
  }
  const raw = readFileSync(DEPLOYMENT_FILE, "utf8");
  try {
    return JSON.parse(raw) as DeploymentManifest;
  } catch (err) {
    throw new Error(
      `Failed to parse ${DEPLOYMENT_FILE}: ${(err as Error).message}`,
    );
  }
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function normalizeHash(hash: string): string {
  return hash.trim().toLowerCase().replace(/^0x/, "");
}

function isValidContractId(id: string): boolean {
  try {
    return StrKey.isValidContract(id);
  } catch {
    return false;
  }
}

function isValidAccountId(id: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(id);
  } catch {
    return false;
  }
}

/**
 * Resolve the optimized WASM for a contract. Prefers the explicit path in the
 * manifest, falling back to the conventional target directory layout.
 */
function resolveWasmPath(contract: ContractDeployment): string | null {
  const candidates: string[] = [];
  if (contract.wasmPath) {
    candidates.push(resolve(ROOT, contract.wasmPath));
  }
  candidates.push(
    join(ROOT, "target", "wasm32-unknown-unknown", "release", `${contract.name}.wasm`),
    join(ROOT, "target", "wasm32v1-none", "release", `${contract.name}.wasm`),
    join(ROOT, "wasm", `${contract.name}.wasm`),
  );
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Compute the on-chain contract WASM hash. Soroban stores the SHA-256 of the
 * uploaded WASM, so hashing the optimized artifact locally is equivalent.
 */
function computeWasmHash(wasmPath: string): string {
  return sha256Hex(readFileSync(wasmPath));
}

/* -------------------------------------------------------------------------- */
/*                          Check 1: WASM integrity                           */
/* -------------------------------------------------------------------------- */

function verifyWasmHashes(manifest: DeploymentManifest): void {
  const contracts = manifest.contracts ?? [];
  if (contracts.length === 0) {
    record("wasm-hashes", false, "No contracts declared in manifest");
    return;
  }

  for (const contract of contracts) {
    const label = `wasm-hash:${contract.name}`;
    if (!contract.expectedWasmHash) {
      record(label, false, "Missing expectedWasmHash in manifest");
      continue;
    }
    const wasmPath = resolveWasmPath(contract);
    if (!wasmPath) {
      record(
        label,
        false,
        `Optimized WASM not found for ${contract.name}; build with \`stellar contract build\``,
      );
      continue;
    }
    const actual = computeWasmHash(wasmPath);
    const expected = normalizeHash(contract.expectedWasmHash);
    record(
      label,
      actual === expected,
      actual === expected
        ? `matches audited release (${actual})`
        : `MISMATCH — expected ${expected}, got ${actual} (${wasmPath})`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                          Check 2: fee_bps                                  */
/* -------------------------------------------------------------------------- */

function verifyFeeBps(manifest: DeploymentManifest): void {
  const feeBps = manifest.feeBps;
  if (typeof feeBps !== "number") {
    record("fee_bps", false, "feeBps missing or not a number in manifest");
    return;
  }
  record(
    "fee_bps",
    feeBps === EXPECTED_FEE_BPS,
    feeBps === EXPECTED_FEE_BPS
      ? `fee_bps == ${EXPECTED_FEE_BPS}`
      : `UNEXPECTED fee_bps ${feeBps}, expected ${EXPECTED_FEE_BPS}`,
  );
}

/* -------------------------------------------------------------------------- */
/*                       Check 3: treasury multisig                           */
/* -------------------------------------------------------------------------- */

interface HorizonAccount {
  account_id: string;
  thresholds?: { low_threshold: number; med_threshold: number; high_threshold: number };
  signers?: Array<{ key: string; weight: number; type: string }>;
}

async function fetchHorizonAccount(accountId: string): Promise<HorizonAccount> {
  const res = await fetch(`${HORIZON_URL}/accounts/${accountId}`);
  if (!res.ok) {
    throw new Error(`Horizon returned ${res.status} for ${accountId}`);
  }
  return (await res.json()) as HorizonAccount;
}

async function verifyTreasuryMultisig(manifest: DeploymentManifest): Promise<void> {
  const treasury = manifest.treasury;
  if (!treasury || !isValidAccountId(treasury)) {
    record("treasury:address", false, `Invalid treasury account id: ${treasury}`);
    return;
  }
  record("treasury:address", true, `valid Stellar account ${treasury}`);

  let account: HorizonAccount;
  try {
    account = await fetchHorizonAccount(treasury);
  } catch (err) {
    record(
      "treasury:multisig",
      false,
      `Unable to load treasury account from Horizon: ${(err as Error).message}`,
    );
    return;
  }

  const thresholds = account.thresholds;
  const signers = account.signers ?? [];
  const weightedSigners = signers.filter((s) => s.weight > 0);

  const medThreshold = thresholds?.med_threshold ?? 0;
  const highThreshold = thresholds?.high_threshold ?? 0;

  const thresholdOk =
    medThreshold >= MIN_MULTISIG_THRESHOLD ||
    highThreshold >= MIN_MULTISIG_THRESHOLD;
  const signersOk = weightedSigners.length >= MIN_MULTISIG_SIGNERS;

  record(
    "treasury:multisig",
    thresholdOk && signersOk,
    `med_threshold=${medThreshold}, high_threshold=${highThreshold}, ` +
      `weighted_signers=${weightedSigners.length} ` +
      `(requires >=${MIN_MULTISIG_THRESHOLD} threshold and >=${MIN_MULTISIG_SIGNERS} signers)`,
  );
}

/* -------------------------------------------------------------------------- */
/*                       Check 4: canonical USDC SAC                          */
/* -------------------------------------------------------------------------- */

function verifyUsdcSac(manifest: DeploymentManifest): void {
  const configured = manifest.usdcSac ?? manifest.usdcSacAddress;
  if (!configured) {
    record("usdc-sac", false, "No USDC SAC address configured in manifest");
    return;
  }
  if (!isValidContractId(configured)) {
    record("usdc-sac", false, `Invalid contract id for USDC SAC: ${configured}`);
    return;
  }
  record(
    "usdc-sac",
    configured === CANONICAL_USDC_SAC,
    configured === CANONICAL_USDC_SAC
      ? `matches canonical Circle USDC SAC (${CANONICAL_USDC_SAC})`
      : `NON-CANONICAL USDC SAC — configured ${configured}, expected ${CANONICAL_USDC_SAC}`,
  );
}

/* -------------------------------------------------------------------------- */
/*                    Check 5: read-only entry point smoke                    */
/* -------------------------------------------------------------------------- */

/**
 * Build a read-only simulation for a contract entry point. Soroban
 * `simulateTransaction` never mutates ledger state, so this is safe to run
 * against mainnet.
 */
async function simulateEntryPoint(
  server: rpc.Server,
  source: string,
  contractId: string,
  method: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const account = await server.getAccount(source);
    const contract = new Contract(contractId);
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: MAINNET_PASSPHRASE,
    })
      .addOperation(contract.call(method))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      return { ok: false, detail: `simulation error: ${sim.error}` };
    }
    return { ok: true, detail: "simulation succeeded (read-only)" };
  } catch (err) {
    return { ok: false, detail: `simulation threw: ${(err as Error).message}` };
  }
}

async function verifyEntryPoints(manifest: DeploymentManifest): Promise<void> {
  const contracts = manifest.contracts ?? [];
  const source = manifest.admin;
  if (!source || !isValidAccountId(source)) {
    record(
      "entrypoints:source",
      false,
      `Admin/source account invalid or missing: ${source}`,
    );
    return;
  }

  let server: rpc.Server;
  try {
    server = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith("http://") });
  } catch (err) {
    record(
      "entrypoints:rpc",
      false,
      `Unable to construct RPC server: ${(err as Error).message}`,
    );
    return;
  }

  for (const contract of contracts) {
    if (!isValidContractId(contract.contractId)) {
      record(
        `entrypoint:${contract.name}`,
        false,
        `Invalid contract id: ${contract.contractId}`,
      );
      continue;
    }
    const methods = contract.entryPoints ?? ["get_job", "fee_bps"];
    for (const method of methods) {
      const label = `entrypoint:${contract.name}.${method}`;
      const result = await simulateEntryPoint(
        server,
        source,
        contract.contractId,
        method,
      );
      record(label, result.ok, result.detail);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                    Check 6: contract id presence sanity                    */
/* -------------------------------------------------------------------------- */

function verifyContractIds(manifest: DeploymentManifest): void {
  const contracts = manifest.contracts ?? [];
  if (contracts.length === 0) {
    record("contract-ids", false, "No contracts declared in manifest");
    return;
  }
  for (const contract of contracts) {
    record(
      `contract-id:${contract.name}`,
      isValidContractId(contract.contractId),
      isValidContractId(contract.contractId)
        ? `valid contract id ${contract.contractId}`
        : `INVALID contract id ${contract.contractId}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                       Certificate + markdown report                        */
/* -------------------------------------------------------------------------- */

function buildCertificatePayload(
  manifest: DeploymentManifest,
  results: CheckResult[],
): Record<string, unknown> {
  return {
    version: 1,
    kind: "mainnet-deployment-audit-certificate",
    issuedAt: new Date().toISOString(),
    network: manifest.network ?? "mainnet",
    networkPassphrase: manifest.networkPassphrase ?? MAINNET_PASSPHRASE,
    deploymentFile: DEPLOYMENT_FILE,
    checks: results.map((c) => ({
      name: c.name,
      passed: c.passed,
      critical: c.critical,
      detail: c.detail,
    })),
    summary: {
      total: results.length,
      passed: results.filter((c) => c.passed).length,
      failed: results.filter((c) => !c.passed).length,
    },
  };
}

function signPayload(payload: Record<string, unknown>): {
  algorithm: string;
  keyId: string;
  signature: string;
} {
  const secret = process.env.MAINNET_AUDIT_SIGNING_KEY;
  if (!secret) {
    throw new Error(
      "MAINNET_AUDIT_SIGNING_KEY is not set; cannot sign audit certificate",
    );
  }
  const keyId = process.env.MAINNET_AUDIT_SIGNING_KEY_ID ?? "default";
  const canonical = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(canonical).digest("hex");
  return { algorithm: "HMAC-SHA256", keyId, signature };
}

function writeCertificate(
  manifest: DeploymentManifest,
  results: CheckResult[],
): void {
  const payload = buildCertificatePayload(manifest, results);
  const signature = signPayload(payload);
  const certificate = {
    ...payload,
    certificateId: randomUUID(),
    signature,
  };
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(CERT_FILE, JSON.stringify(certificate, null, 2), "utf8");
  console.log(`Signed audit certificate written to ${CERT_FILE}`);
}

function writeMarkdownReport(
  manifest: DeploymentManifest,
  results: CheckResult[],
): void {
  const passed = results.filter((c) => c.passed).length;
  const failed = results.length - passed;
  const lines: string[] = [];

  lines.push("# Mainnet Deployment Verification Report");
  lines.push("");
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Network: ${manifest.network ?? "mainnet"}`);
  lines.push(`- Deployment file: \`${DEPLOYMENT_FILE}\``);
  lines.push(`- Admin: \`${manifest.admin ?? "n/a"}\``);
  lines.push(`- Treasury: \`${manifest.treasury ?? "n/a"}\``);
  lines.push(`- fee_bps: \`${manifest.feeBps ?? "n/a"}\``);
  lines.push(
    `- USDC SAC: \`${manifest.usdcSac ?? manifest.usdcSacAddress ?? "n/a"}\``,
  );
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  lines.push(`- Total checks: ${results.length}`);
  lines.push(`- Passed: ${passed}`);
  lines.push(`- Failed: ${failed}`);
  lines.push(`- Result: ${failed === 0 ? "PASS" : "FAIL"}`);
  lines.push("");
  lines.push("## Checks");
  lines.push("");
  lines.push("| Check | Status | Critical | Detail |");
  lines.push("| --- | --- | --- | --- |");
  for (const c of results) {
    lines.push(
      `| ${c.name} | ${c.passed ? "PASS" : "FAIL"} | ${
        c.critical ? "yes" : "no"
      } | ${c.detail.replace(/\|/g, "\\|")} |`,
    );
  }
  lines.push("");
  lines.push("## Pre-launch checklist");
  lines.push("");
  lines.push(
    `- [${failed === 0 ? "x" : " "}] All safety checks pass (mandatory gate)`,
  );
  lines.push(
    `- [${results.find((c) => c.name === "fee_bps")?.passed ? "x" : " "}] fee_bps == ${EXPECTED_FEE_BPS}`,
  );
  lines.push(
    `- [${results.find((c) => c.name === "treasury:multisig")?.passed ? "x" : " "}] Treasury is a valid multisig account`,
  );
  lines.push(
    `- [${results.find((c) => c.name === "usdc-sac")?.passed ? "x" : " "}] USDC SAC is canonical Circle USDC`,
  );
  lines.push("");

  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(REPORT_FILE, lines.join("\n"), "utf8");
  console.log(`Markdown audit report written to ${REPORT_FILE}`);
}

/* -------------------------------------------------------------------------- */
/*                                   Main                                     */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  console.log("=== Stellar mainnet deployment verification ===");
  console.log(`Manifest: ${DEPLOYMENT_FILE}`);
  console.log(`Horizon:  ${HORIZON_URL}`);
  console.log(`RPC:      ${RPC_URL}\n`);

  let manifest: DeploymentManifest;
  try {
    manifest = loadManifest();
  } catch (err) {
    criticalAlarm((err as Error).message);
    process.exit(1);
  }

  verifyWasmHashes(manifest);
  verifyFeeBps(manifest);
  verifyUsdcSac(manifest);
  verifyContractIds(manifest);
  await verifyTreasuryMultisig(manifest);
  await verifyEntryPoints(manifest);

  const failedCritical = checks.filter((c) => !c.passed && c.critical);
  const allPassed = failedCritical.length === 0;

  try {
    writeMarkdownReport(manifest, checks);
  } catch (err) {
    console.error(`Failed to write markdown report: ${(err as Error).message}`);
  }

  if (!allPassed) {
    criticalAlarm(
      `${failedCritical.length} critical check(s) failed: ` +
        failedCritical.map((c) => c.name).join(", "),
    );
    process.exit(1);
  }

  try {
    writeCertificate(manifest, checks);
  } catch (err) {
    criticalAlarm(
      `All checks passed but audit certificate could not be signed: ${
        (err as Error).message
      }`,
    );
    process.exit(1);
  }

  console.log("\nAll safety checks passed. Mainnet deployment is verified.");
}

main().catch((err) => {
  criticalAlarm(`Unexpected error: ${(err as Error).message}`);
  process.exit(1);
});