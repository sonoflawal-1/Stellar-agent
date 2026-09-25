import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = isProduction
  ? pino({ level: process.env.LOG_LEVEL || "info" })
  : pino({
      level: process.env.LOG_LEVEL || "info",
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      },
    });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(__dirname, "..");
const PORT = 4500;

const MISSED_BEATS_LIMIT = 3;
const HEARTBEAT_INTERVAL_MS = 60_000;
const HEARTBEAT_TIMEOUT_MS = MISSED_BEATS_LIMIT * HEARTBEAT_INTERVAL_MS;
const AGENT_LIST_RATE_LIMIT = 60;
const AGENT_LIST_RATE_WINDOW_MS = 60_000;
const REGISTRY_API_KEY = process.env.REGISTRY_API_KEY?.trim();
const agentListRequestCounts = new Map<string, { count: number; resetAt: number }>();

export type AgentEntry = {
  lastHeartbeat: number;
  manifest: Record<string, unknown>;
  /** Capability tags extracted from the manifest and normalised to lowercase. */
  tags: string[];
};

export const activeAgents = new Map<string, AgentEntry>();

// JSON schema for agent manifests — closes #66
const REQUIRED_STRING_FIELDS = ["id", "name", "description", "url"] as const;

export function validateManifest(m: unknown): string | null {
  if (typeof m !== "object" || m === null || Array.isArray(m))
    return "manifest must be a JSON object";
  const obj = m as Record<string, unknown>;
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof obj[field] !== "string" || !(obj[field] as string).trim()) {
      return `field "${field}" must be a non-empty string`;
    }
  }
  if (!/^https?:\/\/.+/.test(obj.url as string))
    return 'field "url" must be a valid HTTP/HTTPS URL';
  if (typeof obj.price_usdc !== "number" || obj.price_usdc <= 0)
    return 'field "price_usdc" must be a positive number';
  if (typeof obj.wallet !== "string" || !(obj.wallet as string).trim())
    return 'field "wallet" must be a non-empty string';
  if (!/^G[A-Z2-7]{55}$/.test(obj.wallet as string))
    return 'field "wallet" must be a valid Stellar public key (starts with G, 56 chars)';
  // `tags` is optional but must be an array of strings conforming to taxonomy
  if (obj.tags !== undefined) {
    if (!Array.isArray(obj.tags) || obj.tags.some((t) => typeof t !== "string")) {
      return 'field "tags" must be an array of strings';
    }
    const tagError = validateTags(obj.tags as string[]);
    if (tagError) {
      return tagError;
    }
  }
  return null;
}

export function extractTags(manifest: Record<string, unknown>): string[] {
  if (Array.isArray(manifest.tags) && manifest.tags.length > 0) {
    return [
      ...new Set((manifest.tags as string[]).map((t) => t.toLowerCase().trim()).filter(Boolean)),
    ];
  }
  // Fall back to tasks as implicit tags
  if (Array.isArray(manifest.tasks)) {
    return [
      ...new Set((manifest.tasks as string[]).map((t) => t.toLowerCase().trim()).filter(Boolean)),
    ];
  }
  return [];
}

export const app = express();
app.use(express.json());

// Structured HTTP access logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  const ip = getRequestKey(req);
  res.on("finish", () => {
    const latency = Date.now() - start;
    logger.info(
      {
        method: req.method,
        url: req.originalUrl || req.url,
        statusCode: res.statusCode,
        ip,
        latency,
      },
      `${req.method} ${req.originalUrl || req.url} ${res.statusCode} (${latency}ms)`
    );
  });
  next();
});

function parseManifestFile(manifestPath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    logger.warn(
      { manifestPath, err: (err as Error).message },
      `[registry] Skipping ${manifestPath}: invalid JSON`
    );
    return null;
  }
}

function loadManifests() {
  return fs
    .readdirSync(AGENTS_DIR)
    .filter((d) => d.startsWith("seller-"))
    .map((d) => {
      const manifestPath = path.join(AGENTS_DIR, d, "agent.json");
      if (!fs.existsSync(manifestPath)) return null;
      const manifest = parseManifestFile(manifestPath);
      if (!manifest) return null;
      const schemaError = validateManifest(manifest);
      if (schemaError) {
        logger.warn(
          { manifestPath, schemaError },
          `[registry] Skipping ${manifestPath}: ${schemaError}`
        );
        return null;
      }
      return manifest;
    })
    .filter(Boolean);
}

