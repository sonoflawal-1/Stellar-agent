/**
 * Cancel-flow demo — closes issue #77.
 *
 * Demonstrates the refund path:
 *   1. Buyer registers on-chain.
 *   2. Buyer creates an escrow job (budget locked).
 *   3. Buyer cancels the job BEFORE the seller submits.
 *   4. Contract refunds the full budget back to the buyer.
 *
 * The demo prints USDC balances before and after the cancel so the refund
 * is visually verifiable in the terminal.
 *
 * Environment variables (all optional — fall back to TESTNET defaults):
 *   BUYER_SECRET               Buyer keypair secret (required)
 *   SELLER_PUBKEY              Seller public key (required — used as job provider)
 *   STELLAR_RPC_URL
 *   STELLAR_NETWORK_PASSPHRASE
 *   AGENT_IDENTITY_CONTRACT
 *   AGENTIC_COMMERCE_CONTRACT
 *   USDC_TOKEN_CONTRACT
 *
 * Run:
 *   npx tsx demo/cancel-flow.ts
 */
import "dotenv/config";
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
import {
  IdentityClient,
  CommerceClient,
  JobStatus,
  TESTNET,
  type MarcConfig,
} from "marc-stellar-sdk";

// ── Config ────────────────────────────────────────────────────────────────────

const cfg: MarcConfig = {
  rpcUrl: process.env.STELLAR_RPC_URL ?? TESTNET.rpcUrl,
  networkPassphrase:
    process.env.STELLAR_NETWORK_PASSPHRASE ?? TESTNET.networkPassphrase,
  identityContract:
    process.env.AGENT_IDENTITY_CONTRACT || TESTNET.identityContract,
  commerceContract:
    process.env.AGENTIC_COMMERCE_CONTRACT || TESTNET.commerceContract,
  usdcToken: process.env.USDC_TOKEN_CONTRACT || TESTNET.usdcToken,
};

const buyer = Keypair.fromSecret(process.env.BUYER_SECRET!);
const sellerPubkey = process.env.SELLER_PUBKEY!;

if (!sellerPubkey) {
  console.error("SELLER_PUBKEY env var is required.");
  process.exit(1);
}

const BUDGET = BigInt(10_000_000); // 1 USDC (7 decimal places)

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Poll a condition with exponential backoff.
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
    console.log(
      `  [poll] ${label} — attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms…`,
    );
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * multiplier, capMs);
  }
}

/**
 * Read the USDC balance of an account by simulating a contract call.
 * Returns a human-readable string like "1.00".
 */
async function getUsdc(pubkey: string): Promise<string> {
  try {
    const server = new rpc.Server(cfg.rpcUrl, { allowHttp: false });
    const op = new Contract(cfg.usdcToken).call(
      "balance",
      new Address(pubkey).toScVal(),
    );
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
      scValToNative(
        (sim as rpc.Api.SimulateTransactionSuccessResponse).result!.retval,
      ),
    );
    return `${val / 10_000_000n}.${(val % 10_000_000n)
      .toString()
      .padStart(7, "0")
      .slice(0, 2)}`;
  } catch {
    return "0.00";
  }
}

// ── Demo ──────────────────────────────────────────────────────────────────────

console.log("\n=== CANCEL-FLOW DEMO ===");
console.log(`Buyer:  ${buyer.publicKey()}`);
console.log(`Seller: ${sellerPubkey}\n`);

const identity = new IdentityClient(cfg);
const commerce = new CommerceClient(cfg);

// Step 1 — Register buyer identity (idempotent)
let agentId = await identity.agentOf(buyer.publicKey());
if (!agentId) {
  agentId = await identity.register(buyer, "ipfs://buyer-cancel-demo.json");
  console.log(`[1] Registered on-chain as agent #${agentId}`);
} else {
  console.log(`[1] Already registered as agent #${agentId}`);
}

// Step 2 — Record balance before escrow
const balanceBefore = await getUsdc(buyer.publicKey());
console.log(`[2] Buyer USDC before job creation : ${balanceBefore}`);

// Step 3 — Create escrow job
const jobId = await commerce.createJob(
  buyer,
  sellerPubkey,
  buyer.publicKey(), // buyer is also the evaluator in this demo
  cfg.usdcToken,
  BUDGET,
  "Cancel-flow demo job — should be refunded",
);
console.log(`[3] Job created — id=${jobId}, 1 USDC locked in escrow`);

// Poll until job appears on-chain
await pollWithBackoff(
  async () => {
    const j = await commerce.getJob(jobId);
    return !!j;
  },
  `job #${jobId} on-chain confirmation`,
  { baseMs: 2_000, maxAttempts: 10 },
);

const balanceAfterCreate = await getUsdc(buyer.publicKey());
console.log(`    Buyer USDC after  job creation : ${balanceAfterCreate}  (1 USDC escrowed)`);

// Step 4 — Cancel the job (no deliverable submitted, so cancellation is allowed)
console.log(`[4] Cancelling job #${jobId}…`);
await commerce.cancel(buyer, jobId);

// Poll until job status flips to "cancelled"
await pollWithBackoff(
  async () => {
    const j = await commerce.getJob(jobId);
    return j?.status === JobStatus.Cancelled;
  },
  `job #${jobId} cancellation confirmation`,
  { baseMs: 2_000, maxAttempts: 10 },
);

const job = await commerce.getJob(jobId);
console.log(`    Job status: ${job?.status}`);

// Step 5 — Verify refund
const balanceAfterCancel = await getUsdc(buyer.publicKey());
console.log(`[5] Buyer USDC after cancellation : ${balanceAfterCancel}`);

const refunded =
  parseFloat(balanceAfterCancel) >= parseFloat(balanceBefore) - 0.001; // allow small fee tolerance
if (refunded) {
  console.log(`\n✅  Refund confirmed — budget returned to buyer.`);
} else {
  console.log(
    `\n⚠️  Balance did not fully recover (before=${balanceBefore}, after=${balanceAfterCancel}).`,
  );
  console.log(`    This may indicate a partial fee or a polling delay.`);
}

console.log("\n=== CANCEL-FLOW DONE ===\n");
