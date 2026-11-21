import { IdentityClient, CommerceClient } from "marc-stellar-sdk";
import type { Agent, Job } from "marc-stellar-sdk";
import { cfg } from "./config.js";
import EventEmitter from "events";
import { createHash } from "crypto";

const identity = new IdentityClient(cfg);
const commerce = new CommerceClient(cfg);

// In-memory caches with TTL
let agentCache: { data: Agent[]; ts: number } = { data: [], ts: 0 };
let jobCache: { data: Job[]; ts: number } = { data: [], ts: 0 };
const CACHE_TTL = 3_000; // 3s — fast refresh for demo

// Contract-level caches (longer TTL — 30s)
let feeBpsCache: { value: number | null; ts: number } = { value: null, ts: 0 };
let versionCache: { value: number | null; ts: number } = { value: null, ts: 0 };
const CONTRACT_CACHE_TTL = 30_000; // 30s TTL for RPC getters like feeBps()/version()
const DEFAULT_AGENT_PAGE_SIZE = 24;

// Event emitter used to notify server of invalidations for SSE
export const events = new EventEmitter();

const MAX_DISCOVERY_PROBE_ID = Number(process.env.MAX_DISCOVERY_PROBE_ID ?? 1_000_000);

/** Find the max existing ID via exponential probe + binary search */
async function findMaxId(getter: (id: bigint) => Promise<unknown | null>): Promise<number> {
  // Exponential probe
  let probe = 1;
  while (probe <= MAX_DISCOVERY_PROBE_ID) {
    const result = await getter(BigInt(probe));
    if (result === null) break;
    probe = Math.min(probe * 2, MAX_DISCOVERY_PROBE_ID + 1);
  }
  // Binary search between probe/2 and probe
  let lo = Math.floor(probe / 2);
  let hi = Math.min(probe, MAX_DISCOVERY_PROBE_ID);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const result = await getter(BigInt(mid));
    if (result !== null) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  // Verify lo actually exists
  if (lo >= 1) {
    const check = await getter(BigInt(lo));
    if (check === null) return 0;
  }
  return lo;
}

/** Fetch all items 1..max in parallel batches */
async function fetchAll<T>(maxId: number, getter: (id: bigint) => Promise<T | null>): Promise<T[]> {
  return fetchRange(1, maxId, getter);
}

/** Fetch an inclusive id range in bounded parallel batches. */
async function fetchRange<T>(
  startId: number,
  endId: number,
  getter: (id: bigint) => Promise<T | null>,
): Promise<T[]> {
  const BATCH = 10;
  const results: T[] = [];
  for (let start = startId; start <= endId; start += BATCH) {
    const end = Math.min(start + BATCH - 1, endId);
    const batch = [];
    for (let i = start; i <= end; i++) {
      batch.push(getter(BigInt(i)));
    }
    const items = await Promise.all(batch);
    for (const item of items) {
      if (item !== null) results.push(item);
    }
  }
  return results;
}

export async function getAllAgents(force = false): Promise<Agent[]> {
  if (!force && Date.now() - agentCache.ts < CACHE_TTL) return agentCache.data;
  const max = await getRegisteredAgentCount();
  const agents = await fetchAll(max, (id) => identity.getAgent(id));
  agentCache = { data: agents, ts: Date.now() };
  return agents;
}

export async function getAgentsPage(
  page = 1,
  pageSize = DEFAULT_AGENT_PAGE_SIZE,
): Promise<{ items: Agent[]; page: number; pageSize: number; total: number; hasNext: boolean }> {
  const max = await getRegisteredAgentCount();
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(start + pageSize - 1, max);
  const items =
    start <= max
      ? await fetchAll(end - start + 1, (id) => identity.getAgent(id + BigInt(start - 1)))
      : [];
  return { items, page, pageSize, total: max, hasNext: end < max };
}

export async function getAllJobs(force = false): Promise<Job[]> {
  if (!force && Date.now() - jobCache.ts < CACHE_TTL) return jobCache.data;
  const max = await getJobCount();
  const jobs = await fetchAll(max, (id) => commerce.getJob(id));
  jobCache = { data: jobs, ts: Date.now() };
  return jobs;
}

