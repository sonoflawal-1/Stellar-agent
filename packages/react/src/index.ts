import { useCallback, useEffect, useRef, useState } from 'react';
import { IdentityClient, CommerceClient } from 'marc-stellar-sdk';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

function useAsync<T>(
  loader: () => Promise<T>,
  deps: unknown[],
): AsyncState<T> & { refetch: () => void } {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    loading: true,
    error: null,
  });
  const mounted = useRef(true);

  const run = useCallback(() => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    loader()
      .then((data) => {
        if (mounted.current) setState({ data, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (mounted.current) {
          setState({
            data: null,
            loading: false,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    mounted.current = true;
    run();
    return () => {
      mounted.current = false;
    };
  }, [run]);

  return { ...state, refetch: run };
}

export interface UseAgentResult extends AsyncState<unknown> {
  agent: unknown;
  refetch: () => void;
}

export function useAgent(agentId: string): UseAgentResult {
  const client = useRef(new IdentityClient()).current;
  const { data, loading, error, refetch } = useAsync(
    () => client.getAgent(agentId),
    [agentId],
  );
  return { agent: data, data, loading, error, refetch };
}

export interface UseJobResult extends AsyncState<unknown> {
  job: unknown;
  refetch: () => void;
}

export function useJob(jobId: string): UseJobResult {
  const client = useRef(new CommerceClient()).current;
  const { data, loading, error, refetch } = useAsync(
    () => client.getJob(jobId),
    [jobId],
  );
  return { job: data, data, loading, error, refetch };
}

export interface UseCreateJobResult {
  createJob: (input: unknown) => Promise<unknown>;
  job: unknown;
  pending: boolean;
  error: Error | null;
}

export function useCreateJob(): UseCreateJobResult {
  const client = useRef(new CommerceClient()).current;
  const [job, setJob] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const createJob = useCallback(
    async (input: unknown) => {
      setPending(true);
      setError(null);
      // Optimistic UI: surface the pending job immediately.
      setJob(input);
      try {
        const created = await client.createJob(input);
        setJob(created);
        return created;
      } catch (err: unknown) {
        setJob(null);
        const wrapped = err instanceof Error ? err : new Error(String(err));
        setError(wrapped);
        throw wrapped;
      } finally {
        setPending(false);
      }
    },
    [client],
  );

  return { createJob, job, pending, error };
}
