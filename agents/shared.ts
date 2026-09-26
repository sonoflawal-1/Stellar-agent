import fs from "node:fs";
import path from "node:path";
import express from "express";
import { z } from "zod";
import { Keypair } from "@stellar/stellar-sdk";
import { IdentityClient, TESTNET, maskSecret, type MarcConfig } from "marc-stellar-sdk";

export interface StandardSellerResponse<T = unknown> {
  success: boolean;
  data: T;
  execution_time_ms: number;
}

/**
 * Standard capability tag taxonomy approved for agent manifests (Issue #597).
 * Standardizing tags allows buyer agents to reliably discover sellers by capability.
 */
export const APPROVED_TAGS = [
  "webdev",
  "copywriting",
  "research",
  "naming",
  "translation",
  "data-analysis",
  "seo",
  "design",
] as const;

export type ApprovedTag = (typeof APPROVED_TAGS)[number];

export const MAX_PROMPT_LENGTH = 8000;

/**
 * Zod schema for `agent.config.json` (Issue #659).
 * Each seller agent ships this file and self-registers from it at startup.
 */
export const AgentConfigSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  capabilities: z.array(z.string().min(1)).min(1),
  pricing: z.object({
    model: z.string().min(1),
    price: z.number().nonnegative(),
    currency: z.string().min(1),
  }),
  endpoint: z.string().url(),
  health: z.string().min(1),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/**
 * Load and validate `agent.config.json` from the given directory (Issue #659).
 * Throws a descriptive error when the file is missing or fails Zod validation.
 */
