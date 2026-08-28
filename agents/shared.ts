import fs from "node:fs";
import path from "node:path";
import express from "express";
import { Keypair } from "@stellar/stellar-sdk";
import { IdentityClient, TESTNET, type MarcConfig } from "marc-stellar-sdk";

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
    console.error(`[${options.id}] Fatal: identity RPC unreachable —`, (err as Error).message);
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
    console.log(`[${options.id}] → ${req.method} ${req.path}`, JSON.stringify(req.body));
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
      const message = err instanceof Error ? err.message : String(err);
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
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[${agentId}] Heartbeat retry failed: ${message}`);
    }
  }, intervalMs);
}
