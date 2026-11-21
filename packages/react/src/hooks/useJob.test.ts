import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { JobStatus } from 'marc-stellar-sdk';
import type { Job, CommerceClient } from 'marc-stellar-sdk';
import { useJob, clearJobCache } from './useJob';

const mockJobFunded: Job = {
  id: 42n,
  client: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTBVDJ42LPBK4EK4YLYL2QQ5K',
  provider: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAA',
  evaluator: 'GCIZ3GHMYKJWF2POGBOUQ25J4DCW22LQ6K3N4V56ZJAAAKO456XYZAAA',
  token: 'CA76YNCFOHQVNWOJSTNRDKW3PF7MBVH3REO4IZWB4QPAOB6SIIS4YKEP',
  budget: 50_000_000n,
  status: JobStatus.Funded,
  description: 'AI agent code review job',
  deliverable: '',
  deliverable_hash: new Uint8Array(32),
  funded_at: 1700000000n,
  created_at: 1700000000n,
  updated_at: 1700000000n,
};

const mockJobCompleted: Job = {
  ...mockJobFunded,
  status: JobStatus.Completed,
  deliverable: 'https://ipfs.io/ipfs/QmTestDeliverableHash123',
  updated_at: 1700003600n,
};

describe('useJob', () => {
  let mockCommerceClient: { getJob: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    clearJobCache();
    vi.useFakeTimers();
    mockCommerceClient = {
      getJob: vi.fn().mockResolvedValue(mockJobFunded),
    };
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    clearJobCache();
  });

  it('starts loading and resolves on-chain job data', async () => {
    const { result } = renderHook(() =>
      useJob(42n, { client: mockCommerceClient as unknown as CommerceClient }),
    );

    expect(result.current.loading).toBe(true);
    expect(result.current.job).toBeNull();
    expect(result.current.error).toBeNull();

    await act(async () => {
      await vi.runAllTicksAsync();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.job).toEqual(mockJobFunded);
    expect(result.current.job?.status).toBe(JobStatus.Funded);
    expect(result.current.error).toBeNull();
    expect(mockCommerceClient.getJob).toHaveBeenCalledWith(42n);
  });

  it('handles null/undefined jobId gracefully without querying', async () => {
    const { result } = renderHook(() =>
      useJob(null, { client: mockCommerceClient as unknown as CommerceClient }),
    );

    expect(result.current.loading).toBe(false);
    expect(result.current.job).toBeNull();
    expect(mockCommerceClient.getJob).not.toHaveBeenCalled();
  });

  it('updates state reactively via background polling from Funded to Completed', async () => {
    let callCount = 0;
    mockCommerceClient.getJob.mockImplementation(async (id: bigint) => {
      callCount++;
      return callCount > 1 ? mockJobCompleted : mockJobFunded;
    });

    const { result } = renderHook(() =>
      useJob('42', {
        client: mockCommerceClient as unknown as CommerceClient,
        pollIntervalMs: 1000,
      }),
    );

    // Initial fetch resolves
    await act(async () => {
      await vi.runAllTicksAsync();
    });
    expect(result.current.job?.status).toBe(JobStatus.Funded);

    // Advance timer to trigger background polling
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(result.current.job?.status).toBe(JobStatus.Completed);
    expect(result.current.job?.deliverable).toBe(
      'https://ipfs.io/ipfs/QmTestDeliverableHash123',
    );
  });

  it('cleans up background polling timers on unmount', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const { unmount } = renderHook(() =>
      useJob(42n, {
        client: mockCommerceClient as unknown as CommerceClient,
        pollIntervalMs: 2000,
      }),
    );

    await act(async () => {
      await vi.runAllTicksAsync();
    });

    unmount();

    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  it('surfaces errors when on-chain fetch fails', async () => {
    mockCommerceClient.getJob.mockRejectedValue(new Error('Soroban RPC timeout'));

    const { result } = renderHook(() =>
      useJob(42n, { client: mockCommerceClient as unknown as CommerceClient }),
    );

    await act(async () => {
      await vi.runAllTicksAsync();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.job).toBeNull();
    expect(result.current.error?.message).toBe('Soroban RPC timeout');
  });

  it('allows manual refetch bypassing cache', async () => {
    const { result } = renderHook(() =>
      useJob(42n, { client: mockCommerceClient as unknown as CommerceClient }),
    );

    await act(async () => {
      await vi.runAllTicksAsync();
    });
    expect(mockCommerceClient.getJob).toHaveBeenCalledTimes(1);

    mockCommerceClient.getJob.mockResolvedValueOnce(mockJobCompleted);

    await act(async () => {
      await result.current.refetch();
    });

    expect(mockCommerceClient.getJob).toHaveBeenCalledTimes(2);
    expect(result.current.job?.status).toBe(JobStatus.Completed);
  });
});
