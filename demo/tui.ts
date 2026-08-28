import "dotenv/config";
import fs from "node:fs";
import blessed from "blessed";
import express from "express";
import cors from "cors";
import {
  Keypair,
  Contract,
  Account,
  TransactionBuilder,
  BASE_FEE,
  Address,
  scValToNative,
  rpc,
} from "@stellar/stellar-sdk";
import { IdentityClient, CommerceClient, TESTNET, type MarcConfig } from "marc-stellar-sdk";

const cfg: MarcConfig = {
  rpcUrl: process.env.STELLAR_RPC_URL ?? TESTNET.rpcUrl,
  networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? TESTNET.networkPassphrase,
  identityContract: process.env.AGENT_IDENTITY_CONTRACT || TESTNET.identityContract,
  commerceContract: process.env.AGENTIC_COMMERCE_CONTRACT || TESTNET.commerceContract,
  usdcToken: process.env.USDC_TOKEN_CONTRACT || TESTNET.usdcToken,
};

const BASE_PORT = 4410;
const NUM_SELLERS = 4;
const NUM_BUYERS = 5;
const BUDGET = BigInt(10_000_000);
const ENV_PATH = new URL(".env", import.meta.url).pathname;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ACTIVE_STATUSES = [
  "registering",
  "creating job",
  "submitting",
  "completing",
  "calling API",
  "funding",
  "init",
];

// ── Terminal width guard ───────────────────────────────────────────────────────
// Blessed layouts are expressed as percentages so they reflow, but some label
// and content strings still need a minimum width to render without wrapping
// into illegible fragments.  80 columns is a safe floor; below that we warn
// the user and continue in a degraded (plain-log) mode rather than crashing.

const MIN_COLS = 80;
const MIN_ROWS = 24;

function terminalTooSmall(): boolean {
  const cols = process.stdout.columns ?? 0;
  const rows = process.stdout.rows ?? 0;
  return cols < MIN_COLS || rows < MIN_ROWS;
}

// Plain-text fallback used when the terminal is too small for the TUI.
let usePlainLog = terminalTooSmall();

if (usePlainLog) {
  const cols = process.stdout.columns ?? "?";
  const rows = process.stdout.rows ?? "?";
  console.warn(
    `\n⚠  Terminal too small (${cols}×${rows}).  ` +
      `Minimum required: ${MIN_COLS}×${MIN_ROWS}.\n` +
      `Falling back to plain-text log output.  Resize your terminal and restart for the full TUI.\n`,
  );
}

// Re-check on SIGWINCH so that a resize mid-run is caught.  We only switch from
// TUI → plain, not the other way, to avoid tearing up the blessed screen.
process.stdout.on("resize", () => {
  if (!usePlainLog && terminalTooSmall()) {
    usePlainLog = true;
    try {
      screen.destroy();
    } catch {
      /* ignore */
    }
    console.warn(
      `\n⚠  Terminal resized below minimum (${process.stdout.columns}×${process.stdout.rows}).  ` +
        `Switching to plain-text output.\n`,
    );
  }
});

// ── TUI ───────────────────────────────────────────────────────────────────────

let screen: blessed.Widgets.Screen | null = null;
let sellersBox: blessed.Widgets.BoxElement | null = null;
let buyersBox: blessed.Widgets.BoxElement | null = null;
let treasuryBox: blessed.Widgets.BoxElement | null = null;
let feedBox: blessed.Widgets.Log | null = null;

// All widths/heights are percentages so blessed handles reflow automatically.
const sellersBox = blessed.box({
  top: 0,
  left: 0,
  width: "50%",
  height: "45%",
  label: " SELLERS ",
  border: { type: "line" },
  tags: true,
  style: { border: { fg: "cyan" }, label: { fg: "cyan", bold: true } },
});
const buyersBox = blessed.box({
  top: 0,
  left: "50%",
  width: "50%",
  height: "45%",
  label: " BUYERS ",
  border: { type: "line" },
  tags: true,
  style: { border: { fg: "magenta" }, label: { fg: "magenta", bold: true } },
});
const treasuryBox = blessed.box({
  top: "45%",
  left: 0,
  width: "100%",
  height: "10%",
  label: " TREASURY ",
  border: { type: "line" },
  tags: true,
  style: { border: { fg: "green" }, label: { fg: "green", bold: true } },
});
const feedBox = blessed.log({
  top: "55%",
  left: 0,
  width: "100%",
  height: "45%",
  label: " ACTIVITY FEED ",
  border: { type: "line" },
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  style: { border: { fg: "yellow" }, label: { fg: "yellow", bold: true } },
});

