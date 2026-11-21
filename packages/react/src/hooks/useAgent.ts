'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { IdentityClient } from 'marc-stellar-sdk';
import type { Agent } from 'marc-stellar-sdk';

export interface UseAgentResult {
  /** The resolved agent, or null while loading / on error. */
  agent: Agent | null;
  /** True while the agent is being fetched. */
  loading: boolean;
  /** Error thrown by the underlying IdentityClient.getAgent() call, if any. */
  error: Error | null;
  /** True when the currently rendered data came from a stale cache entry. */
  isStale: boolean;
  /** Manually re-fetch the agent for the current id, bypassing the cache. */
  refetch: () => Promise<void>;
}

export interface UseAgentOptions {
  /** Cache time-to-live in milliseconds. Defaults to 60_000. */
  ttlMs?: number;
  /** An IdentityClient instance. Defaults to a client created from ambient config. */
  client?: IdentityClient;
}

interface AgentCacheEntry {
  data: Agent;
  timestamp: number;
}

const DEFAULT_TTL_MS = 60_000;

/** Shared memory cache keyed by agent id. */
const agentCache = new Map<string, AgentCacheEntry>();

/** In-flight requests keyed by agent id, shared across hook instances. */
const inFlight = new Map<string, Promise<Agent>>();

/**
 * Clear the shared agent cache and any in-flight request tracking.
 * Primarily intended for tests.
 */
export function clearAgentCache(): void {
  agentCache.clear();
  inFlight.clear();
}

/**
 * useAgent wraps IdentityClient.getAgent() with idiomatic React async state,
 * stale-while-revalidate caching and in-flight request deduplication.
 *
 * @param agentId The agent id to resolve. Pass null/undefined to skip fetching.
 * @param options Optional configuration (ttlMs, client) or an IdentityClient
 *                instance for backwards compatibility.
 */
export function useAgent(
  agentId: string | null | undefined,
  options?: UseAgentOptions | IdentityClient,
): UseAgentResult {
  const opts: UseAgentOptions =
    options && typeof (options as IdentityClient).getAgent === 'function'
      ? { client: options as IdentityClient }
      : ((options as UseAgentOptions | undefined) ?? {});
  const { client, ttlMs = DEFAULT_TTL_MS } = opts;

  // Initial state must be identical on the server and during the first client
  // render to avoid hydration mismatches. The shared cache is only consulted
  // after mount (see the effect below), never during render.
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState<boolean>(() => Boolean(agentId));
  const [error, setError] = useState<Error | null>(null);
  const [isStale, setIsStale] = useState<boolean>(false);

  // Track the latest request so stale responses don't clobber fresh state.
  const requestId = useRef(0);

  const fetchAgent = useCallback(
    async (force: boolean = false) => {
      if (!agentId) {
        setAgent(null);
        setLoading(false);
        setError(null);
        setIsStale(false);
        return;
      }

      const cached = agentCache.get(agentId);
      const now = Date.now();
      const isFresh = cached !== undefined && now - cached.timestamp < ttlMs;

      if (cached && !force) {
        // Serve stale data immediately; only revalidate when expired.
        setAgent(cached.data);
        setLoading(false);
        setIsStale(!isFresh);
        if (isFresh) {
          setError(null);
          return;
        }
      } else if (!cached) {
        setLoading(true);
        setIsStale(false);
      }

      const currentRequest = ++requestId.current;
      if (!cached || force) {
        setError(null);
      }

      try {
        const resolvedClient = client ?? (await getDefaultIdentityClient());

        let pending = force ? undefined : inFlight.get(agentId);
        if (!pending) {
          pending = resolvedClient.getAgent(agentId);
          if (!force) {
            inFlight.set(agentId, pending);
          }
          // Ensure the in-flight entry is cleaned up once settled.
          const shared = pending;
          shared
            .then(() => {
              if (inFlight.get(agentId) === shared) inFlight.delete(agentId);
            })
            .catch(() => {
              if (inFlight.get(agentId) === shared) inFlight.delete(agentId);
            });
        }

        const result = await pending;
        agentCache.set(agentId, { data: result, timestamp: Date.now() });
        if (currentRequest !== requestId.current) return;
        setAgent(result);
        setError(null);
        setIsStale(false);
      } catch (err) {
        if (currentRequest !== requestId.current) return;
        const normalized = err instanceof Error ? err : new Error(String(err));
        // Only surface the error when there is no cached data to fall back on.
        if (!agentCache.has(agentId)) {
          setError(normalized);
          setAgent(null);
        }
      } finally {
        if (inFlight.get(agentId) === undefined) {
          inFlight.delete(agentId);
        }
        if (currentRequest === requestId.current) {
          setLoading(false);
        }
      }
    },
    [agentId, client, ttlMs],
  );

  useEffect(() => {
    // Only touch the shared cache / network in the browser. On the server the
    // effect never runs, so the SSR output stays deterministic.
    if (typeof window === 'undefined') return;
    void fetchAgent(false);
    // Invalidate any in-flight request when deps change or on unmount.
    return () => {
      requestId.current++;
    };
  }, [fetchAgent]);

  const refetch = useCallback(() => fetchAgent(true), [fetchAgent]);

  return { agent, loading, error, isStale, refetch };
}

/**
 * Lazily resolve a default IdentityClient. Kept as a separate indirection so
 * consumers can supply their own client without paying for default setup.
 */
async function getDefaultIdentityClient(): Promise<IdentityClient> {
  const sdk = await import('marc-stellar-sdk');
  return new sdk.IdentityClient();
}

export default useAgent;
