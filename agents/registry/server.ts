/**
 * Agent Registry — localhost only
 * Serves agent.json manifests so the buyer can discover available sellers.
 * Tracks agent liveness via heartbeat — dead agents auto-deregister.
 *
 * GET  /agents         → list all alive agents
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

type AgentEntry = {
  lastHeartbeat: number;
  manifest: Record<string, unknown>;
};

const activeAgents = new Map<string, AgentEntry>();

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

function getAliveAgents(): Record<string, unknown>[] {
  const now = Date.now();
  const alive: Record<string, unknown>[] = [];
  for (const entry of activeAgents.values()) {
    if (now - entry.lastHeartbeat < HEARTBEAT_TIMEOUT_MS) {
      alive.push(entry.manifest);
    }
  }
  return alive;
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

app.post("/heartbeat", (req, res) => {
  const { agentId } = req.body;
  if (!agentId) {
    return res.status(400).json({ error: "missing agentId" });
  }

  const manifest = loadManifest(agentId);
  if (!manifest) {
    return res.status(404).json({ error: "agent manifest not found" });
  }

  activeAgents.set(agentId, { lastHeartbeat: Date.now(), manifest });
  res.json({ status: "ok", agentId });
});

app.get("/agents", (_req, res) => {
  const alive = getAliveAgents();
  if (alive.length > 0) {
    return res.json(alive);
  }
  const all = loadManifests();
  return res.json(all);
});

app.get("/agents/:id", (req, res) => {
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