screen.append(sellersBox);
screen.append(buyersBox);
screen.append(treasuryBox);
screen.append(feedBox);
screen.key(["q", "C-c"], () => process.exit(0));

// ── State ─────────────────────────────────────────────────────────────────────

type AgentState = {
  label: string;
  kp: Keypair;
  agentId?: bigint;
  status: string;
  jobs: number;
  usdc: string;
};

function loadOrGenerate(envKey: string): Keypair {
  const existing = process.env[envKey];
  if (existing) return Keypair.fromSecret(existing);
  const kp = Keypair.random();
  fs.appendFileSync(ENV_PATH, `\n${envKey}=${kp.secret()}`);
  process.env[envKey] = kp.secret();
  return kp;
}

const sellers: AgentState[] = Array.from({ length: NUM_SELLERS }, (_, i) => ({
  label: `seller-${i + 1}`,
  kp: loadOrGenerate(`SELLER_SECRET_${i + 1}`),
  status: "init…",
  jobs: 0,
  usdc: "0.00",
}));

const buyers: AgentState[] = Array.from({ length: NUM_BUYERS }, (_, i) => {
  const secret =
    process.env[`BUYER_SECRET_${i + 1}`] ?? (i === 0 ? process.env.BUYER_SECRET : undefined);
  const kp = secret ? Keypair.fromSecret(secret) : loadOrGenerate(`BUYER_SECRET_${i + 1}`);
  return { label: `buyer-${i + 1}`, kp, status: "init…", jobs: 0, usdc: "0.00" };
});

// ── Render ────────────────────────────────────────────────────────────────────

let spinFrame = 0;
setInterval(() => {
  spinFrame = (spinFrame + 1) % SPINNER.length;
  render();
}, 120);

function isActive(status: string) {
  return ACTIVE_STATUSES.some((s) => status.startsWith(s));
}

let treasuryUsdc = "0.00";

/**
 * Truncate a status string to fit the available column budget.
 * Each agent row has fixed overhead for label, agentId, spinner, job count,
 * and USDC balance.  On narrow terminals the status field is clipped.
 */
function fitStatus(status: string, maxLen = 20): string {
  const cols = process.stdout.columns ?? MIN_COLS;
  // Scale max length proportionally when terminal is narrower than MIN_COLS.
  const adjusted = Math.max(8, Math.floor(maxLen * (cols / MIN_COLS)));
  return status.length > adjusted ? status.slice(0, adjusted - 1) + "…" : status.padEnd(adjusted);
}

function render() {
  if (usePlainLog) return; // plain-text path handled by feed()
  const spin = SPINNER[spinFrame];
  sellersBox.setContent(
    sellers
      .map(
        (s) =>
          `{cyan-fg}${s.label}{/cyan-fg}  agent#${s.agentId ?? "?"}  ${isActive(s.status) ? spin + " " : "  "}${fitStatus(s.status)}  jobs:${s.jobs}  USDC:${s.usdc}`,
      )
      .join("\n"),
  );
  buyersBox.setContent(
    buyers
      .map(
        (b) =>
          `{magenta-fg}${b.label}{/magenta-fg}  agent#${b.agentId ?? "?"}  ${isActive(b.status) ? spin + " " : "  "}${fitStatus(b.status)}  jobs:${b.jobs}  USDC:${b.usdc}`,
      )
      .join("\n"),
  );
  treasuryBox.setContent(
    `{green-fg}${TESTNET.deployer}{/green-fg}  USDC: {bold}${treasuryUsdc}{/bold}`,
  );
  screen.render();
}

