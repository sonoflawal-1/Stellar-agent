import fs from "node:fs";
import path from "node:path";
import express from "express";
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
  let agentId: bigint | null = null;
  try {
    await retryWithBackoff(
      async () => {
        agentId = await identity.agentOf(seller.publicKey());
      },
      { maxAttempts: 6, baseDelayMs: 2000, label: options.id },
    );
  } catch (err) {
    console.error(`[${options.id}] Fatal: identity RPC unreachable —`, maskSecret((err as Error).message));
    process.exit(1);
  }
  if (!agentId) {
    await retryWithBackoff(
      async () => {
        agentId = await identity.register(seller, `ipfs://${options.id}.json`);
      },
      { maxAttempts: 4, baseDelayMs: 2000, label: options.id },
    );
    console.log(`[${options.id}] Registered as agent #${agentId}`);
  } else {
    console.log(`[${options.id}] Already agent #${agentId}`);
  }

  const registryUrl = (process.env.REGISTRY_URL ?? "http://localhost:4500").replace(/\/+$/, "");
  const registryApiKey = process.env.REGISTRY_API_KEY?.trim();
  await startHeartbeat(options.id, registryUrl, {
    apiKey: registryApiKey,
    maxAttempts: 6,
    baseDelayMs: 2000,
  });

  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    console.log(`[${options.id}] → ${req.method} ${req.path}`, maskSecret(JSON.stringify(req.body)));
    res.on("finish", () => console.log(`[${options.id}] ← ${res.statusCode}`));
    next();
  });

  app.get("/", (_req, res) =>
    res.json(JSON.parse(fs.readFileSync(path.join(options.agentDir, "agent.json"), "utf8"))),
  );

  /**
   * GET /health — liveness probe for monitoring and the agent registry.
   *
   * Returns a 200 with a JSON body so the registry (and any external
   * health-check tool) can distinguish "healthy and idle" from "crashed".
   *
   * Response fields:
   *   status      — always "ok" when the process is running
   *   agentId     — human-readable seller ID (e.g. "seller-webbuilder")
   *   onChainId   — numeric on-chain agent ID assigned at registration
   *   uptime      — process uptime in seconds
   *   timestamp   — ISO-8601 UTC timestamp of this response
   */
  app.get("/health", (_req, res) =>
    res.json({
      status: "ok",
      agentId: options.id,
      onChainId: agentId !== null ? agentId!.toString() : null,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    }),
  );

  return { app, seller, agentId: agentId, cfg };
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options?: { maxAttempts?: number; baseDelayMs?: number; label?: string },
): Promise<T> {
  const { maxAttempts = 5, baseDelayMs = 1000, label = "" } = options ?? {};
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 200;
      const prefix = label ? `[${label}] ` : "";
      console.error(
        `${prefix}attempt ${attempt}/${maxAttempts} failed, retrying in ${Math.round(delay)}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

/**
 * Wraps an LLM API call with exponential backoff and jitter, retrying on
 * transient HTTP 429 (Rate Limit) and 5xx (Server Error) responses.
 *
 * - Respects the `Retry-After` header when present (Groq / OpenAI return it
 *   on 429 responses).
 * - Falls back to exponential backoff with jitter when no header is present.
 * - Logs a warning on every retry attempt so operators can spot saturation.
 * - Only surfaces the error to the caller after all retries are exhausted.
 *
 * @param fn        Async factory that performs one LLM API call.
 * @param maxRetries Maximum number of additional attempts after the first failure (default 3).
 * @param label     Optional agent/context label for log prefixes.
 *
 * Closes #587.
 */
export async function callLlmWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  label = "",
): Promise<T> {
  const prefix = label ? `[${label}] ` : "";
  const maxAttempts = maxRetries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (attempt === maxAttempts) throw err;

      // Determine whether this is a retryable error.
      // Groq SDK and raw fetch both surface status codes differently.
      const status = (err as { status?: number; statusCode?: number }).status
        ?? (err as { status?: number; statusCode?: number }).statusCode
        ?? 0;
      const message = (err as Error).message ?? "";
      const isRateLimited = status === 429 || /rate.?limit/i.test(message);
      const isServerError = status >= 500 || /overloaded|service.?unavailable/i.test(message);

      if (!isRateLimited && !isServerError) {
        // Non-transient error — fail immediately, do not retry.
        throw err;
      }

      // Honour Retry-After header if the SDK surfaces it.
      const retryAfterSec = (err as { headers?: Record<string, string> }).headers?.["retry-after"];
      const retryAfterMs = retryAfterSec ? parseFloat(retryAfterSec) * 1000 : NaN;
      const backoffMs = baseDelayFromAttempt(attempt);
      const delayMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? retryAfterMs
        : backoffMs;

      console.warn(
        `${prefix}LLM attempt ${attempt}/${maxAttempts} failed (HTTP ${status || "?"}): ` +
        `${message.slice(0, 120)} — retrying in ${Math.round(delayMs)}ms`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("unreachable");
}

/** Exponential backoff with full jitter: delay = rand(0, base * 2^(attempt-1)), capped at 30s. */
function baseDelayFromAttempt(attempt: number): number {
  const cap = 30_000;
  const base = 1_000;
  const ceiling = Math.min(cap, base * Math.pow(2, attempt - 1));
  return Math.random() * ceiling;
}

export async function startHeartbeat(
  agentId: string,
  registryUrl: string,
  options?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    intervalMs?: number;
    apiKey?: string;
  },
) {
  const { maxAttempts = 6, baseDelayMs = 2000, intervalMs = 60_000, apiKey } = options ?? {};

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  async function sendHeartbeat(): Promise<void> {
    const res = await fetch(`${registryUrl}/heartbeat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agentId }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`heartbeat failed (${res.status}): ${text}`);
    }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await sendHeartbeat();
      console.log(`[${agentId}] Heartbeat established with ${registryUrl}`);
      break;
    } catch (err) {
      const message = maskSecret(err instanceof Error ? err.message : String(err));
      if (attempt === maxAttempts) {
        console.warn(
          `[${agentId}] Heartbeat startup failed after ${maxAttempts} attempts: ${message}`,
        );
      } else {
        const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 200;
        console.warn(
          `[${agentId}] Heartbeat attempt ${attempt}/${maxAttempts} failed: ${message}. Retrying in ${Math.round(delay)}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  setInterval(async () => {
    try {
      await sendHeartbeat();
    } catch (err) {
      const message = maskSecret(err instanceof Error ? err.message : String(err));
      console.warn(`[${agentId}] Heartbeat retry failed: ${message}`);
    }
  }, intervalMs);
}