function loadManifest(agentId: string): Record<string, unknown> | null {
  for (const dir of fs.readdirSync(AGENTS_DIR)) {
    if (!dir.startsWith("seller-")) continue;
    const manifestPath = path.join(AGENTS_DIR, dir, "agent.json");
    if (!fs.existsSync(manifestPath)) continue;
    const m = parseManifestFile(manifestPath);
    if (m && m.id === agentId) return m;
  }
  return null;
}

function getRequestKey(req: any) {
  return (
    req.ip ||
    String(req.headers["x-forwarded-for"] ?? "")
      .split(",")[0]
      .trim() ||
    "unknown"
  );
}

const API_KEY = process.env.REGISTRY_API_KEY || "dev-registry-key";

function requireApiKey(req: any, res: any, next: any) {
  const key = req.headers["x-api-key"];
  if (!key || key !== API_KEY) {
    logger.warn({ ip: getRequestKey(req) }, "Authentication failed: invalid or missing x-api-key");
    return res.status(401).json({ error: "Unauthorized: valid API key required" });
  }
  next();
}

function requireRegistryAuth(req: any, res: any, next: any) {
  if (!REGISTRY_API_KEY) return next();
  const auth = String(req.headers.authorization ?? "").trim();
  if (auth === `Bearer ${REGISTRY_API_KEY}`) return next();
  logger.warn({ ip: getRequestKey(req) }, "Authorization failed: invalid registry bearer token");
  return res.status(401).json({ error: "unauthorized" });
}

function rateLimitAgentList(req: any, res: any, next: any) {
  const key = getRequestKey(req);
  const now = Date.now();
  for (const [ip, bucket] of agentListRequestCounts.entries()) {
    if (now >= bucket.resetAt) {
      agentListRequestCounts.delete(ip);
    }
  }
  const existing = agentListRequestCounts.get(key);
  if (!existing || now >= existing.resetAt) {
    agentListRequestCounts.set(key, { count: 1, resetAt: now + AGENT_LIST_RATE_WINDOW_MS });
    return next();
  }
  if (existing.count >= AGENT_LIST_RATE_LIMIT) {
    logger.warn({ ip: key, count: existing.count }, "Rate limit exceeded for agent list");
    return res.status(429).json({ error: "rate limit exceeded" });
  }
  existing.count += 1;
  return next();
}

function getAliveAgents(): Record<string, unknown>[] {
  const now = Date.now();
  const alive: Record<string, unknown>[] = [];
  for (const entry of activeAgents.values()) {
    if (now - entry.lastHeartbeat < HEARTBEAT_TIMEOUT_MS) {
      alive.push({ ...entry.manifest, tags: entry.tags, alive: true });
    }
  }
  return alive;
}

function getAllAgentsWithStatus(): Record<string, unknown>[] {
  const now = Date.now();
  return loadManifests().map((m) => {
    const id = (m as Record<string, unknown>).id as string | undefined;
    const entry = id ? activeAgents.get(id) : undefined;
    const alive = entry !== undefined && now - entry.lastHeartbeat < HEARTBEAT_TIMEOUT_MS;
    const tags = entry ? entry.tags : extractTags(m as Record<string, unknown>);
    return { ...m, tags, alive };
  });
}

function isAlive(agentId: string): boolean {
  const entry = activeAgents.get(agentId);
  return entry !== undefined && Date.now() - entry.lastHeartbeat < HEARTBEAT_TIMEOUT_MS;
}