export async function getJobsPage(
  page = 1,
  pageSize = DEFAULT_AGENT_PAGE_SIZE,
): Promise<{ items: Job[]; page: number; pageSize: number; total: number; hasNext: boolean }> {
  const total = await getJobCount();
  const endId = total - (page - 1) * pageSize;
  const startId = Math.max(endId - pageSize + 1, 1);
  const items =
    endId >= 1
      ? await fetchRange(startId, endId, (id) => commerce.getJob(id))
      : [];
  return { items, page, pageSize, total, hasNext: startId > 1 };
}

async function getRegisteredAgentCount(): Promise<number> {
  try {
    return await identity.registeredCount();
  } catch {
    return findMaxId((id) => identity.getAgent(id));
  }
}

async function getJobCount(): Promise<number> {
  try {
    return Number(await commerce.jobCount());
  } catch {
    return findMaxId((id) => commerce.getJob(id));
  }
}

export function invalidateAgents() {
  agentCache.ts = 0;
  events.emit("invalidate", { type: "agents" });
}
export function invalidateJobs() {
  jobCache.ts = 0;
  events.emit("invalidate", { type: "jobs" });
}

/** Cached getter for commerce.feeBps() with 30s TTL */
export async function getFeeBps(force = false): Promise<number> {
  if (!force && feeBpsCache.value !== null && Date.now() - feeBpsCache.ts < CONTRACT_CACHE_TTL) {
    return feeBpsCache.value as number;
  }
  const v = await commerce.feeBps();
  feeBpsCache = { value: v, ts: Date.now() };
  return v;
}

/** Cached getter for contract version (identity.version() example) */
export async function getVersion(force = false): Promise<number> {
  if (!force && versionCache.value !== null && Date.now() - versionCache.ts < CONTRACT_CACHE_TTL) {
    return versionCache.value as number;
  }
  const v = await commerce.feeBps();
  versionCache = { value: v, ts: Date.now() };
  return v;
}

/** Invalidate cached agent vectors when the agent set changes. */
events.on("invalidate", (payload: { type?: string }) => {
  if (payload?.type === "agents") clearVectorIndex();
});

export { identity, commerce };

// ---------------------------------------------------------------------------
// Semantic matchmaking engine
// ---------------------------------------------------------------------------

export const EMBEDDING_DIM = 384;

export interface AgentMatch {
  agent: Agent;
  score: number;
}

export interface MatchOptions {
  query: string;
  topK?: number;
  /** Force lexical fallback regardless of embedding availability. */
  lexicalOnly?: boolean;
}

/** Deterministic, dependency-free 384-dim embedding of arbitrary text. */
export function embedText(text: string): Float32Array {
  const vec = new Float32Array(EMBEDDING_DIM);
  const tokens = tokenize(text);
  if (tokens.length === 0) return vec;
  for (const token of tokens) {
    const digest = createHash("sha256").update(token).digest();
    // Use two independent hashes per token to reduce collisions.
    for (let h = 0; h < 2; h++) {
      const idx = digest.readUInt32BE(h * 4) % EMBEDDING_DIM;
      const sign = digest[h * 4 + 8] & 1 ? 1 : -1;
      vec[idx] += sign * (1 / Math.sqrt(tokens.length));
    }
  }
  return normalize(vec);
}

