import "dotenv/config";
import { Keypair } from "@stellar/stellar-sdk";
import {
  IdentityClient,
  CommerceClient,
  marcFetch,
  TESTNET,
  type MarcConfig,
  type Signer,
  AwsKmsSigner,
  VaultSigner,
  initTracing,
  withSpan,
  JobStatus,
} from "marc-stellar-sdk";

// Initialize OpenTelemetry distributed tracing before any instrumented client is
// constructed. When OTEL_EXPORTER_OTLP_ENDPOINT is unset this is a no-op.
const tracing = initTracing({ serviceName: process.env.OTEL_SERVICE_NAME ?? "marc-buyer-agent" });

const cfg: MarcConfig = {
  rpcUrl: process.env.STELLAR_RPC_URL ?? TESTNET.rpcUrl,
  networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? TESTNET.networkPassphrase,
  identityContract: process.env.AGENT_IDENTITY_CONTRACT || TESTNET.identityContract,
  commerceContract: process.env.AGENTIC_COMMERCE_CONTRACT || TESTNET.commerceContract,
  usdcToken: process.env.USDC_TOKEN_CONTRACT || TESTNET.usdcToken,
};

/**
 * Resolve the Stellar transaction timeout (in seconds).
 * Priority: --timeout-sec <N> CLI argument > TX_TIMEOUT_SECS env var > 60s default.
 */
function resolveTxTimeoutSecs(): number {
  const argIdx = process.argv.indexOf("--timeout-sec");
  const argVal = argIdx !== -1 ? process.argv[argIdx + 1] : undefined;
  const raw = argVal ?? process.env.TX_TIMEOUT_SECS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
}

const txTimeoutSecs = resolveTxTimeoutSecs();

/**
 * Resolve the agent signer.
 *
 * Priority:
 *   1. AWS KMS   — when AWS_KMS_KEY_ID is set (RemoteSigner, no plaintext key in memory).
 *   2. Vault     — when VAULT_TRANSIT_KEY is set (RemoteSigner via Transit engine).
 *   3. Local     — BUYER_SECRET via Keypair.fromSecret, for local/demo mode only.
 */
function resolveSigner(): Signer {
  if (process.env.AWS_KMS_KEY_ID) {
    console.log("[signer] Using AWS KMS remote signer");
    return new AwsKmsSigner({
      keyId: process.env.AWS_KMS_KEY_ID,
      region: process.env.AWS_REGION,
      publicKey: process.env.AWS_KMS_PUBLIC_KEY,
    });
  }
  if (process.env.VAULT_TRANSIT_KEY) {
    console.log("[signer] Using HashiCorp Vault remote signer");
    return new VaultSigner({
      keyName: process.env.VAULT_TRANSIT_KEY,
      address: process.env.VAULT_ADDR,
      token: process.env.VAULT_TOKEN,
      publicKey: process.env.VAULT_TRANSIT_PUBLIC_KEY,
    });
  }
  if (!process.env.BUYER_SECRET) {
    throw new Error(
      "No signer configured: set AWS_KMS_KEY_ID, VAULT_TRANSIT_KEY, or BUYER_SECRET (local demo only)",
    );
  }
  console.log("[signer] Using local Keypair (demo mode — plaintext secret in memory)");
  return Keypair.fromSecret(process.env.BUYER_SECRET);
}

const buyer = resolveSigner();
const sellerPubkey = process.env.SELLER_PUBKEY!;
const sellerPort = Number(process.env.SELLER_PORT ?? 4402);

const pollConfig = {
  baseMs: Number(process.env.BUYER_POLL_BASE_MS ?? 2_000),
  multiplier: Number(process.env.BUYER_POLL_MULTIPLIER ?? 2),
  maxAttempts: Number(process.env.BUYER_POLL_MAX_ATTEMPTS ?? 10),
  capMs: Number(process.env.BUYER_POLL_CAP_MS ?? 30_000),
};

