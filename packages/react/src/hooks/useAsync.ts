'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

export interface UseAsyncResult<T> extends AsyncState<T> {
  refetch: () => Promise<void>;
}

export function useAsync<T>(
  loader: () => Promise<T>,
  deps: unknown[] = [],
): UseAsyncResult<T> {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    loading: true,
    error: null,
  });

  const mounted = useRef(true);
  const runId = useRef(0);

  const run = useCallback(async () => {
    const currentRun = ++runId.current;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const data = await loader();
      if (mounted.current && currentRun === runId.current) {
        setState({ data, loading: false, error: null });
      }
    } catch (err: unknown) {
      if (mounted.current && currentRun === runId.current) {
        setState({
          data: null,
          loading: false,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    mounted.current = true;
    void run();
    return () => {
      mounted.current = false;
      runId.current++;
    };
  }, [run]);

  return { ...state, refetch: run };
}

export default useAsync;