function feed(msg: string) {
  const ts = new Date().toTimeString().slice(0, 8);
  // Strip blessed tags for plain-text output
  const plain = msg.replace(/\{[^}]+\}/g, "");
  if (usePlainLog || !screen || !feedBox) {
    console.log(`[${ts}] ${plain}`);
    return;
  }
  try {
    const cols = process.stdout.columns ?? MIN_COLS;
    const maxLen = Math.max(40, cols - 12); // account for timestamp prefix
    const truncated = msg.length > maxLen ? msg.slice(0, maxLen - 1) + "…" : msg;
    feedBox.log(`{gray-fg}[${ts}]{/gray-fg} ${truncated}`);
    screen.render();
  } catch {
    usePlainLog = true;
    console.log(`[${ts}] ${plain}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function friendlyError(err: unknown): string {
  const msg = (err as Error).message ?? String(err);
  if (msg.includes("trustline entry is missing"))
    return "no USDC trustline — fund via faucet.circle.com";
  if (msg.includes("resulting balance is not within")) return "insufficient USDC balance";
  if (msg.includes("Account not found")) return "account not on-chain yet";
  return msg.split("\n")[0].slice(0, 80);
}

async function fundXlm(pubkey: string) {
  const server = new rpc.Server(cfg.rpcUrl, { allowHttp: false });
  try {
    await server.getAccount(pubkey);
    return;
  } catch {
    /* not funded yet */
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`https://friendbot.stellar.org?addr=${pubkey}`);
      if (!res.ok) throw new Error(`${res.statusText}: ${await res.text()}`);
      break;
    } catch (err) {
      if (attempt === 3) throw new Error(`Friendbot failed: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  for (let i = 0; i < 30; i++) {
    try {
      await server.getAccount(pubkey);
      return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Account never appeared on-chain: ${pubkey}`);
}

async function addUsdcTrustline(kp: Keypair) {
  const horizonUrl = "https://horizon-testnet.stellar.org";
  const {
    Horizon,
    Asset,
    Operation,
    TransactionBuilder: TB,
    Networks,
  } = await import("@stellar/stellar-sdk");
  const server = new Horizon.Server(horizonUrl);
  const account = await server.loadAccount(kp.publicKey());
  const has = account.balances.some((b: any) => b.asset_code === "USDC");
  if (has) return;
  const usdcIssuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  const tx = new TB(account, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: new Asset("USDC", usdcIssuer) }))
    .setTimeout(30)
    .build();
  tx.sign(kp);
  await server.submitTransaction(tx);
}

