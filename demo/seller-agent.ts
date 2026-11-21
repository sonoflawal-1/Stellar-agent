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
import {
  initTracing,
  startServerSpan,
  type RemoteSigner,
  createRemoteSignerFromEnv,
} from "marc-stellar-sdk/observability";

const cfg: MarcConfig = {
  rpcUrl: process.env.STELLAR_RPC_URL ?? TESTNET.rpcUrl,
  networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? TESTNET.networkPassphrase,
  identityContract: process.env.AGENT_IDENTITY_CONTRACT || TESTNET.identityContract,
  commerceContract: process.env.AGENTIC_COMMERCE_CONTRACT || TESTNET.commerceContract,
  usdcToken: process.env.USDC_TOKEN_CONTRACT || TESTNET.usdcToken,
};

/**
 * Transaction timeout in seconds.
 *
 * Configurable via the TX_TIMEOUT_SECS env var or the `--timeout-sec <N>` CLI
 * argument. Defaults to 60s to tolerate testnet congestion and ledger latency.
 */
const readTimeoutSecs = (): number => {
  const argIdx = process.argv.indexOf("--timeout-sec");
  const raw = argIdx !== -1 ? process.argv[argIdx + 1] : process.env.TX_TIMEOUT_SECS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
};

const txTimeoutSecs = readTimeoutSecs();

// Initialize OpenTelemetry tracing (issue #726). No-op unless OTEL_EXPORTER_OTLP_ENDPOINT
// (or OTEL_TRACES_EXPORTER) is configured; exports spans via OTLP to Jaeger / Tempo.
initTracing({ serviceName: process.env.OTEL_SERVICE_NAME ?? "marc-seller-agent" });

/**
 * Resolve the seller signer (issue #727).
 *
 * When a remote signer is configured (AWS KMS / HashiCorp Vault), the agent
 * never holds a plaintext secret key in memory. Falling back to
 * `Keypair.fromSecret` is only permitted in local/demo mode.
 */
const resolveSellerSigner = (): Keypair | RemoteSigner => {
  const remote = createRemoteSignerFromEnv();
  if (remote) {
    console.log(`Signer: remote (${remote.constructor.name})`);
    return remote;
  }
  const secret = process.env.SELLER_SECRET;
  if (!secret) {
    throw new Error(
      "No signer configured: set a remote signer (AWS KMS / Vault) or SELLER_SECRET for local demo mode",
    );
  }
  console.log(`Signer: local Keypair (demo mode — plaintext secret in memory)`);
  return Keypair.fromSecret(secret);
};

const seller = resolveSellerSigner();
const sellerPublicKey = "publicKey" in seller ? seller.publicKey() : seller.publicKey();

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
console.log(`Seller: ${sellerPublicKey}`);
console.log(`Transaction timeout: ${txTimeoutSecs}s (TX_TIMEOUT_SECS or --timeout-sec)`);
console.log(
  `Default service price: ${servicePrice} (configurable via SELLER_SERVICE_PRICE env var or ?price= query param)\n`,
);

// Step 1: Register agent identity
const identity = new IdentityClient(cfg);
let agentId = await identity.agentOf(sellerPublicKey);
if (!agentId) {
  agentId = await identity.register(seller, "ipfs://seller-metadata.json", { timeoutSecs: txTimeoutSecs });
  console.log(`[1] Registered on-chain as agent #${agentId}`);
} else {
  console.log(`[1] Already registered as agent #${agentId}`);
}

// Step 2: Start x402 paywalled API
const app = express();
app.use(cors());

// Server span per inbound request (issue #726). The span is continued from the
// incoming `traceparent` header so buyer → seller traces correlate end-to-end.
app.use((req, res, next) => {
  const span = startServerSpan(req.method, req.path, req.headers);
  res.on("finish", () => {
    span.setAttribute("http.status_code", res.statusCode);
    span.end();
  });
  next();
});

app.use(
  "/api/work",
  marcPaywall({
    payTo: sellerPublicKey,
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
  res.json({ result: `Report #${Date.now()}`, seller: sellerPublicKey });
});

const port = Number(process.env.SELLER_PORT ?? 4402);
app.listen(port, () => console.log(`[2] Paywall API listening on :${port}`));

// Step 3: Submit deliverable once JOB_ID is set
if (jobId) {
  const commerce = new CommerceClient(cfg);
  await commerce.submit(seller, BigInt(jobId), "ipfs://work-results.json", { timeoutSecs: txTimeoutSecs });
  console.log(`[3] Deliverable submitted for job ${jobId}`);
  console.log(`    Awaiting evaluator approval…\n`);
  console.log(`=== SELLER DONE ===\n`);
}