app.post("/heartbeat", requireApiKey, requireRegistryAuth, (req, res) => {
  const { agentId } = req.body;
  const ip = getRequestKey(req);
  if (!agentId) {
    logger.warn({ ip }, "Heartbeat rejected: missing agentId");
    return res.status(400).json({ error: "missing agentId" });
  }

  const manifest = loadManifest(agentId);
  if (!manifest) {
    logger.warn({ agentId, ip }, "Heartbeat rejected: agent manifest not found");
    return res.status(404).json({ error: "agent manifest not found" });
  }

  const schemaError = validateManifest(manifest);
  if (schemaError) {
    logger.warn({ agentId, schemaError, ip }, `Heartbeat rejected: invalid manifest: ${schemaError}`);
    return res.status(422).json({ error: `invalid manifest: ${schemaError}` });
  }

  activeAgents.set(agentId, { lastHeartbeat: Date.now(), manifest, tags: extractTags(manifest) });
  logger.info({ agentId, ip }, `[registry] Heartbeat received from ${agentId}`);
  res.json({ status: "ok", agentId, tags: extractTags(manifest) });
});

export interface AgentReputation {
  total_jobs: number;
  completed_jobs: number;
  disputed_jobs: number;
  success_rate: string;
}

export const reputationOverrides = new Map<string, Array<{ status: string | number }>>();

export const agentic_commerce = {
  async jobs_by_provider(wallet: string): Promise<Array<{ status: string | number }>> {
    if (!wallet) return [];
    if (reputationOverrides.has(wallet)) {
      return reputationOverrides.get(wallet)!;
    }
    const contractAddress = process.env.AGENTIC_COMMERCE_CONTRACT;
    if (!contractAddress) return [];
    try {
      const { CommerceClient, TESTNET } = await import("marc-stellar-sdk");
      const rpcUrl = process.env.STELLAR_RPC_URL ?? TESTNET.rpcUrl;
      const networkPassphrase = process.env.STELLAR_NETWORK_PASSPHRASE ?? TESTNET.networkPassphrase;
      const commerce = new CommerceClient({
        rpcUrl,
        networkPassphrase,
        identityContract: process.env.AGENT_IDENTITY_CONTRACT || TESTNET.identityContract,
        commerceContract: contractAddress,
        usdcToken: process.env.USDC_TOKEN_CONTRACT || TESTNET.usdcToken,
      });
      return await commerce.jobsByProvider(wallet);
    } catch (err) {
      logger.warn({ wallet, err: (err as Error).message }, "[registry] Failed to fetch on-chain jobs for agent");
      return [];
    }
  },
};

export function calculateReputation(jobs: Array<{ status: string | number }>): AgentReputation {
  const total_jobs = jobs.length;
  if (total_jobs === 0) {
    return {
      total_jobs: 0,
      completed_jobs: 0,
      disputed_jobs: 0,
      success_rate: "N/A",
    };
  }

  const completed_jobs = jobs.filter((j) => {
    const s = typeof j.status === "string" ? j.status.toLowerCase() : j.status;
    return s === "completed" || s === 3;
  }).length;

  const disputed_jobs = jobs.filter((j) => {
    const s = typeof j.status === "string" ? j.status.toLowerCase() : j.status;
    return s === "disputed" || s === 6;
  }).length;

  const rate = (completed_jobs / total_jobs) * 100;
  const formattedRate = Number.isInteger(rate) ? `${rate}%` : `${rate.toFixed(1)}%`;

  return {
    total_jobs,
    completed_jobs,
    disputed_jobs,
    success_rate: formattedRate,
  };
}

function filterByTags(
  agents: Record<string, unknown>[],
  rawTags: string,
): Record<string, unknown>[] {
  const tags = rawTags
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tags.length === 0) return agents;
  return agents.filter((a) => {
    const agentTags = Array.isArray(a.tags) ? (a.tags as string[]).map((t) => t.toLowerCase()) : [];
    return tags.every((t) => agentTags.includes(t));
  });
}