export function loadAgentConfig(agentDir: string): AgentConfig {
  const configPath = path.join(agentDir, "agent.config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`[auto-register] Missing config file: ${configPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const parsed = AgentConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `[auto-register] Invalid agent.config.json: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

/**
 * Pin agent metadata to IPFS, or fall back to a local URI in dev mode (Issue #659).
 */
export async function pinMetadata(config: AgentConfig): Promise<string> {
  if (process.env.DEV_MODE === "true" || !process.env.IPFS_API_URL) {
    return `local://agent-metadata/${config.name}@${config.version}`;
  }
  const res = await fetch(`${process.env.IPFS_API_URL}/api/v0/add`, {
    method: "POST",
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    throw new Error(`[auto-register] IPFS pin failed: ${res.status} ${res.statusText}`);
  }
  const { Hash } = (await res.json()) as { Hash: string };
  return `ipfs://${Hash}`;
}

/**
 * Auto-register a seller agent from its config (Issue #659).
 * Idempotent: skips registration when the agent is already registered.
 * Pass `{ dryRun: true }` (or `--dry-run`) to preview without submitting a transaction.
 */
export async function autoRegister(
  config: AgentConfig,
  keypair: Keypair,
  options: { dryRun?: boolean } = {},
): Promise<{ agentId: bigint | null; registered: boolean; metadataUri: string }> {
  const dryRun = options.dryRun ?? process.argv.includes("--dry-run");
  const cfg: MarcConfig = {
    rpcUrl: process.env.STELLAR_RPC_URL ?? TESTNET.rpcUrl,
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? TESTNET.networkPassphrase,
    identityContract: process.env.AGENT_IDENTITY_CONTRACT || TESTNET.identityContract,
    commerceContract: process.env.AGENTIC_COMMERCE_CONTRACT || TESTNET.commerceContract,
    usdcToken: process.env.USDC_TOKEN_CONTRACT || TESTNET.usdcToken,
    onTx: (hash) =>
      console.log(`[tx] ${hash} → https://stellar.expert/explorer/testnet/tx/${hash}`),
  };

  const identity = new IdentityClient(cfg);
  const metadataUri = await pinMetadata(config);

  const existing = await identity.getAgentId(keypair.publicKey()).catch(() => null);
  if (existing !== null && existing !== undefined) {
    console.log(`Agent already registered: ID=${existing}`);
    return { agentId: BigInt(existing), registered: false, metadataUri };
  }

  if (dryRun) {
    console.log(
      `[dry-run] Would register ${config.name}@${config.version} (${keypair.publicKey()}) with metadata ${metadataUri}`,
    );
    return { agentId: null, registered: false, metadataUri };
  }

  const agentId = await identity.register(keypair, {
    name: config.name,
    version: config.version,
    capabilities: config.capabilities,
    pricing: config.pricing,
    endpoint: config.endpoint,
    health: config.health,
    metadataUri,
  });
  console.log(`Agent registered: ID=${agentId}`);
  return { agentId: BigInt(agentId), registered: true, metadataUri };
}

/**
 * Validate that a prompt/task input is a non-empty string and does not exceed
 * the maximum character limit (8,000 characters).
 */
export function validatePrompt(prompt: unknown): { valid: boolean; error?: string } {
  if (typeof prompt !== "string" || prompt.trim() === "") {
    return { valid: false, error: "Prompt must be a non-empty string" };
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return {
      valid: false,
      error: `Prompt exceeds maximum allowed length of ${MAX_PROMPT_LENGTH} characters`,
    };
  }
  return { valid: true };
}

/**
 * Checks whether offline mock LLM mode is enabled.
 */
export function isMockLlm(): boolean {
  return process.env.MOCK_LLM === "true";
}

/**
 * Realistic canned deliverables for offline integration testing without external LLM APIs.
 */
export const MOCK_DELIVERABLES = {
  webbuilder: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Autonomous Agent Commerce</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 2rem; background: #0f172a; color: #f8fafc; }
    .container { max-width: 800px; margin: 0 auto; }
    header { padding: 2rem 0; border-bottom: 1px solid #334155; }
    h1 { color: #38bdf8; font-size: 2.25rem; }
    p { font-size: 1.125rem; line-height: 1.6; color: #cbd5e1; }
    .btn { display: inline-block; background: #0284c7; color: white; padding: 0.75rem 1.5rem; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 1rem; }
    .btn:hover { background: #0369a1; }
    .features { margin-top: 2rem; display: grid; gap: 1rem; }
    .card { background: #1e293b; padding: 1.25rem; border-radius: 8px; border: 1px solid #334155; }
    footer { margin-top: 3rem; color: #64748b; font-size: 0.875rem; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Autonomous Commerce Platform</h1>
      <p>Instant, escrow-secured payments between autonomous agents on the Stellar network.</p>
      <a href="#explore" class="btn">Explore Agents</a>
    </header>
    <main class="features">
      <div class="card">
        <h3>Escrow Settlements</h3>
        <p>Funds locked in Soroban smart contracts and automatically released upon evaluator verification.</p>
      </div>
      <div class="card">
        <h3>Decentralized Registry</h3>
        <p>Real-time heartbeat monitoring and verified on-chain reputation ratings.</p>
      </div>
    </main>
    <footer>&copy; 2026 Bear Protocol Mock Deliverable</footer>
  </div>
</body>
</html>`,

  copywriter: `# Next-Generation AI Commerce on Stellar

## Trustless Micro-Settlements for Autonomous Agents

Supercharge your decentralized applications with autonomous seller agents that deliver work and get paid instantly in USDC via Soroban smart contracts. No human intermediaries, zero escrow lockup risk.

## Key Benefits
- **Automated Milestone Escrow:** Payments released strictly upon verified deliverable approval.
- **Sub-Second Finality:** Harness Stellar's lightning-fast consensus for seamless agent-to-agent transactions.
- **Verified Reputation:** On-chain quality metrics that eliminate provider ambiguity.

## Get Started
Connect your buyer agent today and experience frictionless autonomous commerce.`,

  namer: `# Brand Name Ideas

1. **AegisFlow** - Blends security and fluid transactions, highlighting smart contract escrow safety.
2. **StellarSphere** - Evokes wide-reaching decentralized infrastructure and interconnected agent ecosystems.
3. **NovaPay** - Modern, concise branding signaling bright innovation in automated micropayments.
4. **VanguardAgent** - Represents state-of-the-art autonomy, reliability, and enterprise-grade capability.
5. **OmniSoroban** - Highlights complete multi-agent interoperability natively on the Soroban network.`,

  researcher: {
    summary:
      "# Research Summary: Decentralized AI Agent Escrow Protocols\n\nRecent developments in blockchain-native agent infrastructure demonstrate a growing demand for autonomous micro-commerce [1]. By utilizing Soroban smart contracts on the Stellar network, agents can execute programmatic contracts with negligible transaction fees and guaranteed finality [2].\n\n## Core Findings\n- **Escrow Architecture:** Decentralized escrows eliminate counterparty risk between autonomous agents by holding buyer deposits until deliverables pass evaluator validation.\n- **Reputation Signals:** Tracking on-chain completed jobs and dispute counts provides reliable discovery metrics [3].\n- **Offline Reliability:** Mock test modes ensure continuous integration pipelines operate without external LLM dependencies.",
    sources: [
      {
        title: "Stellar Soroban Smart Contracts Documentation",
        url: "https://developers.stellar.org/docs/build/smart-contracts/overview",
      },
      {
        title: "Decentralized AI Agent Commerce Architecture",
        url: "https://stellar.expert/explorer/testnet",
      },
      {
        title: "Stellar Consensus Protocol Specification",
        url: "https://www.stellar.org/papers/stellar-consensus-protocol",
      },
    ],
  },
};

export function validateEnv(requiredKeys: string[]): void {
  const effectiveRequired = isMockLlm()
    ? requiredKeys.filter((k) => k !== "GROQ_API_KEY")
    : requiredKeys;

  const aliases: Record<string, string[]> = {
    PORT: ["PORT", "SELLER_PORT"],
    SECRET_KEY: ["SECRET_KEY", "SELLER_SECRET"],
    REGISTRY_URL: ["REGISTRY_URL"],
    GROQ_API_KEY: ["GROQ_API_KEY"],
  };

  const missing: string[] = [];
  for (const key of effectiveRequired) {
    const candidates = aliases[key] ?? [key];
    const isPresent = candidates.some((candidateKey) => {
      const value = process.env[candidateKey];
      return typeof value === "string" && value.trim() !== "";
    });
    if (!isPresent) {
      missing.push(key);
    }
  }

  const uniqueMissing = [...new Set(missing)];
  if (uniqueMissing.length > 0) {
    console.error(`[startup] Missing required environment variables: ${uniqueMissing.join(", ")}`);
    process.exit(1);
  }
}

export function makeSellerResponse<T>(data: T, startTime = Date.now()): StandardSellerResponse<T> {
  return {
    success: true,
    data,
    execution_time_ms: Date.now() - startTime,
  };
}

export async function createSellerAgent(options: {
  id: string;
  port: number;
  agentDir: string;
}): Promise<{ app: express.Express; seller: Keypair; agentId: bigint; cfg: MarcConfig }> {
  const cfg: MarcConfig = {
    rpcUrl: process.env.STELLAR_RPC_URL ?? TESTNET.rpcUrl,
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? TESTNET.networkPassphrase,
    identityContract: process.env.AGENT_IDENTITY_CONTRACT || TESTNET.identityContract,
    commerceContract: process.env.AGENTIC_COMMERCE_CONTRACT || TESTNET.commerceContract,
    usdcToken: process.env.USDC_TOKEN_CONTRACT || TESTNET.usdcToken,
    onTx: (hash) =>
      console.log(`[tx] ${hash} → https://stellar.expert/explorer/testnet/tx/${hash}`),
  };

  const seller = Keypair.fromSecret(process.env.SELLER_SECRET!);
  const identity = new IdentityClient(cfg);

  const config = loadAgentConfig(options.agentDir);
  const { agentId } = await autoRegister(config, seller);

  const app = express();
  app.use(express.json());

  app.get(config.health, (_req, res) => {
    res.json({ status: "ok", agent: config.name, version: config.version });
  });

  return { app, seller, agentId: agentId ?? 0n, cfg };
}
