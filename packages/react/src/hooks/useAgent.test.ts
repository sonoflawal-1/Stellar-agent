import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAgent, clearAgentCache } from './useAgent';
import { IdentityClient } from '@stellaridentity/sdk';

vi.mock('@stellaridentity/sdk', () => {
  return {
    IdentityClient: vi.fn(),
  };
});

type Agent = {
  address: string;
  metadata?: Record<string, unknown>;
};

const makeAgent = (address: string): Agent => ({
  address,
  metadata: { name: `Agent ${address}` },
});

describe('useAgent', () => {
  let getAgentMock: ReturnType<typeof vi.fn>;
  let clientInstance: { getAgent: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    clearAgentCache();
    getAgentMock = vi.fn();
    clientInstance = { getAgent: getAgentMock };
    (IdentityClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => clientInstance,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    clearAgentCache();
  });

  it('starts in loading state and resolves to success', async () => {
    const agent = makeAgent('GABC123');
    getAgentMock.mockResolvedValueOnce(agent);

    const { result } = renderHook(() => useAgent('GABC123'));

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toEqual(agent);
    expect(result.current.error).toBeNull();
    expect(getAgentMock).toHaveBeenCalledTimes(1);
    expect(getAgentMock).toHaveBeenCalledWith('GABC123');
  });

  it('handles RPC errors', async () => {
    const rpcError = new Error('RPC failed');
    getAgentMock.mockRejectedValueOnce(rpcError);

    const { result } = renderHook(() => useAgent('GERR'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe(rpcError);
    expect(result.current.data).toBeUndefined();
  });

  it('does not fetch when address is undefined', async () => {
    const { result } = renderHook(() => useAgent(undefined));

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();
    expect(getAgentMock).not.toHaveBeenCalled();
  });

  it('serves cached data immediately (stale-while-revalidate)', async () => {
    const firstAgent = makeAgent('GCACHE');
    const secondAgent = makeAgent('GCACHE');
    secondAgent.metadata = { name: 'Updated' };

    getAgentMock.mockResolvedValueOnce(firstAgent);

    const first = renderHook(() => useAgent('GCACHE'));
    await waitFor(() => {
      expect(first.result.current.loading).toBe(false);
    });
    expect(first.result.current.data).toEqual(firstAgent);
    first.unmount();

    getAgentMock.mockResolvedValueOnce(secondAgent);

    const second = renderHook(() => useAgent('GCACHE'));

    // Cached data should be available synchronously (stale)
    expect(second.result.current.data).toEqual(firstAgent);

    // Revalidation should update to fresh data
    await waitFor(() => {
      expect(second.result.current.data).toEqual(secondAgent);
    });
    expect(getAgentMock).toHaveBeenCalledTimes(2);
  });

  it('deduplicates in-flight requests for the same address', async () => {
    const agent = makeAgent('GDEDUP');
    let resolveFn: (value: Agent) => void = () => {};
    const pending = new Promise<Agent>((resolve) => {
      resolveFn = resolve;
    });
    getAgentMock.mockReturnValueOnce(pending);

    const hookA = renderHook(() => useAgent('GDEDUP'));
    const hookB = renderHook(() => useAgent('GDEDUP'));

    expect(getAgentMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFn(agent);
      await pending;
    });

    await waitFor(() => {
      expect(hookA.result.current.data).toEqual(agent);
      expect(hookB.result.current.data).toEqual(agent);
    });

    expect(getAgentMock).toHaveBeenCalledTimes(1);
  });

  it('does not update state after unmount', async () => {
    const agent = makeAgent('GUNMOUNT');
    let resolveFn: (value: Agent) => void = () => {};
    const pending = new Promise<Agent>((resolve) => {
      resolveFn = resolve;
    });
    getAgentMock.mockReturnValueOnce(pending);

    const { result, unmount } = renderHook(() => useAgent('GUNMOUNT'));

    expect(result.current.loading).toBe(true);

    unmount();

    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    await act(async () => {
      resolveFn(agent);
      await pending;
    });

    // No React state update warnings should have been emitted
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('prevents race conditions when address changes', async () => {
    const agentA = makeAgent('GAAA');
    const agentB = makeAgent('GBBB');

    let resolveA: (value: Agent) => void = () => {};
    const pendingA = new Promise<Agent>((resolve) => {
      resolveA = resolve;
    });
    getAgentMock.mockReturnValueOnce(pendingA);
    getAgentMock.mockResolvedValueOnce(agentB);

    const { result, rerender } = renderHook(
      ({ address }: { address: string }) => useAgent(address),
      { initialProps: { address: 'GAAA' } },
    );

    expect(result.current.loading).toBe(true);

    // Change address before first request resolves
    rerender({ address: 'GBBB' });

    await waitFor(() => {
      expect(result.current.data).toEqual(agentB);
    });

    // Now resolve the stale request for GAAA
    await act(async () => {
      resolveA(agentA);
      await pendingA;
    });

    // Stale result must not overwrite the current address's data
    expect(result.current.data).toEqual(agentB);
  });

  it('refetches when address changes to a new value', async () => {
    const agentA = makeAgent('GONE');
    const agentB = makeAgent('GTWO');

    getAgentMock.mockResolvedValueOnce(agentA);
    getAgentMock.mockResolvedValueOnce(agentB);

    const { result, rerender } = renderHook(
      ({ address }: { address: string }) => useAgent(address),
      { initialProps: { address: 'GONE' } },
    );

    await waitFor(() => {
      expect(result.current.data).toEqual(agentA);
    });

    rerender({ address: 'GTWO' });

    await waitFor(() => {
      expect(result.current.data).toEqual(agentB);
    });

    expect(getAgentMock).toHaveBeenCalledTimes(2);
    expect(getAgentMock).toHaveBeenNthCalledWith(1, 'GONE');
    expect(getAgentMock).toHaveBeenNthCalledWith(2, 'GTWO');
  });
});