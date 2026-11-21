'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CommerceClient, Job } from 'marc-stellar-sdk';
import { JobStatus } from 'marc-stellar-sdk';

export interface UseJobResult {
  /** The resolved on-chain Job record, or null while loading / on error. */
  job: Job | null;
  /** True while the job is being initially fetched or actively revalidated. */
  loading: boolean;
  /** Error thrown by the underlying CommerceClient.getJob() call, if any. */
  error: Error | null;
  /** True when the currently rendered data came from a stale cache entry. */
  isStale: boolean;
  /** Manually re-fetch the job for the current id, bypassing the cache. */
  refetch: () => Promise<void>;
}

export interface UseJobOptions {
  /** Cache time-to-live in milliseconds. Defaults to 30_000. */
  ttlMs?: number;
  /** An existing CommerceClient instance. Defaults to ambient client. */
  client?: CommerceClient;
  /**
   * Background polling interval in milliseconds.
   * When specified and > 0, the hook periodically re-checks on-chain job status.
   */
  pollIntervalMs?: number;
  /**
   * Whether to automatically stop background polling once the job reaches a terminal status
   * (Completed, Cancelled, Rejected). Defaults to true.
   */
  autoStopOnTerminal?: boolean;
}

interface JobCacheEntry {
  data: Job | null;
  timestamp: number;
}

const DEFAULT_TTL_MS = 30_000;

/** Shared memory cache keyed by job ID string. */
const jobCache = new Map<string, JobCacheEntry>();

/** In-flight requests keyed by job ID string, shared across hook instances. */
const inFlight = new Map<string, Promise<Job | null>>();

/**
 * Clear the shared job cache and any in-flight request tracking.
 * Primarily intended for testing.
 */
export function clearJobCache(): void {
  jobCache.clear();
  inFlight.clear();
}

/** Check if a job status is terminal and will no longer change. */
export function isTerminalJobStatus(status: JobStatus): boolean {
  return (
    status === JobStatus.Completed ||
    status === JobStatus.Cancelled ||
    status === JobStatus.Rejected
  );
}

/**
 * Safely parse a job ID string, number, or bigint into a Soroban bigint ID.
 */
export function parseJobId(id: string | bigint | number | null | undefined): bigint | null {
  if (id === null || id === undefined || id === '') return null;
  try {
    return BigInt(id);
  } catch {
    return null;
  }
}

/**
 * useJob provides reactive, polling-backed synchronization for a specific escrow job on Stellar Soroban.
 *
 * @param jobId The on-chain job ID to resolve. Pass null/undefined to skip fetching.
 * @param options Optional configuration (pollIntervalMs, ttlMs, client, autoStopOnTerminal)
 *                or a CommerceClient instance for convenience.
 */
export function useJob(
  jobId: string | bigint | number | null | undefined,
  options?: UseJobOptions | CommerceClient,
): UseJobResult {
  const opts: UseJobOptions =
    options && typeof (options as CommerceClient).getJob === 'function'
      ? { client: options as CommerceClient }
      : ((options as UseJobOptions | undefined) ?? {});

  const {
    client,
    ttlMs = DEFAULT_TTL_MS,
    pollIntervalMs,
    autoStopOnTerminal = true,
  } = opts;

  const parsedId = useMemo(() => parseJobId(jobId), [jobId]);
  const cacheKey = parsedId !== null ? parsedId.toString() : null;

  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState<boolean>(() => Boolean(cacheKey));
  const [error, setError] = useState<Error | null>(null);
  const [isStale, setIsStale] = useState<boolean>(false);

  // Track the latest request so stale responses don't clobber fresh state.
  const requestId = useRef(0);
  const latestJobRef = useRef<Job | null>(null);
  latestJobRef.current = job;

  const fetchJob = useCallback(
    async (force: boolean = false, isBackgroundPoll: boolean = false) => {
      if (parsedId === null || cacheKey === null) {
        setJob(null);
        setLoading(false);
        setError(null);
        setIsStale(false);
        return;
      }

      const cached = jobCache.get(cacheKey);
      const now = Date.now();
      const isFresh = cached !== undefined && now - cached.timestamp < ttlMs;

      if (cached && !force && !isBackgroundPoll) {
        // Serve cached data immediately; only revalidate if expired.
        setJob(cached.data);
        setLoading(false);
        setIsStale(!isFresh);
        if (isFresh) {
          setError(null);
          return;
        }
      } else if (!cached && !isBackgroundPoll) {
        setLoading(true);
        setIsStale(false);
      }

      const currentRequest = ++requestId.current;
      if (!cached || force) {
        setError(null);
      }

      try {
        const resolvedClient = client ?? (await getDefaultCommerceClient());

        let pending = force ? undefined : inFlight.get(cacheKey);
        if (!pending) {
          pending = resolvedClient.getJob(parsedId);
          if (!force) {
            inFlight.set(cacheKey, pending);
          }
          const shared = pending;
          shared
            .then(() => {
              if (inFlight.get(cacheKey) === shared) inFlight.delete(cacheKey);
            })
            .catch(() => {
              if (inFlight.get(cacheKey) === shared) inFlight.delete(cacheKey);
            });
        }

        const result = await pending;
        jobCache.set(cacheKey, { data: result, timestamp: Date.now() });

        if (currentRequest !== requestId.current) return;
        setJob(result);
        setError(null);
        setIsStale(false);
      } catch (err) {
        if (currentRequest !== requestId.current) return;
        const normalized = err instanceof Error ? err : new Error(String(err));
        if (!jobCache.has(cacheKey)) {
          setError(normalized);
          setJob(null);
        }
      } finally {
        if (inFlight.get(cacheKey) === undefined) {
          inFlight.delete(cacheKey);
        }
        if (currentRequest === requestId.current && !isBackgroundPoll) {
          setLoading(false);
        }
      }
    },
    [cacheKey, client, parsedId, ttlMs],
  );

  // Initial fetch and dependency reaction
  useEffect(() => {
    if (typeof window === 'undefined') return;
    void fetchJob(false, false);

    return () => {
      requestId.current++;
    };
  }, [fetchJob]);

  // Reactive background polling
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!pollIntervalMs || pollIntervalMs <= 0 || !cacheKey) return;

    let timerId: ReturnType<typeof setInterval> | null = null;

    const pollTick = () => {
      const current = latestJobRef.current;
      if (autoStopOnTerminal && current && isTerminalJobStatus(current.status)) {
        if (timerId !== null) {
          clearInterval(timerId);
          timerId = null;
        }
        return;
      }
      void fetchJob(true, true);
    };

    timerId = setInterval(pollTick, pollIntervalMs);

    return () => {
      if (timerId !== null) {
        clearInterval(timerId);
        timerId = null;
      }
    };
  }, [cacheKey, fetchJob, pollIntervalMs, autoStopOnTerminal]);

  const refetch = useCallback(() => fetchJob(true, false), [fetchJob]);

  return { job, loading, error, isStale, refetch };
}

/**
 * Lazily resolve a default CommerceClient.
 */
async function getDefaultCommerceClient(): Promise<CommerceClient> {
  const sdk = await import('marc-stellar-sdk');
  return new sdk.CommerceClient();
}

export default useJob;