async function getUsdc(pubkey: string): Promise<string> {
  try {
    const server = new rpc.Server(cfg.rpcUrl, { allowHttp: false });
    const op = new Contract(cfg.usdcToken).call("balance", new Address(pubkey).toScVal());
    const dummy = new Account(Keypair.random().publicKey(), "0");
    const tx = new TransactionBuilder(dummy, {
      fee: BASE_FEE,
      networkPassphrase: cfg.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) return "0.00";
    const val = BigInt(
      scValToNative((sim as rpc.Api.SimulateTransactionSuccessResponse).result!.retval),
    );
    return `${val / 10_000_000n}.${(val % 10_000_000n).toString().padStart(7, "0").slice(0, 2)}`;
  } catch {
    return "0.00";
  }
}

// ── Simulation ────────────────────────────────────────────────────────────────

async function setupSeller(s: AgentState, index: number): Promise<number> {
  s.status = "funding…";
  render();
  await fundXlm(s.kp.publicKey());
  await addUsdcTrustline(s.kp);
  s.status = "registering…";
  render();
  const identity = new IdentityClient(cfg);
  s.agentId =
    (await identity.agentOf(s.kp.publicKey())) ??
    (await identity.register(s.kp, `ipfs://${s.label}.json`));
  feed(`{cyan-fg}${s.label}{/cyan-fg} registered as agent #${s.agentId}`);
  const port = BASE_PORT + index;
  const app = express();
  app.use(cors());
  app.get("/api/work", (_req, res) => res.json({ result: `Report from ${s.label}` }));
  await new Promise<void>((resolve) => app.listen(port, resolve));
  s.status = `ready (:${port})`;
  render();
  feed(`{cyan-fg}${s.label}{/cyan-fg} API live on :${port}`);
  return port;
}

async function runBuyer(
  b: AgentState,
  index: number,
  sellerList: { state: AgentState; port: number }[],
) {
  const commerce = new CommerceClient(cfg);
  const picked = sellerList[(index - 1) % sellerList.length];
  b.status = `→ ${picked.state.label}`;
  render();
  feed(`{magenta-fg}${b.label}{/magenta-fg} picked {cyan-fg}${picked.state.label}{/cyan-fg}`);

  b.status = "creating job…";
  render();
  const jobId = await commerce.createJob(
    b.kp,
    picked.state.kp.publicKey(),
    b.kp.publicKey(),
    cfg.usdcToken,
    BUDGET,
    `Job from ${b.label}`,
  );
  b.jobs++;
  b.usdc = await getUsdc(b.kp.publicKey());
  render();
  feed(
    `{magenta-fg}${b.label}{/magenta-fg} created job #${jobId} → {cyan-fg}${picked.state.label}{/cyan-fg} (1 USDC escrowed)`,
  );

  b.status = "calling API…";
  render();
  await fetch(`http://localhost:${picked.port}/api/work`);
  feed(`{magenta-fg}${b.label}{/magenta-fg} called {cyan-fg}${picked.state.label}{/cyan-fg} API`);

  picked.state.status = "submitting…";
  render();
  await commerce.submit(picked.state.kp, jobId, `ipfs://deliverable-${jobId}.json`);
  picked.state.jobs++;
  picked.state.usdc = await getUsdc(picked.state.kp.publicKey());
  render();
  feed(`{cyan-fg}${picked.state.label}{/cyan-fg} submitted deliverable for job #${jobId}`);

  b.status = "completing…";
  render();
  await commerce.complete(b.kp, jobId);
  b.usdc = await getUsdc(b.kp.publicKey());
  picked.state.usdc = await getUsdc(picked.state.kp.publicKey());
  b.status = "done ✓";
  picked.state.status = `ready (:${picked.port})`;
  treasuryUsdc = await getUsdc(TESTNET.deployer);
  render();
  feed(
    `{green-fg}✓ job #${jobId} complete — 99% → ${picked.state.label}, 1% → treasury (${treasuryUsdc} USDC){/green-fg}`,
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  feed(
    "{yellow-fg}MARC Marketplace simulation starting…{/yellow-fg}  {gray-fg}press q to quit{/gray-fg}",
  );
  render();

  feed("Funding + registering sellers…");
  const ports: number[] = [];
  for (let i = 0; i < sellers.length; i++) {
    try {
      ports.push(await setupSeller(sellers[i], i + 1));
    } catch (err) {
      feed(`{red-fg}${sellers[i].label} failed: ${friendlyError(err)}{/red-fg}`);
      sellers[i].status = "failed ✗";
      ports.push(0);
      render();
    }
  }
  const sellerList = sellers
    .map((s, i) => ({ state: s, port: ports[i] }))
    .filter((s) => s.port !== 0);

  feed("Registering buyers…");
  for (let i = 0; i < buyers.length; i++) {
    try {
      await fundXlm(buyers[i].kp.publicKey());
      await addUsdcTrustline(buyers[i].kp);
      buyers[i].status = "registering…";
      render();
      const identity = new IdentityClient(cfg);
      buyers[i].agentId =
        (await identity.agentOf(buyers[i].kp.publicKey())) ??
        (await identity.register(buyers[i].kp, `ipfs://${buyers[i].label}.json`));
      buyers[i].usdc = await getUsdc(buyers[i].kp.publicKey());
      feed(
        `{magenta-fg}${buyers[i].label}{/magenta-fg} registered as agent #${buyers[i].agentId} | USDC: ${buyers[i].usdc}`,
      );
      buyers[i].status = "ready";
      render();
    } catch (err) {
      feed(`{red-fg}${buyers[i].label} failed: ${friendlyError(err)}{/red-fg}`);
      buyers[i].status = "failed ✗";
      render();
    }
  }

  feed("Running job lifecycles…");
  await Promise.all(
    buyers
      .filter((b) => b.status === "ready")
      .map((b, i) =>
        runBuyer(b, i + 1, sellerList).catch((err) => {
          b.status = "failed ✗";
          render();
          feed(`{red-fg}${b.label} failed: ${friendlyError(err)}{/red-fg}`);
        }),
      ),
  );

  feed("{green-fg}{bold}✓ Simulation complete!{/bold}{/green-fg}");
  render();
}

main().catch((err) => {
  feed(`{red-fg}FATAL: ${friendlyError(err)}{/red-fg}`);
  screen.render();
});
