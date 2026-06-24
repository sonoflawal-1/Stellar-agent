/**
 * Agent Registry — localhost only
 * Serves agent.json manifests so the buyer can discover available sellers.
 * Tracks agent liveness via heartbeat — dead agents auto-deregister.
 *
 * GET  /agents              → list alive agents (heartbeating)
 * GET  /agents?include_inactive=true → list all agents including deregistered
 * GET  /agents/:id     → get a specific agent manifest
 * POST /heartbeat      → agent pings with { agentId }
 * GET  /health         → registry + agent count
 */
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

type AgentEntry = {
  lastHeartbeat: number;
  manifest: Record<string, unknown>;
};

const activeAgents = new Map<string, AgentEntry>();

// JSON schema for agent manifests — closes #66
const REQUIRED_STRING_FIELDS = ["id", "name", "description", "url"] as const;

function validateManifest(m: unknown): string | null {
  if (typeof m !== "object" || m === null || Array.isArray(m)) return "manifest must be a JSON object";
  const obj = m as Record<string, unknown>;
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof obj[field] !== "string" || !(obj[field] as string).trim()) {
      return `field "${field}" must be a non-empty string`;
    }
  }
  if (typeof obj.price_usdc !== "number" || obj.price_usdc <= 0) return 'field "price_usdc" must be a positive number';
  if (typeof obj.wallet !== "string" || !(obj.wallet as string).trim()) return 'field "wallet" must be a non-empty string';
  return null;
}

const app = express();
app.use(express.json());

function loadManifests() {
  return fs
    .readdirSync(AGENTS_DIR)
    .filter((d) => d.startsWith("seller-"))
    .map((d) => {
      const manifestPath = path.join(AGENTS_DIR, d, "agent.json");
      if (!fs.existsSync(manifestPath)) return null;
      return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    })
    .filter(Boolean);
}

function loadManifest(agentId: string): Record<string, unknown> | null {
  for (const dir of fs.readdirSync(AGENTS_DIR)) {
    if (!dir.startsWith("seller-")) continue;
    const manifestPath = path.join(AGENTS_DIR, dir, "agent.json");
    if (!fs.existsSync(manifestPath)) continue;
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (m.id === agentId) return m;
  }
  return null;
}

function getRequestKey(req: any) {
  return (
    req.ip ||
    String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() ||
    "unknown"
  );
}

function requireRegistryAuth(req: any, res: any, next: any) {
  if (!REGISTRY_API_KEY) return next();
  const auth = String(req.headers.authorization ?? "").trim();
  if (auth === `Bearer ${REGISTRY_API_KEY}`) return next();
  return res.status(401).json({ error: "unauthorized" });
}

function rateLimitAgentList(req: any, res: any, next: any) {
  const key = getRequestKey(req);
  const now = Date.now();
  const existing = agentListRequestCounts.get(key);
  if (!existing || now >= existing.resetAt) {
    agentListRequestCounts.set(key, { count: 1, resetAt: now + AGENT_LIST_RATE_WINDOW_MS });
    return next();
  }
  if (existing.count >= AGENT_LIST_RATE_LIMIT) {
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
      alive.push({ ...entry.manifest, alive: true });
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
    return { ...m, alive };
  });
}

function isAlive(agentId: string): boolean {
  const entry = activeAgents.get(agentId);
  return entry !== undefined && Date.now() - entry.lastHeartbeat < HEARTBEAT_TIMEOUT_MS;
}

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
    console.log(`[registry] Deregistered ${removed} stale agent(s)`);
  }
}, HEARTBEAT_INTERVAL_MS);

app.post("/heartbeat", requireRegistryAuth, (req, res) => {
  const { agentId } = req.body;
  if (!agentId) {
    return res.status(400).json({ error: "missing agentId" });
  }

  const manifest = loadManifest(agentId);
  if (!manifest) {
    return res.status(404).json({ error: "agent manifest not found" });
  }

  const schemaError = validateManifest(manifest);
  if (schemaError) {
    return res.status(422).json({ error: `invalid manifest: ${schemaError}` });
  }

  activeAgents.set(agentId, { lastHeartbeat: Date.now(), manifest });
  res.json({ status: "ok", agentId });
});

app.get("/agents", rateLimitAgentList, (req, res) => {
  if (req.query.include_inactive === "true") {
    return res.json(getAllAgentsWithStatus());
  }
  return res.json(getAliveAgents());
});

app.get("/agents/:id", rateLimitAgentList, (req, res) => {
  const manifest = isAlive(req.params.id) ? activeAgents.get(req.params.id)!.manifest : null;
  if (!manifest) return res.status(404).json({ error: "agent not found or not alive" });
  res.json(manifest);
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    registered: activeAgents.size,
    alive: getAliveAgents().length,
    timeoutSec: HEARTBEAT_TIMEOUT_MS / 1000,
  });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Agent registry running at http://localhost:${PORT}/agents`);
  console.log(`Heartbeat timeout: ${HEARTBEAT_TIMEOUT_MS / 1000}s (${MISSED_BEATS_LIMIT} missed)`);
});