app.get("/agents", async (req, res) => {
  let result: Record<string, unknown>[];
  if (req.query.include_inactive === "true") {
    result = getAllAgentsWithStatus();
  } else {
    result = getAliveAgents();
  }
  if (typeof req.query.tags === "string" && req.query.tags) {
    result = filterByTags(result, req.query.tags);
  }

  // Parse and validate price range filters (min_price, max_price)
  let minPrice: number | undefined;
  if (req.query.min_price !== undefined) {
    const raw = String(req.query.min_price).trim();
    const val = Number(raw);
    if (!raw || isNaN(val) || val < 0) {
      return res.status(400).json({ error: "min_price must be a positive number" });
    }
    minPrice = val;
  }

  let maxPrice: number | undefined;
  if (req.query.max_price !== undefined) {
    const raw = String(req.query.max_price).trim();
    const val = Number(raw);
    if (!raw || isNaN(val) || val < 0) {
      return res.status(400).json({ error: "max_price must be a positive number" });
    }
    maxPrice = val;
  }

  if (minPrice !== undefined) {
    result = result.filter((a) => typeof a.price_usdc === "number" && a.price_usdc >= minPrice!);
  }
  if (maxPrice !== undefined) {
    result = result.filter((a) => typeof a.price_usdc === "number" && a.price_usdc <= maxPrice!);
  }

  // Query agentic_commerce and attach reputation metrics
  const agentsWithReputation = await Promise.all(
    result.map(async (agent) => {
      const wallet = typeof agent.wallet === "string" ? agent.wallet : "";
      try {
        const jobs = await agentic_commerce.jobs_by_provider(wallet);
        return {
          ...agent,
          reputation: calculateReputation(jobs),
        };
      } catch {
        return {
          ...agent,
          reputation: {
            total_jobs: 0,
            completed_jobs: 0,
            disputed_jobs: 0,
            success_rate: "N/A",
          },
        };
      }
    }),
  );

  return res.json(agentsWithReputation);
});

app.get("/agents/:id", rateLimitAgentList, async (req, res) => {
  const manifest = isAlive(req.params.id) ? activeAgents.get(req.params.id)!.manifest : null;
  if (!manifest) return res.status(404).json({ error: "agent not found or not alive" });
  const wallet = typeof manifest.wallet === "string" ? manifest.wallet : "";
  let reputation: AgentReputation;
  try {
    const jobs = await agentic_commerce.jobs_by_provider(wallet);
    reputation = calculateReputation(jobs);
  } catch {
    reputation = {
      total_jobs: 0,
      completed_jobs: 0,
      disputed_jobs: 0,
      success_rate: "N/A",
    };
  }
  res.json({ ...manifest, reputation });
});

app.delete("/agents/:id", (req, res) => {
  const { id } = req.params;
  const ip = getRequestKey(req);
  if (!activeAgents.has(id)) {
    logger.warn({ agentId: id, ip }, `[registry] Deregister failed: agent ${id} not found`);
    return res.status(404).json({ error: "agent not found" });
  }
  activeAgents.delete(id);
  logger.info({ agentId: id, ip }, `[registry] Manually deregistered agent: ${id}`);
  res.json({ status: "ok", agentId: id });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    registered: activeAgents.size,
    alive: getAliveAgents().length,
    timeoutSec: HEARTBEAT_TIMEOUT_MS / 1000,
  });
});

const isDirectExecution =
  process.argv[1] &&
  (path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) ||
   process.argv[1].endsWith("server.ts") ||
   process.argv[1].endsWith("server.js"));

if (isDirectExecution) {
  setInterval(() => {
    const now = Date.now();
    let removed = 0;
    for (const [id, entry] of activeAgents) {
      if (now - entry.lastHeartbeat >= HEARTBEAT_TIMEOUT_MS) {
        activeAgents.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      logger.info({ removedCount: removed }, `[registry] Deregistered ${removed} stale agent(s)`);
    }
  }, HEARTBEAT_INTERVAL_MS);

  app.listen(PORT, "127.0.0.1", () => {
    logger.info(
      { port: PORT, url: `http://localhost:${PORT}/agents` },
      `Agent registry running at http://localhost:${PORT}/agents`
    );
    logger.info(
      {
        heartbeatTimeoutSec: HEARTBEAT_TIMEOUT_MS / 1000,
        missedBeatsLimit: MISSED_BEATS_LIMIT,
      },
      `Heartbeat timeout: ${HEARTBEAT_TIMEOUT_MS / 1000}s (${MISSED_BEATS_LIMIT} missed)`
    );
  });
}