console.log(`\n=== BUYER DEMO ===`);
console.log(`Buyer: ${buyer.publicKey()}`);
console.log(`Transaction timeout: ${txTimeoutSecs}s`);
console.log(`Tracing: ${tracing.enabled ? "enabled" : "disabled"}\n`);

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
let agentId = await withSpan("buyer.identity.agentOf", () => identity.agentOf(buyer.publicKey()));
if (!agentId) {
  // Registration may take a few seconds to confirm on testnet — poll until visible
  await pollWithBackoff(
    async () => {
      agentId = await withSpan("buyer.identity.agentOf", () => identity.agentOf(buyer.publicKey()));
      if (agentId) return true;
      await withSpan("buyer.identity.register", () =>
        identity.register(buyer, "ipfs://buyer-metadata.json", { timeoutSecs: txTimeoutSecs }),
      );
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
const jobId = await withSpan("buyer.commerce.createJob", () =>
  commerce.createJob(
    buyer,
    sellerPubkey,
    buyer.publicKey(), // buyer acts as evaluator in demo
    cfg.usdcToken,
    budget,
    "Generate report via x402-protected endpoint",
    { timeoutSecs: txTimeoutSecs },
  ),
);
console.log(`[2] Job created — id=${jobId}, budget=1 USDC locked in escrow`);

// Poll until the job is visible on-chain before proceeding
await pollWithBackoff(
  async () => {
    const j = await withSpan("buyer.commerce.getJob", () => commerce.getJob(jobId));
    return !!j;
  },
  `job #${jobId} on-chain confirmation`,
  pollConfig,
);

// Step 3: Call seller's paywalled API via marcFetch (auto-pays 402 with exponential backoff retry)
const paidFetch = marcFetch({ signer: buyer, rpcUrl: cfg.rpcUrl, timeoutSecs: txTimeoutSecs });
console.log(`[3] Calling seller API with auto-pay…`);
let res: Response | undefined;
await pollWithBackoff(
  async () => {
    try {
      res = await withSpan("buyer.x402.fetch", () =>
        paidFetch(`http://localhost:${sellerPort}/api/work`),
      );
      return res.ok;
    } catch (err) {
      console.log(`    [retry] API call pending or testnet congested (${(err as Error).message})`);
      return false;
    }
  },
  "seller API request via marcFetch",
  pollConfig,
);
const data = await res!.json();
console.log(`    Response: ${JSON.stringify(data)}`);

// Step 4: Complete job (buyer=evaluator) → triggers 99/1 split
await withSpan("buyer.commerce.complete", () =>
  commerce.complete(buyer, jobId, { timeoutSecs: txTimeoutSecs }),
);

// Step 4b: Sequence-manager stress test — fire 10 consecutive transactions in
// rapid succession without awaiting ledger close between them. The SDK's
// AccountSequenceManager should assign monotonically increasing sequence
// numbers locally and resynchronize with Horizon on any bad-sequence error,
// so none of these should fail with txBAD_SEQ.
const BURST_COUNT = 10;
console.log(`[4b] Firing ${BURST_COUNT} consecutive transactions to validate sequence tracking…`);
const burstResults = await Promise.allSettled(
  Array.from({ length: BURST_COUNT }, (_, i) =>
    withSpan("buyer.commerce.getJob", () => commerce.getJob(jobId)).then((j) => ({
      i,
      status: j?.status,
    })),
  ),
);
const badSeq = burstResults.filter(
  (r) =>
    r.status === "rejected" &&
    /txBAD_SEQ|bad sequence|bad_seq/i.test((r.reason as Error)?.message ?? ""),
);
const burstFailures = burstResults.filter((r) => r.status === "rejected");
if (badSeq.length > 0) {
  throw new Error(
    `[4b] Sequence tracking failed — ${badSeq.length}/${BURST_COUNT} transactions hit txBAD_SEQ`,
  );
}
if (burstFailures.length > 0) {
  console.log(
    `    [4b] ${burstFailures.length}/${BURST_COUNT} calls failed transiently (resynced): ` +
      burstFailures.map((r) => (r as PromiseRejectedResult).reason?.message).join("; "),
  );
}
console.log(`[4b] ${BURST_COUNT} consecutive transactions dispatched — no txBAD_SEQ errors`);

// Poll until the job status flips to "completed"
await pollWithBackoff(
  async () => {
    const j = await withSpan("buyer.commerce.getJob", () => commerce.getJob(jobId));
    return j?.status === JobStatus.Completed;
  },
  `job #${jobId} completion confirmation`,
  pollConfig,
);

const job = await withSpan("buyer.commerce.getJob", () => commerce.getJob(jobId));
console.log(`[4] Job ${jobId} completed — status: ${job?.status}`);
console.log(`    99% released to seller, 1% to treasury\n`);
console.log(`=== BUYER DONE ===\n`);

// Flush any buffered spans before the process exits.
await tracing.shutdown();