function tokenize(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Build the text used to embed an agent's metadata. */
export function agentEmbeddingText(agent: Agent): string {
  const parts: string[] = [];
  const anyAgent = agent as unknown as Record<string, unknown>;
  for (const key of ["name", "description", "capabilities", "skills", "tags", "category"]) {
    const value = anyAgent[key];
    if (typeof value === "string" && value.trim()) parts.push(value);
    else if (Array.isArray(value)) parts.push(value.filter((v) => typeof v === "string").join(" "));
  }
  return parts.join(" ").trim();
}

interface VectorEntry {
  id: string;
  vector: Float32Array;
  text: string;
}

/**
 * Bounded, hash-keyed LRU cache of agent embeddings.
 *
 * Keyed by a hash of the agent's embedding text so that unchanged metadata
 * reuses the cached vector across requests. The cache is capped at
 * EMBEDDING_CACHE_MAX entries (and thus a bounded amount of memory) to keep
 * the vector search from growing without limit. See #965.
 */
const EMBEDDING_CACHE_MAX = Number(process.env.EMBEDDING_CACHE_MAX ?? 5_000);
const vectorIndex = new Map<string, VectorEntry>();

function agentKey(agent: Agent): string {
  const anyAgent = agent as unknown as Record<string, unknown>;
  return String(anyAgent.id ?? anyAgent.address ?? anyAgent.name ?? "");
}

/** Hash of the agent's embedding text — the cache key for its vector. */
function metadataHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Insert into the LRU cache, evicting the oldest entry when over capacity. */
function cacheSet(key: string, entry: VectorEntry): void {
  if (vectorIndex.has(key)) vectorIndex.delete(key);
  vectorIndex.set(key, entry);
  while (vectorIndex.size > EMBEDDING_CACHE_MAX) {
    const oldest = vectorIndex.keys().next().value;
    if (oldest === undefined) break;
    vectorIndex.delete(oldest);
  }
}

/** Get a cached vector, refreshing its LRU recency. */
function cacheGet(key: string): VectorEntry | undefined {
  const entry = vectorIndex.get(key);
  if (entry) {
    vectorIndex.delete(key);
    vectorIndex.set(key, entry);
  }
  return entry;
}

/** Index (or re-index) a set of agents into the bounded vector cache. */
export function indexAgents(agents: Agent[]): void {
  for (const agent of agents) {
    const key = agentKey(agent);
    if (!key) continue;
    const text = agentEmbeddingText(agent);
    const hash = metadataHash(text);
    if (cacheGet(hash)) continue;
    cacheSet(hash, { id: key, vector: embedText(text), text });
  }
}

export function clearVectorIndex(): void {
  vectorIndex.clear();
}

export function vectorIndexSize(): number {
  return vectorIndex.size;
}

/** Maximum number of cached embeddings (memory ceiling). */
export function vectorIndexCapacity(): number {
  return EMBEDDING_CACHE_MAX;
}

/**
 * Readiness probe for the embedding model.
 *
 * The deterministic embedder is always available, so this reports readiness
 * synchronously and lets callers measure warm vs cold latency. When
 * embeddings are disabled it reports `ready: false`.
 */
export function embeddingsReady(): { ready: boolean; enabled: boolean; cached: number; capacity: number } {
  return {
    ready: cfg.embeddingsEnabled,
    enabled: cfg.embeddingsEnabled,
    cached: vectorIndex.size,
    capacity: EMBEDDING_CACHE_MAX,
  };
}

function lexicalScore(query: string, agent: Agent): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const haystack = agentEmbeddingText(agent).toLowerCase();
  if (!haystack) return 0;
  const qTokens = tokenize(q);
  if (qTokens.length === 0) return haystack.includes(q) ? 1 : 0;
  let hits = 0;
  for (const token of qTokens) if (haystack.includes(token)) hits++;
  return hits / qTokens.length;
}

function rankByCosine(queryVec: Float32Array, agents: Agent[], topK: number): AgentMatch[] {
  const scored: AgentMatch[] = [];
  for (const agent of agents) {
    const text = agentEmbeddingText(agent);
    const hash = metadataHash(text);
    let entry = cacheGet(hash);
    if (!entry) {
      entry = { id: agentKey(agent), vector: embedText(text), text };
      cacheSet(hash, entry);
    }
    scored.push({ agent, score: cosineSimilarity(queryVec, entry.vector) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

function rankLexical(query: string, agents: Agent[], topK: number): AgentMatch[] {
  const scored: AgentMatch[] = agents.map((agent) => ({ agent, score: lexicalScore(query, agent) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Match agents against a natural-language query.
 * Uses cosine similarity over embeddings when enabled, otherwise falls back
 * to lexical scoring.
 */
export async function matchAgents(opts: MatchOptions): Promise<AgentMatch[]> {
  const topK = Math.max(1, Math.min(opts.topK ?? 10, 100));
  const agents = await getAllAgents();
  const useEmbeddings = cfg.embeddingsEnabled && !opts.lexicalOnly;

  if (!useEmbeddings) {
    return rankLexical(opts.query, agents, topK);
  }

  // Warm the bounded embedding cache for the current agent set, then rank.
  indexAgents(agents);
  const queryVec = embedText(opts.query);
  return rankByCosine(queryVec, agents, topK);
}
