import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAgents } from './useAgents';
import type { IdentityClient } from '@solana/identity';

// Mock the SDK client so no real network calls occur.
const mockListAgents = vi.fn();

vi.mock('@solana/identity', () => {
  return {
    IdentityClient: vi.fn().mockImplementation(() => ({
      listAgents: mockListAgents,
    })),
  };
});

interface Agent {
  address: string;
  owner: string;
  name: string;
}

function makeAgent(owner: string, index: number): Agent {
  return {
    address: `agent-${owner}-${index}`,
    owner,
    name: `Agent ${index}`,
  };
}

function makePage(agents: Agent[], hasMore: boolean, cursor?: string) {
  return {
    items: agents,
    hasMore,
    cursor: hasMore ? cursor ?? 'next-cursor' : undefined,
  };
}

describe('useAgents', () => {
  let client: IdentityClient;

  beforeEach(() => {
    mockListAgents.mockReset();
    client = new (require('@solana/identity').IdentityClient)();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads the first page with the default page size', async () => {
    const agents = [makeAgent('owner-a', 0), makeAgent('owner-a', 1)];
    mockListAgents.mockResolvedValueOnce(makePage(agents, false));

    const { result } = renderHook(() => useAgents({ client }));

    expect(result.current.loading).toBe(true);
    expect(result.current.agents).toEqual([]);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockListAgents).toHaveBeenCalledTimes(1);
    expect(mockListAgents).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 20 }),
    );
    expect(result.current.agents).toEqual(agents);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('respects a custom page size', async () => {
    mockListAgents.mockResolvedValueOnce(makePage([], false));

    const { result } = renderHook(() => useAgents({ client, pageSize: 5 }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockListAgents).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 5 }),
    );
  });

  it('filters agents by owner', async () => {
    const ownerAgents = [makeAgent('owner-a', 0), makeAgent('owner-a', 1)];
    mockListAgents.mockResolvedValueOnce(makePage(ownerAgents, false));

    const { result } = renderHook(() =>
      useAgents({ client, owner: 'owner-a' }),
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockListAgents).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'owner-a' }),
    );
    expect(result.current.agents).toEqual(ownerAgents);
    expect(result.current.agents.every((a) => a.owner === 'owner-a')).toBe(true);
  });

  it('paginates via loadMore and tracks hasMore', async () => {
    const firstPage = [makeAgent('owner-a', 0), makeAgent('owner-a', 1)];
    const secondPage = [makeAgent('owner-a', 2)];

    mockListAgents
      .mockResolvedValueOnce(makePage(firstPage, true, 'cursor-1'))
      .mockResolvedValueOnce(makePage(secondPage, false));

    const { result } = renderHook(() => useAgents({ client }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.agents).toEqual(firstPage);
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadMore();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockListAgents).toHaveBeenCalledTimes(2);
    expect(mockListAgents).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'cursor-1' }),
    );
    expect(result.current.agents).toEqual([...firstPage, ...secondPage]);
    expect(result.current.hasMore).toBe(false);
  });

  it('does nothing when loadMore is called without hasMore', async () => {
    mockListAgents.mockResolvedValueOnce(makePage([makeAgent('owner-a', 0)], false));

    const { result } = renderHook(() => useAgents({ client }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.loadMore();
    });

    expect(mockListAgents).toHaveBeenCalledTimes(1);
  });

  it('handles empty results', async () => {
    mockListAgents.mockResolvedValueOnce(makePage([], false));

    const { result } = renderHook(() => useAgents({ client }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.agents).toEqual([]);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('propagates errors from the client', async () => {
    const error = new Error('network failure');
    mockListAgents.mockRejectedValueOnce(error);

    const { result } = renderHook(() => useAgents({ client }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe(error);
    expect(result.current.agents).toEqual([]);
    expect(result.current.hasMore).toBe(false);
  });

  it('resets and refetches when owner changes', async () => {
    const ownerAAgents = [makeAgent('owner-a', 0)];
    const ownerBAgents = [makeAgent('owner-b', 0)];

    mockListAgents
      .mockResolvedValueOnce(makePage(ownerAAgents, false))
      .mockResolvedValueOnce(makePage(ownerBAgents, false));

    const { result, rerender } = renderHook(
      ({ owner }: { owner: string }) => useAgents({ client, owner }),
      { initialProps: { owner: 'owner-a' } },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.agents).toEqual(ownerAAgents);

    rerender({ owner: 'owner-b' });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockListAgents).toHaveBeenCalledTimes(2);
    expect(mockListAgents).toHaveBeenLastCalledWith(
      expect.objectContaining({ owner: 'owner-b' }),
    );
    expect(result.current.agents).toEqual(ownerBAgents);
  });

  it('resets and refetches when pageSize changes', async () => {
    mockListAgents
      .mockResolvedValueOnce(makePage([makeAgent('owner-a', 0)], false))
      .mockResolvedValueOnce(makePage([makeAgent('owner-a', 0)], false));

    const { result, rerender } = renderHook(
      ({ pageSize }: { pageSize: number }) => useAgents({ client, pageSize }),
      { initialProps: { pageSize: 10 } },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    rerender({ pageSize: 50 });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockListAgents).toHaveBeenCalledTimes(2);
    expect(mockListAgents).toHaveBeenLastCalledWith(
      expect.objectContaining({ pageSize: 50 }),
    );
  });
});