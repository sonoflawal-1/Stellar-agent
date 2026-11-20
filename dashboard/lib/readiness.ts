/**
 * Readiness probes for the dashboard (#966).
 *
 * Each dependency is probed in parallel and wrapped in a timeout so that a
 * single hanging dependency cannot block the readiness endpoint. Results are
 * aggregated into a report with per-dependency detail and an overall `ok`
 * flag, which `/readyz` maps to HTTP 200 (ready) or 503 (not ready).
 */

export type DependencyStatus = "ok" | "error" | "timeout";

export interface DependencyResult {
  /** Whether the dependency responded successfully within the timeout. */
  ok: boolean;
  /** Categorised outcome of the probe. */
  status: DependencyStatus;
  /** Human-readable detail (error message, timeout notice, etc.). */
  detail?: string;
  /** Time spent probing, in milliseconds. */
  latencyMs: number;
}

export interface ReadinessReport {
  /** True only when every dependency is ready. */
  ok: boolean;
  /** Per-dependency results keyed by dependency name. */
  dependencies: Record<string, DependencyResult>;
  /** When the report was generated. */
  checkedAt: string;
}

export interface ReadinessOptions {
  /** Timeout applied to each individual probe, in milliseconds. */
  timeoutMs?: number;
  /** RPC endpoint used for the `getHealth` probe. */
  rpcUrl?: string;
  /** Indexer database connection string. */
  indexerDbUrl?: string;
  /** Base URL of the embedding-model service. */
  modelUrl?: string;
}

const DEFAULT_TIMEOUT_MS = 2_000;

/**
 * Raised internally when a probe exceeds its timeout.
 */
class ProbeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`probe timed out after ${timeoutMs}ms`);
    this.name = "ProbeTimeoutError";
  }
}

/**
 * Runs `fn` with a timeout. The underlying operation is not cancelled (most
 * fetch/db clients do not support it here), but the caller stops waiting and
 * the probe is reported as timed out.
 */
async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ProbeTimeoutError(timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Wraps a probe so it always resolves to a DependencyResult.
 */
async function runProbe(
  name: string,
  probe: () => Promise<void>,
  timeoutMs: number,
): Promise<[string, DependencyResult]> {
  const started = Date.now();
  try {
    await withTimeout(probe, timeoutMs);
    return [
      name,
      { ok: true, status: "ok", latencyMs: Date.now() - started },
    ];
  } catch (err) {
    const latencyMs = Date.now() - started;
    if (err instanceof ProbeTimeoutError) {
      return [
        name,
        { ok: false, status: "timeout", detail: err.message, latencyMs },
      ];
    }
    const detail = err instanceof Error ? err.message : String(err);
    return [name, { ok: false, status: "error", detail, latencyMs }];
  }
}

/**
 * Probes the RPC endpoint via the JSON-RPC `getHealth` method.
 */
async function probeRpc(rpcUrl: string): Promise<void> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getHealth",
      params: [],
    }),
  });
  if (!res.ok) {
    throw new Error(`RPC responded with HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    result?: unknown;
    error?: { message?: string };
  };
  if (body.error) {
    throw new Error(`RPC error: ${body.error.message ?? "unknown"}`);
  }
  if (body.result !== "ok") {
    throw new Error(`RPC health is "${String(body.result)}"`);
  }
}

/**
 * Probes the indexer database with a lightweight query.
 *
 * Uses a dynamic import so that `pg` is only required when the probe runs,
 * keeping the module importable in environments without a database driver.
 */
async function probeIndexerDb(indexerDbUrl: string): Promise<void> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: indexerDbUrl });
  try {
    await client.connect();
    await client.query("SELECT 1");
  } finally {
    await client.end().catch(() => {
      /* ignore close errors */
    });
  }
}

/**
 * Probes the embedding-model service readiness endpoint.
 */
async function probeModel(modelUrl: string): Promise<void> {
  const url = modelUrl.replace(/\/+$/, "") + "/health";
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    throw new Error(`model service responded with HTTP ${res.status}`);
  }
}

/**
 * Runs all dependency probes in parallel and aggregates the results.
 *
 * Missing configuration for a dependency is reported as an error for that
 * dependency rather than throwing, so the report always describes every
 * dependency.
 */
export async function checkReadiness(
  options: ReadinessOptions = {},
): Promise<ReadinessReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const probes: Array<Promise<[string, DependencyResult]>> = [];

  probes.push(
    runProbe(
      "rpc",
      options.rpcUrl
        ? () => probeRpc(options.rpcUrl as string)
        : () => Promise.reject(new Error("RPC_URL is not configured")),
      timeoutMs,
    ),
  );

  probes.push(
    runProbe(
      "indexerDb",
      options.indexerDbUrl
        ? () => probeIndexerDb(options.indexerDbUrl as string)
        : () => Promise.reject(new Error("INDEXER_DB_URL is not configured")),
      timeoutMs,
    ),
  );

  probes.push(
    runProbe(
      "model",
      options.modelUrl
        ? () => probeModel(options.modelUrl as string)
        : () => Promise.reject(new Error("MODEL_URL is not configured")),
      timeoutMs,
    ),
  );

  const entries = await Promise.all(probes);
  const dependencies: Record<string, DependencyResult> = {};
  for (const [name, result] of entries) {
    dependencies[name] = result;
  }

  const ok = Object.values(dependencies).every((d) => d.ok);

  return {
    ok,
    dependencies,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Builds readiness options from environment variables.
 */
export function readinessOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ReadinessOptions {
  const timeoutMs = env.READINESS_TIMEOUT_MS
    ? Number.parseInt(env.READINESS_TIMEOUT_MS, 10)
    : undefined;
  return {
    timeoutMs:
      timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : undefined,
    rpcUrl: env.RPC_URL,
    indexerDbUrl: env.INDEXER_DB_URL,
    modelUrl: env.MODEL_URL,
  };
}