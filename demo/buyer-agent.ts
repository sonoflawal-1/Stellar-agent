import "dotenv/config";
import { Keypair } from "@stellar/stellar-sdk";
import { IdentityClient, CommerceClient, marcFetch, TESTNET, type MarcConfig } from "marc-stellar-sdk";

const cfg: MarcConfig = {
  rpcUrl: process.env.STELLAR_RPC_URL ?? TESTNET.rpcUrl,
  networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? TESTNET.networkPassphrase,
  identityContract: process.env.AGENT_IDENTITY_CONTRACT || TESTNET.identityContract,
  commerceContract: process.env.AGENTIC_COMMERCE_CONTRACT || TESTNET.commerceContract,
  usdcToken: process.env.USDC_TOKEN_CONTRACT || TESTNET.usdcToken,
};

const buyer = Keypair.fromSecret(process.env.BUYER_SECRET!);
const sellerPubkey = process.env.SELLER_PUBKEY!;
const sellerPort = Number(process.env.SELLER_PORT ?? 4402);

const pollConfig = {
  baseMs: Number(process.env.BUYER_POLL_BASE_MS ?? 2_000),
  multiplier: Number(process.env.BUYER_POLL_MULTIPLIER ?? 2),
  maxAttempts: Number(process.env.BUYER_POLL_MAX_ATTEMPTS ?? 10),
  capMs: Number(process.env.BUYER_POLL_CAP_MS ?? 30_000),
};

console.log(`\n=== BUYER DEMO ===`);
console.log(`Buyer: ${buyer.publicKey()}\n`);

/**
 * Poll a condition with exponential backoff.
 * @param fn       Async predicate — return true to stop, false to keep polling.
 * @param label    Human-readable description for log output.
 * @param opts     Optional overrides for base delay, multiplier, max attempts, and cap.
 */
async function pollWithBackoff(
  fn: () => Promise<boolean>,
  label: string,
  opts: { baseMs?: number; multiplier?: number; maxAttempts?: number; capMs?: number } = {},
): Promise<void> {
  const { baseMs = 2_000, multiplier = 2, maxAttempts = 10, capMs = 30_000 } = opts;
  let delay = baseMs;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const done = await fn();
    if (done) return;
    if (attempt === maxAttempts) throw new Error(`Timed out waiting for: ${label}`);
    console.log(`  [poll] ${label} — attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms…`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * multiplier, capMs);
  }
}

// Step 1: Register agent identity
const identity = new IdentityClient(cfg);
let agentId = await identity.agentOf(buyer.publicKey());
if (!agentId) {
  // Registration may take a few seconds to confirm on testnet — poll until visible
  await pollWithBackoff(
    async () => {
      agentId = await identity.agentOf(buyer.publicKey());
      if (agentId) return true;
      await identity.register(buyer, "ipfs://buyer-metadata.json");
      return false;
    },
    "buyer agent registration",
    { ...pollConfig, maxAttempts: 8 },
  );
  console.log(`[1] Registered on-chain as agent #${agentId}`);
} else {
  console.log(`[1] Already registered as agent #${agentId}`);
}

// Step 2: Create escrow job
const commerce = new CommerceClient(cfg);
const budget = BigInt(10_000_000); // 1 USDC
const jobId = await commerce.createJob(
  buyer,
  sellerPubkey,
  buyer.publicKey(), // buyer acts as evaluator in demo
  cfg.usdcToken,
  budget,
  "Generate report via x402-protected endpoint",
);
console.log(`[2] Job created — id=${jobId}, budget=1 USDC locked in escrow`);

// Poll until the job is visible on-chain before proceeding
await pollWithBackoff(
  async () => {
    const j = await commerce.getJob(jobId);
    return !!j;
  },
  `job #${jobId} on-chain confirmation`,
  pollConfig,
);

// Step 3: Call seller's paywalled API via marcFetch (auto-pays 402)
const paidFetch = marcFetch({ signer: buyer, rpcUrl: cfg.rpcUrl });
console.log(`[3] Calling seller API with auto-pay…`);
const res = await paidFetch(`http://localhost:${sellerPort}/api/work`);
const data = await res.json();
console.log(`    Response: ${JSON.stringify(data)}`);

// Step 4: Complete job (buyer=evaluator) → triggers 99/1 split
await commerce.complete(buyer, jobId);

// Poll until the job status flips to "completed"
await pollWithBackoff(
  async () => {
    const j = await commerce.getJob(jobId);
    return j?.status === "completed";
  },
  `job #${jobId} completion confirmation`,
  pollConfig,
);

const job = await commerce.getJob(jobId);
console.log(`[4] Job ${jobId} completed — status: ${job?.status}`);
console.log(`    99% released to seller, 1% to treasury\n`);
console.log(`=== BUYER DONE ===\n`);
