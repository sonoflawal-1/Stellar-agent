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
  /** Manually re-fetch the agent for the current id. */
  refetch: () => Promise<void>;
}

/**
 * useAgent wraps IdentityClient.getAgent() with idiomatic React async state.
 *
 * @param agentId The agent id to resolve. Pass null/undefined to skip fetching.
 * @param client  An IdentityClient instance. Defaults to a client created from
 *                the ambient configuration when omitted.
 */
export function useAgent(
  agentId: string | null | undefined,
  client?: IdentityClient,
): UseAgentResult {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(agentId));
  const [error, setError] = useState<Error | null>(null);

  // Track the latest request so stale responses don't clobber fresh state.
  const requestId = useRef(0);

  const fetchAgent = useCallback(async () => {
    if (!agentId) {
      setAgent(null);
      setLoading(false);
      setError(null);
      return;
    }

    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);

    try {
      const resolvedClient = client ?? (await getDefaultIdentityClient());
      const result = await resolvedClient.getAgent(agentId);
      if (currentRequest !== requestId.current) return;
      setAgent(result);
    } catch (err) {
      if (currentRequest !== requestId.current) return;
      setError(err instanceof Error ? err : new Error(String(err)));
      setAgent(null);
    } finally {
      if (currentRequest === requestId.current) {
        setLoading(false);
      }
    }
  }, [agentId, client]);

  useEffect(() => {
    void fetchAgent();
    // Invalidate any in-flight request when deps change or on unmount.
    return () => {
      requestId.current++;
    };
  }, [fetchAgent]);

  return { agent, loading, error, refetch: fetchAgent };
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
