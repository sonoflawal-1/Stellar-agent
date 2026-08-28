import "dotenv/config";
import express from "express";
import cors from "cors";
import { Keypair } from "@stellar/stellar-sdk";
import {
  IdentityClient,
  CommerceClient,
  marcPaywall,
  TESTNET,
  type MarcConfig,
} from "marc-stellar-sdk";

const cfg: MarcConfig = {
  rpcUrl: process.env.STELLAR_RPC_URL ?? TESTNET.rpcUrl,
  networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? TESTNET.networkPassphrase,
  identityContract: process.env.AGENT_IDENTITY_CONTRACT || TESTNET.identityContract,
  commerceContract: process.env.AGENTIC_COMMERCE_CONTRACT || TESTNET.commerceContract,
  usdcToken: process.env.USDC_TOKEN_CONTRACT || TESTNET.usdcToken,
};

const seller = Keypair.fromSecret(process.env.SELLER_SECRET!);

const jobIdRaw = process.env.JOB_ID;
if (jobIdRaw !== undefined && !/^\d+$/.test(jobIdRaw)) {
  throw new Error(`JOB_ID must be a non-negative integer, got: "${jobIdRaw}"`);
}
const jobId = jobIdRaw !== undefined ? BigInt(jobIdRaw) : undefined;

/**
 * Service price for the x402 paywall.
 *
 * Configurable via SELLER_SERVICE_PRICE or SERVICE_PRICE env vars, or passed
 * dynamically via the `price` query parameter (e.g. `?price=$0.05` or `?price=10 MUSD`).
 * Defaults to "$0.01".
 */
const getServicePrice = (req?: express.Request): string => {
  if (req?.query?.price && typeof req.query.price === "string") {
    return req.query.price;
  }
  return process.env.SELLER_SERVICE_PRICE ?? process.env.SERVICE_PRICE ?? "$0.01";
};

const servicePrice: string = getServicePrice();

console.log(`\n=== SELLER DEMO ===`);
console.log(`Seller: ${seller.publicKey()}`);
console.log(
  `Default service price: ${servicePrice} (configurable via SELLER_SERVICE_PRICE env var or ?price= query param)\n`,
);

// Step 1: Register agent identity
const identity = new IdentityClient(cfg);
let agentId = await identity.agentOf(seller.publicKey());
if (!agentId) {
  agentId = await identity.register(seller, "ipfs://seller-metadata.json");
  console.log(`[1] Registered on-chain as agent #${agentId}`);
} else {
  console.log(`[1] Already registered as agent #${agentId}`);
}

// Step 2: Start x402 paywalled API
const app = express();
app.use(cors());

app.use(
  "/api/work",
  marcPaywall({
    payTo: seller.publicKey(),
    price: servicePrice, // ← driven by env var, not hardcoded
    network: "stellar:testnet",
    token: cfg.usdcToken,
    description: "One MARC-protected API call",
    facilitatorUrl: process.env.FACILITATOR_URL ?? process.env.X402_FACILITATOR_URL,
    facilitatorApiKey: process.env.FACILITATOR_API_KEY ?? process.env.X402_FACILITATOR_API_KEY,
  }),
);

app.get("/api/work", (_req, res) => {
  console.log(`[2] Work request received — payment verified`);
  res.json({ result: `Report #${Date.now()}`, seller: seller.publicKey() });
});

const port = Number(process.env.SELLER_PORT ?? 4402);
app.listen(port, () => console.log(`[2] Paywall API listening on :${port}`));

// Step 3: Submit deliverable once JOB_ID is set
if (jobId) {
  const commerce = new CommerceClient(cfg);
  await commerce.submit(seller, BigInt(jobId), "ipfs://work-results.json");
  console.log(`[3] Deliverable submitted for job ${jobId}`);
  console.log(`    Awaiting evaluator approval…\n`);
  console.log(`=== SELLER DONE ===\n`);
}
