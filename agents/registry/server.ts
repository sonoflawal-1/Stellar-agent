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
  /** Capability tags extracted from the manifest and normalised to lowercase. */
  tags: string[];
};

const activeAgents = new Map<string, AgentEntry>();

// JSON schema for agent manifests — closes #66
const REQUIRED_STRING_FIELDS = ["id", "name", "description", "url"] as const;

function validateManifest(m: unknown): string | null {
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
  // `tags` is optional but must be an array of strings when present
  if (obj.tags !== undefined) {
    if (!Array.isArray(obj.tags) || obj.tags.some((t) => typeof t !== "string")) {
      return 'field "tags" must be an array of strings';
    }
  }
  return null;
}

function extractTags(manifest: Record<string, unknown>): string[] {
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

const app = express();
app.use(express.json());

function parseManifestFile(manifestPath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    console.warn(`[registry] Skipping ${manifestPath}: invalid JSON (${(err as Error).message})`);
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
        console.warn(`[registry] Skipping ${manifestPath}: ${schemaError}`);
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
    return res.status(401).json({ error: "Unauthorized: valid API key required" });
  }
  next();
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

app.post("/heartbeat", requireApiKey, requireRegistryAuth, (req, res) => {
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

  activeAgents.set(agentId, { lastHeartbeat: Date.now(), manifest, tags: extractTags(manifest) });
  res.json({ status: "ok", agentId, tags: extractTags(manifest) });
});

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

app.get("/agents", (req, res) => {
  let result: Record<string, unknown>[];
  if (req.query.include_inactive === "true") {
    result = getAllAgentsWithStatus();
  } else {
    result = getAliveAgents();
  }
  if (typeof req.query.tags === "string" && req.query.tags) {
    result = filterByTags(result, req.query.tags);
  }
  return res.json(result);
});

app.get("/agents/:id", rateLimitAgentList, (req, res) => {
  const manifest = isAlive(req.params.id) ? activeAgents.get(req.params.id)!.manifest : null;
  if (!manifest) return res.status(404).json({ error: "agent not found or not alive" });
  res.json(manifest);
});

app.delete("/agents/:id", (req, res) => {
  const { id } = req.params;
  if (!activeAgents.has(id)) {
    return res.status(404).json({ error: "agent not found" });
  }
  activeAgents.delete(id);
  console.log(`[registry] Manually deregistered agent: ${id}`);
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

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Agent registry running at http://localhost:${PORT}/agents`);
  console.log(`Heartbeat timeout: ${HEARTBEAT_TIMEOUT_MS / 1000}s (${MISSED_BEATS_LIMIT} missed)`);
});
