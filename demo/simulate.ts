/**
 * Multi-agent marketplace simulation.
 *
 * 4 sellers register on-chain and start x402 paywall servers.
 * 5 buyers browse registered agents, each picks a seller, creates an escrow
 * job, pays via marcFetch, seller submits deliverable, buyer completes job.
 *
 * All keypairs are generated fresh and funded via Friendbot.
 * Requires only: USDC_TOKEN_CONTRACT (or falls back to TESTNET default).
 *
 * Run: npm run simulate
 */
import "dotenv/config";
import express from "express";
import { Keypair, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  IdentityClient,
  CommerceClient,
  JobStatus,
  marcPaywall,
  marcFetch,
  TESTNET,
  type MarcConfig,
  type Agent,
} from "marc-stellar-sdk";

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
const BUDGET = BigInt(10_000_000); // 1 USDC

/** Decode a raw ScVal hex/base64 string to a native JS value for readable logging. */
function decodeScVal(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  for (const enc of ["hex", "base64"] as const) {
    try {
      return scValToNative(xdr.ScVal.fromXDR(raw, enc));
    } catch { /* try next encoding */ }
  }
  return raw;
}

/** Format an error, decoding any embedded XDR/ScVal hex in the message. */
function fmtError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // Replace long hex runs that look like XDR payloads with their decoded form.
  return err.message.replace(/\b([0-9a-f]{32,})\b/gi, (hex) => {
    try {
      const decoded = scValToNative(xdr.ScVal.fromXDR(hex, "hex"));
      return `[ScVal: ${JSON.stringify(decoded)}]`;
    } catch {
      return hex;
    }
  });
}

function tag(role: string, i: number) {
  return `[${role}-${i}]`;
}

async function fundAccount(publicKey: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org?addr=${publicKey}`);
  if (!res.ok) throw new Error(`Friendbot failed for ${publicKey}: ${res.statusText}`);
}

async function fundUsdc(publicKey: string): Promise<void> {
  // Circle testnet USDC faucet
  const res = await fetch("https://faucet.circle.com/api/faucet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: publicKey, blockchain: "stellar-testnet" }),
  });
  if (!res.ok) throw new Error(`USDC faucet failed for ${publicKey}: ${res.statusText}`);
}

// --- Fund all accounts in parallel ---
async function setupKeypairs(count: number, role: string): Promise<Keypair[]> {
  const kps = Array.from({ length: count }, () => Keypair.random());
  console.log(`\nFunding ${count} ${role} accounts...`);
  await Promise.all(kps.map(async (kp, i) => {
    await fundAccount(kp.publicKey());
    if (role === "buyer") await fundUsdc(kp.publicKey());
    console.log(`  ${tag(role, i + 1)} funded: ${kp.publicKey()}`);
  }));
  return kps;
}

// --- Seller: register + start paywall server ---
async function startSeller(kp: Keypair, index: number): Promise<{ agent: Agent; port: number }> {
  const t = tag("seller", index);
  const identity = new IdentityClient(cfg);
  const agentId = await identity.register(kp, `ipfs://seller-${index}-metadata.json`);
  const agent = (await identity.getAgent(agentId))!;
  console.log(`${t} registered as agent #${agentId}`);

  const port = BASE_PORT + index;
  const app = express();

  app.use("/api/work", marcPaywall({
    payTo: kp.publicKey(),
    price: "$0.01",
    network: "stellar:testnet",
    token: cfg.usdcToken,
    description: `Work from seller-${index}`,
    facilitatorUrl: process.env.X402_FACILITATOR_URL,
    facilitatorApiKey: process.env.X402_FACILITATOR_API_KEY,
  }));

  app.get("/api/work", (_req, res) => {
    res.json({ result: `Report from seller-${index} at ${Date.now()}`, seller: kp.publicKey() });
  });

  await new Promise<void>((resolve) => app.listen(port, resolve));
  console.log(`${t} paywall listening on :${port}`);

  return { agent, port };
}

// --- Buyer: browse agents, pick seller, run full job lifecycle ---
async function runBuyer(
  kp: Keypair,
  index: number,
  sellers: { kp: Keypair; agent: Agent; port: number }[],
): Promise<void> {
  const t = tag("buyer", index);
  const identity = new IdentityClient(cfg);
  const commerce = new CommerceClient(cfg);

  // Register
  const agentId = await identity.register(kp, `ipfs://buyer-${index}-metadata.json`);
  console.log(`${t} registered as agent #${agentId}`);

  // Browse registered agents and pick one round-robin
  const allAgents = await identity.listAgents();
  console.log(`${t} found ${allAgents.length} agents on-chain`);

  const picked = sellers[(index - 1) % sellers.length];
  console.log(`${t} chose seller agent #${picked.agent.id} (${picked.agent.owner.slice(0, 8)}...)`);

  // Create escrow job
  const jobId = await commerce.createJob(
    kp,
    picked.agent.owner,
    kp.publicKey(), // buyer = evaluator in demo
    cfg.usdcToken,
    BUDGET,
    `Job from buyer-${index} to seller-${(index - 1) % sellers.length + 1}`,
  );
  console.log(`${t} job #${jobId} created — 1 USDC locked in escrow`);

  // Pay seller's API via x402
  const paidFetch = marcFetch({ signer: kp, rpcUrl: cfg.rpcUrl });
  const res = await paidFetch(`http://localhost:${picked.port}/api/work`);
  const data = await res.json();
  console.log(`${t} x402 call paid — response: ${JSON.stringify(data)}`);

  // Seller submits deliverable
  await commerce.submit(picked.kp, jobId, `ipfs://deliverable-job-${jobId}.json`);
  console.log(`${t} seller submitted deliverable for job #${jobId}`);

  // Buyer (evaluator) completes job → 99/1 split
  await commerce.complete(kp, jobId);
  const job = await commerce.getJob(jobId);
  console.log(`${t} job #${jobId} completed — status: ${job?.status ?? "unknown"} — 99% to seller, 1% fee`);
}

