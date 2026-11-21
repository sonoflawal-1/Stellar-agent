/**
 * demo/multi-agent.ts — End-to-end OrchestratorAgent demo
 *
 * Demonstrates the full Bear Protocol multi-agent pipeline:
 *   1. Load environment variables
 *   2. Instantiate the OrchestratorAgent
 *   3. Submit a complex goal that gets decomposed into a DAG
 *   4. Watch each task get matched to a provider, escrowed on-chain, and completed
 *   5. Print the final deliverable report
 *
 * Usage:
 *   cp demo/.env.example demo/.env  # fill in SECRET_KEY, REGISTRY_URL, etc.
 *   npx tsx demo/multi-agent.ts
 */

import "dotenv/config";
import { Keypair } from "@stellar/stellar-sdk";
import { TESTNET, type MarcConfig } from "marc-stellar-sdk";
import { OrchestratorAgent } from "../agents/orchestrator/index.js";

// ── Configuration ─────────────────────────────────────────────────────────────

const secretKey = process.env.SECRET_KEY;
if (!secretKey) {
  console.error(
    "[demo] ERROR: SECRET_KEY is not set.\n" +
      "       Copy demo/.env.example to demo/.env and fill in your testnet secret key.",
  );
  process.exit(1);
}

const registryUrl = (process.env.REGISTRY_URL ?? "http://localhost:3001").replace(/\/+$/, "");

const cfg: MarcConfig = {
  rpcUrl: process.env.STELLAR_RPC_URL ?? TESTNET.rpcUrl,
  networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? TESTNET.networkPassphrase,
  identityContract: process.env.AGENT_IDENTITY_CONTRACT ?? TESTNET.identityContract,
  commerceContract: process.env.AGENTIC_COMMERCE_CONTRACT ?? TESTNET.commerceContract,
  usdcToken: process.env.USDC_TOKEN_CONTRACT ?? TESTNET.usdcToken,
  onTx: (hash) =>
    console.log(`[tx] ${hash} → https://stellar.expert/explorer/testnet/tx/${hash}`),
};

// ── Run ───────────────────────────────────────────────────────────────────────

const keypair = Keypair.fromSecret(secretKey);

console.log("╔══════════════════════════════════════════════════════════════╗");
console.log("║          Bear Protocol — Multi-Agent Orchestration Demo      ║");
console.log("╚══════════════════════════════════════════════════════════════╝");
console.log(`  orchestrator : ${keypair.publicKey()}`);
console.log(`  registry     : ${registryUrl}`);
console.log(`  rpc          : ${cfg.rpcUrl}`);
console.log("");

const orchestrator = new OrchestratorAgent(cfg, registryUrl, keypair);

const DEMO_GOAL = "Launch a new product: a Stellar-powered payment tool";

try {
  await orchestrator.run(DEMO_GOAL);

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║                   Demo completed successfully                ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
} catch (err) {
  console.error("[demo] Unhandled error:", err);
  process.exit(1);
}
