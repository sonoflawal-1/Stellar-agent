import { createHash } from 'crypto';

/**
 * Lazy-loaded embedding model wrapper for the dashboard.
 *
 * Resolves #965:
 *  - Lazy-loads Xenova/all-MiniLM-L6-v2 with a configurable timeout.
 *  - Caches embeddings keyed by a metadata hash using a bounded LRU cache
 *    (max entries configurable via EMBEDDING_CACHE_MAX).
 *  - Exposes readiness via isEmbeddingModelReady() / getEmbeddingReadiness().
 *  - Instruments warm vs cold latency.
 */

export const EMBEDDING_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMENSIONS = 384;

const DEFAULT_LOAD_TIMEOUT_MS = 30_000;
const DEFAULT_CACHE_MAX = 512;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function getLoadTimeoutMs(): number {
  return readPositiveIntEnv('EMBEDDING_LOAD_TIMEOUT_MS', DEFAULT_LOAD_TIMEOUT_MS);
}

export function getCacheMaxEntries(): number {
  return readPositiveIntEnv('EMBEDDING_CACHE_MAX', DEFAULT_CACHE_MAX);
}

export function isEmbeddingsEnabled(): boolean {
  const raw = process.env.EMBEDDINGS_ENABLED;
  if (raw === undefined) return false;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export type EmbeddingReadinessState = 'disabled' | 'idle' | 'loading' | 'ready' | 'error';

export interface EmbeddingReadiness {
  state: EmbeddingReadinessState;
  model: string;
  dimensions: number;
  enabled: boolean;
  /** True once the model has loaded successfully. */
  ready: boolean;
  /** True while the model is being loaded. */
  loading: boolean;
  /** Last load error message, if any. */
  error: string | null;
  /** Time taken by the most recent successful model load (ms). */
  loadDurationMs: number | null;
  /** Number of entries currently held in the embedding cache. */
  cacheSize: number;
  /** Maximum number of entries the cache may hold. */
  cacheMax: number;
  /** Cumulative cache hit / miss counters. */
  cacheHits: number;
  cacheMisses: number;
  /** Warm vs cold latency instrumentation (ms). */
  latency: {
    /** Latency of the most recent cold (cache miss) embedding computation. */
    lastColdMs: number | null;
    /** Latency of the most recent warm (cache hit) lookup. */
    lastWarmMs: number | null;
    /** Rolling average cold latency. */
    avgColdMs: number | null;
    /** Rolling average warm latency. */
    avgWarmMs: number | null;
  };
}

// ---------------------------------------------------------------------------
// Minimal typing for the Xenova transformers pipeline (avoids a hard dep).
// ---------------------------------------------------------------------------

type FeatureExtractionOutput = {
  data: Float32Array | number[];
  dims?: number[];
};

type FeatureExtractionPipeline = (
  input: string | string[],
  options?: Record<string, unknown>,
) => Promise<FeatureExtractionOutput>;

interface TransformersModule {
  pipeline: (
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ) => Promise<FeatureExtractionPipeline>;
  env?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;
let pipelineInstance: FeatureExtractionPipeline | null = null;
let loadState: EmbeddingReadinessState = 'idle';
let loadError: string | null = null;
let loadDurationMs: number | null = null;

let cacheHits = 0;
let cacheMisses = 0;
let lastColdMs: number | null = null;
let lastWarmMs: number | null = null;
let coldCount = 0;
let coldTotalMs = 0;
let warmCount = 0;
let warmTotalMs = 0;

/**
 * Bounded LRU cache. Map preserves insertion order, so the first key is the
 * least-recently-used entry. On access we delete + re-insert to refresh order.
 */
const embeddingCache = new Map<string, number[]>();

function cacheGet(key: string): number[] | undefined {
  const value = embeddingCache.get(key);
  if (value === undefined) return undefined;
  // Refresh recency.
  embeddingCache.delete(key);
  embeddingCache.set(key, value);
  return value;
}

function cacheSet(key: string, value: number[]): void {
  const max = getCacheMaxEntries();
  if (embeddingCache.has(key)) {
    embeddingCache.delete(key);
  }
  embeddingCache.set(key, value);
  // Evict oldest entries until within bound.
  while (embeddingCache.size > max) {
    const oldest = embeddingCache.keys().next();
    if (oldest.done) break;
    embeddingCache.delete(oldest.value);
  }
}

export function clearEmbeddingCache(): void {
  embeddingCache.clear();
}

export function getEmbeddingCacheSize(): number {
  return embeddingCache.size;
}

// ---------------------------------------------------------------------------
// Metadata hashing
// ---------------------------------------------------------------------------

/**
 * Deterministically hash arbitrary agent metadata into a cache key.
 * Keys are stable regardless of object property ordering.
 */
export function hashMetadata(metadata: unknown): string {
  const canonical = canonicalize(metadata);
  return createHash('sha256').update(canonical).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  const type = typeof value;
  if (type === 'number' || type === 'boolean') return JSON.stringify(value);
  if (type === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  if (type === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
    return `{${parts.join(',')}}`;
  }
  // Fallback for functions/symbols etc.
  return JSON.stringify(String(value));
}

// ---------------------------------------------------------------------------
// Model loading
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // Do not keep the event loop alive purely for the timeout.
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function loadPipeline(): Promise<FeatureExtractionPipeline> {
  const timeoutMs = getLoadTimeoutMs();
  const startedAt = Date.now();
  loadState = 'loading';
  loadError = null;

  try {
    // Dynamic import so the heavy dependency is only pulled in on demand.
    const mod = (await withTimeout(
      import('@xenova/transformers') as Promise<TransformersModule>,
      timeoutMs,
      'Embedding model import',
    )) as unknown as TransformersModule;

    // Keep the model local-friendly: allow remote download but do not spam.
    if (mod.env && typeof mod.env === 'object') {
      const env = mod.env as Record<string, unknown>;
      if (env.allowLocalModels === undefined) env.allowLocalModels = true;
    }

    const pipe = await withTimeout(
      mod.pipeline('feature-extraction', EMBEDDING_MODEL_ID),
      timeoutMs,
      'Embedding model load',
    );

    pipelineInstance = pipe;
    loadDurationMs = Date.now() - startedAt;
    loadState = 'ready';
    return pipe;
  } catch (err) {
    loadState = 'error';
    loadError = err instanceof Error ? err.message : String(err);
    // Reset so a later call can retry.
    pipelinePromise = null;
    pipelineInstance = null;
    throw err;
  }
}

/**
 * Ensure the model is loaded (lazily). Safe to call concurrently; all callers
 * share the same in-flight promise.
 */
export async function ensureEmbeddingModel(): Promise<FeatureExtractionPipeline> {
  if (!isEmbeddingsEnabled()) {
    throw new Error('Embeddings are disabled (set EMBEDDINGS_ENABLED=true to enable)');
  }
  if (pipelineInstance) return pipelineInstance;
  if (!pipelinePromise) {
    pipelinePromise = loadPipeline();
  }
  return pipelinePromise;
}

/**
 * Kick off model loading without awaiting it. Useful for warming the model at
 * startup or on first request without blocking the response.
 */
export function warmEmbeddingModel(): void {
  if (!isEmbeddingsEnabled()) return;
  if (pipelineInstance || pipelinePromise) return;
  pipelinePromise = loadPipeline();
  // Swallow rejection here; readiness reflects the error state.
  pipelinePromise.catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export function isEmbeddingModelReady(): boolean {
  return loadState === 'ready' && pipelineInstance !== null;
}

export function getEmbeddingReadiness(): EmbeddingReadiness {
  const enabled = isEmbeddingsEnabled();
  const state: EmbeddingReadinessState = enabled ? loadState : 'disabled';
  return {
    state,
    model: EMBEDDING_MODEL_ID,
    dimensions: EMBEDDING_DIMENSIONS,
    enabled,
    ready: enabled && isEmbeddingModelReady(),
    loading: enabled && loadState === 'loading',
    error: loadError,
    loadDurationMs,
    cacheSize: embeddingCache.size,
    cacheMax: getCacheMaxEntries(),
    cacheHits,
    cacheMisses,
    latency: {
      lastColdMs,
      lastWarmMs,
      avgColdMs: coldCount > 0 ? coldTotalMs / coldCount : null,
      avgWarmMs: warmCount > 0 ? warmTotalMs / warmCount : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Embedding computation
// ---------------------------------------------------------------------------

function toNumberArray(output: FeatureExtractionOutput): number[] {
  const data = output.data;
  const arr = data instanceof Float32Array ? Array.from(data) : Array.from(data as number[]);
  // Mean-pool if the pipeline returned token-level embeddings.
  if (output.dims && output.dims.length === 3) {
    const [, seqLen, hidden] = output.dims;
    if (seqLen > 0 && hidden > 0) {
      const pooled = new Array<number>(hidden).fill(0);
      for (let t = 0; t < seqLen; t++) {
        const base = t * hidden;
        for (let h = 0; h < hidden; h++) {
          pooled[h] += arr[base + h];
        }
      }
      for (let h = 0; h < hidden; h++) pooled[h] /= seqLen;
      return pooled;
    }
  }
  return arr;
}

function normalize(vec: number[]): number[] {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  const out = new Array<number>(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

async function computeEmbedding(text: string): Promise<number[]> {
  const pipe = await ensureEmbeddingModel();
  const output = await pipe(text, { pooling: 'mean', normalize: true });
  return normalize(toNumberArray(output));
}

/**
 * Get an embedding for the given text, caching by metadata hash when metadata
 * is supplied. When metadata is omitted the text itself is hashed.
 *
 * Warm (cache hit) and cold (cache miss) latencies are recorded for
 * instrumentation.
 */
export async function getEmbedding(
  text: string,
  metadata?: unknown,
): Promise<number[]> {
  const key = hashMetadata(metadata !== undefined ? { text, metadata } : { text });

  const startedAt = Date.now();
  const cached = cacheGet(key);
  if (cached) {
    const elapsed = Date.now() - startedAt;
    cacheHits++;
    lastWarmMs = elapsed;
    warmCount++;
    warmTotalMs += elapsed;
    return cached;
  }

  cacheMisses++;
  const coldStart = Date.now();
  const embedding = await computeEmbedding(text);
  const coldElapsed = Date.now() - coldStart;
  lastColdMs = coldElapsed;
  coldCount++;
  coldTotalMs += coldElapsed;

  cacheSet(key, embedding);
  return embedding;
}

/**
 * Batch helper: returns embeddings for many items, reusing the cache.
 */
export async function getEmbeddings(
  items: Array<{ text: string; metadata?: unknown }>,
): Promise<number[][]> {
  const results: number[][] = [];
  for (const item of items) {
    results.push(await getEmbedding(item.text, item.metadata));
  }
  return results;
}

/**
 * Cosine similarity between two equal-length vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}