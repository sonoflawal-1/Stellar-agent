import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent, IdentityClient } from '@identity/sdk';
import { useIdentityClient } from '../context/IdentityClientContext';

export interface UseAgentsOptions {
  pageSize?: number;
  owner?: string;
  client?: IdentityClient;
}

export interface UseAgentsResult {
  agents: Agent[];
  loading: boolean;
  error: Error | null;
  hasMore: boolean;
  loadMore: () => void;
  refresh: () => void;
}

const DEFAULT_PAGE_SIZE = 20;

export function useAgents(options: UseAgentsOptions = {}): UseAgentsResult {
  const { pageSize = DEFAULT_PAGE_SIZE, owner, client: clientOption } = options;

  const contextClient = useIdentityClient();
  const client = clientOption ?? contextClient;

  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);
  const [hasMore, setHasMore] = useState<boolean>(false);

  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const iteratorRef = useRef<AsyncIterator<Agent> | null>(null);
  const loadingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchPage = useCallback(
    async (reset: boolean) => {
      if (!client) {
        return;
      }
      if (loadingRef.current && !reset) {
        return;
      }

      const requestId = ++requestIdRef.current;
      loadingRef.current = true;
      setLoading(true);
      setError(null);

      try {
        if (owner) {
          const result = await client.getAgentByOwner(owner);
          if (!mountedRef.current || requestId !== requestIdRef.current) {
            return;
          }
          const list = Array.isArray(result) ? result : result ? [result] : [];
          setAgents(list);
          setHasMore(false);
          iteratorRef.current = null;
        } else {
          if (reset || !iteratorRef.current) {
            iteratorRef.current = client.listAgents({ pageSize });
          }
          const iterator = iteratorRef.current;
          const page: Agent[] = [];
          let done = false;
          while (page.length < pageSize) {
            const next = await iterator.next();
            if (next.done) {
              done = true;
              break;
            }
            page.push(next.value);
          }
          if (!mountedRef.current || requestId !== requestIdRef.current) {
            return;
          }
          setAgents((prev) => (reset ? page : [...prev, ...page]));
          setHasMore(!done);
        }
      } catch (err) {
        if (!mountedRef.current || requestId !== requestIdRef.current) {
          return;
        }
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (mountedRef.current && requestId === requestIdRef.current) {
          setLoading(false);
        }
        loadingRef.current = false;
      }
    },
    [client, owner, pageSize],
  );

  useEffect(() => {
    iteratorRef.current = null;
    setAgents([]);
    setHasMore(false);
    setError(null);
    void fetchPage(true);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (!hasMore || loadingRef.current) {
      return;
    }
    void fetchPage(false);
  }, [fetchPage, hasMore]);

  const refresh = useCallback(() => {
    iteratorRef.current = null;
    void fetchPage(true);
  }, [fetchPage]);

  return { agents, loading, error, hasMore, loadMore, refresh };
}