// --- Stress test: N parallel jobs, each with its own seller+buyer keypair ---
async function runStressTest(n: number): Promise<void> {
  console.log(`\n=== MARC STRESS TEST: ${n} parallel jobs ===\n`);

  // Independent keypair pair per slot avoids nonce conflicts across concurrent txs.
  const slots = Array.from({ length: n }, (_, i) => ({
    seller: Keypair.random(),
    buyer: Keypair.random(),
    index: i + 1,
  }));

  console.log(`Funding ${n * 2} accounts via Friendbot...`);
  await Promise.all(
    slots.flatMap(({ seller, buyer }) => [
      fundAccount(seller.publicKey()),
      fundAccount(buyer.publicKey()),
    ]),
  );
  console.log("  All accounts funded.\n");

  const identity = new IdentityClient(cfg);
  const commerce = new CommerceClient(cfg);

  // Register both agents and create job — all N slots in parallel.
  console.log(`Creating ${n} jobs in parallel...`);
  const jobSlots = await Promise.all(
    slots.map(async ({ seller, buyer, index }) => {
      await Promise.all([
        identity.register(seller, `ipfs://stress-seller-${index}.json`),
        identity.register(buyer, `ipfs://stress-buyer-${index}.json`),
      ]);
      const jobId = await commerce.createJob(
        buyer,
        seller.publicKey(),
        buyer.publicKey(),
        cfg.usdcToken,
        BUDGET,
        `Stress job ${index}/${n}`,
      );
      console.log(`  [${index}/${n}] job #${jobId} created`);
      return { seller, buyer, jobId, index };
    }),
  );

  // Each seller submits their own deliverable — all in parallel.
  console.log(`\nSubmitting ${n} deliverables in parallel...`);
  await Promise.all(
    jobSlots.map(async ({ seller, jobId, index }) => {
      await commerce.submit(seller, jobId, `ipfs://stress-result-${jobId}.json`);
      console.log(`  [${index}/${n}] job #${jobId} submitted`);
    }),
  );

  // Each buyer completes their job — all in parallel.
  console.log(`\nCompleting ${n} jobs in parallel...`);
  await Promise.all(
    jobSlots.map(async ({ buyer, jobId, index }) => {
      await commerce.complete(buyer, jobId);
      console.log(`  [${index}/${n}] job #${jobId} completed`);
    }),
  );

  // Verify every job reached Completed status.
  console.log(`\nVerifying ${n} outcomes...`);
  const results = await Promise.all(
    jobSlots.map(async ({ jobId, index }) => {
      const job = await commerce.getJob(jobId);
      const pass = job?.status === JobStatus.Completed;
      console.log(`  [${index}/${n}] job #${jobId}: ${pass ? "PASS" : "FAIL"} (status=${job?.status ?? "null"})`);
      return pass;
    }),
  );

  const passed = results.filter(Boolean).length;
  console.log(`\n=== STRESS RESULT: ${passed}/${n} passed ===`);
  if (passed < n) {
    console.error(`${n - passed} job(s) failed verification.`);
    process.exit(1);
  }
}

// --- Main ---
async function main() {
  const stressIdx = process.argv.indexOf("--stress");
  if (stressIdx !== -1) {
    const n = parseInt(process.argv[stressIdx + 1] ?? "", 10);
    if (!Number.isFinite(n) || n < 1) {
      console.error("Usage: npm run simulate -- --stress <N>  (N must be >= 1)");
      process.exit(1);
    }
    await runStressTest(n);
    process.exit(0);
  }

  console.log("=== MARC MARKETPLACE SIMULATION ===");
  console.log(`${NUM_SELLERS} sellers, ${NUM_BUYERS} buyers\n`);

  const [sellerKps, buyerKps] = await Promise.all([
    setupKeypairs(NUM_SELLERS, "seller"),
    setupKeypairs(NUM_BUYERS, "buyer"),
  ]);

  // Start all sellers in parallel
  console.log("\nRegistering sellers and starting paywall servers...");
  const sellerInfos = await Promise.all(
    sellerKps.map((kp, i) => startSeller(kp, i + 1).then((info) => ({ kp, ...info }))),
  );

  // Run all buyers in parallel
  console.log("\nRunning buyers...");
  await Promise.all(buyerKps.map((kp, i) => runBuyer(kp, i + 1, sellerInfos)));

  console.log("\n=== SIMULATION COMPLETE ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", fmtError(err));
  process.exit(1);
});
