import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { CommerceClient, Signer } from 'marc-stellar-sdk';
import { useCommerce } from './useCommerce';
import { useTransaction } from './useTransaction';

const mockSigner: Signer = {
  publicKey: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTBVDJ42LPBK4EK4YLYL2QQ5K',
  signTransaction: vi.fn().mockResolvedValue('signedXdrPayloadBase64'),
};

describe('useCommerce', () => {
  let mockCommerceClient: {
    createJob: ReturnType<typeof vi.fn>;
    submit: ReturnType<typeof vi.fn>;
    complete: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    estimateCreateJobFee: ReturnType<typeof vi.fn>;
    prepareCreateJob: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockCommerceClient = {
      createJob: vi.fn().mockResolvedValue(101n),
      submit: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      estimateCreateJobFee: vi.fn().mockResolvedValue(150000n),
      prepareCreateJob: vi.fn().mockResolvedValue('unsignedSimulationXdr'),
    };
  });

  it('starts with non-pending state and null txHash and error', () => {
    const { result } = renderHook(() =>
      useCommerce({
        client: mockCommerceClient as unknown as CommerceClient,
        signer: mockSigner,
      }),
    );

    expect(result.current.isPending).toBe(false);
    expect(result.current.status).toBe('idle');
    expect(result.current.txHash).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('creates a job in one line and updates isPending and txHash', async () => {
    const { result } = renderHook(() =>
      useCommerce({
        client: mockCommerceClient as unknown as CommerceClient,
        signer: mockSigner,
      }),
    );

    let createPromise: Promise<{ jobId: bigint; txHash: string | null }>;
    act(() => {
      createPromise = result.current.createJob({
        provider: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAA',
        evaluator: 'GCIZ3GHMYKJWF2POGBOUQ25J4DCW22LQ6K3N4V56ZJAAAKO456XYZAAA',
        budget: 10_000_000n,
        description: 'Implement frontend dashboard',
      });
    });

    expect(result.current.isPending).toBe(true);
    expect(result.current.status).toBe('signing');

    let res: { jobId: bigint; txHash: string | null } | undefined;
    await act(async () => {
      res = await createPromise;
    });

    expect(result.current.isPending).toBe(false);
    expect(result.current.status).toBe('confirmed');
    expect(res?.jobId).toBe(101n);
    expect(result.current.txHash).toBeTruthy();
    expect(result.current.error).toBeNull();
    expect(mockCommerceClient.createJob).toHaveBeenCalledWith(
      mockSigner,
      'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAA',
      'GCIZ3GHMYKJWF2POGBOUQ25J4DCW22LQ6K3N4V56ZJAAAKO456XYZAAA',
      expect.any(String),
      10_000_000n,
      'Implement frontend dashboard',
    );
  });

  it('handles job submission lifecycle', async () => {
    const { result } = renderHook(() =>
      useCommerce({
        client: mockCommerceClient as unknown as CommerceClient,
        signer: mockSigner,
      }),
    );

    await act(async () => {
      await result.current.submitJob({
        jobId: 101n,
        deliverable: 'https://github.com/pull/1',
      });
    });

    expect(result.current.isPending).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockCommerceClient.submit).toHaveBeenCalledWith(
      mockSigner,
      101n,
      'https://github.com/pull/1',
      undefined,
    );
  });

  it('handles job completion and escrow release', async () => {
    const { result } = renderHook(() =>
      useCommerce({
        client: mockCommerceClient as unknown as CommerceClient,
        signer: mockSigner,
      }),
    );

    await act(async () => {
      await result.current.completeJob({
        jobId: 101n,
      });
    });

    expect(result.current.isPending).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockCommerceClient.complete).toHaveBeenCalledWith(
      mockSigner,
      101n,
      undefined,
    );
  });

  it('handles cancellation and escrow refund', async () => {
    const { result } = renderHook(() =>
      useCommerce({
        client: mockCommerceClient as unknown as CommerceClient,
        signer: mockSigner,
      }),
    );

    await act(async () => {
      await result.current.cancelJob({
        jobId: 101n,
      });
    });

    expect(result.current.isPending).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockCommerceClient.cancel).toHaveBeenCalledWith(mockSigner, 101n);
  });

  it('captures errors accurately and resets isPending', async () => {
    mockCommerceClient.createJob.mockRejectedValueOnce(
      new Error('Insufficient escrow balance'),
    );

    const { result } = renderHook(() =>
      useCommerce({
        client: mockCommerceClient as unknown as CommerceClient,
        signer: mockSigner,
      }),
    );

    await act(async () => {
      try {
        await result.current.createJob({
          provider: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAA',
          evaluator: 'GCIZ3GHMYKJWF2POGBOUQ25J4DCW22LQ6K3N4V56ZJAAAKO456XYZAAA',
          budget: 999_999_999n,
          description: 'Failed job creation',
        });
      } catch {
        // Expected
      }
    });

    expect(result.current.isPending).toBe(false);
    expect(result.current.status).toBe('failed');
    expect(result.current.txHash).toBeNull();
    expect(result.current.error?.message).toBe('Insufficient escrow balance');
  });

  it('estimates gas fees and runs pre-flight simulation', async () => {
    const { result } = renderHook(() =>
      useCommerce({
        client: mockCommerceClient as unknown as CommerceClient,
        signer: mockSigner,
      }),
    );

    const params = {
      provider: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAA',
      evaluator: 'GCIZ3GHMYKJWF2POGBOUQ25J4DCW22LQ6K3N4V56ZJAAAKO456XYZAAA',
      budget: 10_000_000n,
      description: 'Simulate fee',
    };

    let fee: bigint = 0n;
    let xdr: string = '';
    await act(async () => {
      fee = await result.current.estimateGasFee(params);
      xdr = await result.current.simulate(params);
    });

    expect(fee).toBe(150000n);
    expect(xdr).toBe('unsignedSimulationXdr');
  });
});

describe('useTransaction', () => {
  it('starts in idle with null txHash and error', () => {
    const { result } = renderHook(() => useTransaction());

    expect(result.current.status).toBe('idle');
    expect(result.current.txHash).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('transitions idle -> signing -> submitted -> confirmed and exposes tx hash', async () => {
    const { result } = renderHook(() => useTransaction());

    const seen: string[] = [];
    let resolveSign: (value: string) => void = () => {};
    let resolveSubmit: (value: string) => void = () => {};

    let runPromise: Promise<string | null>;
    act(() => {
      runPromise = result.current.run({
        sign: () =>
          new Promise<string>((resolve) => {
            resolveSign = resolve;
          }),
        submit: () =>
          new Promise<string>((resolve) => {
            resolveSubmit = resolve;
          }),
      });
    });

    seen.push(result.current.status);
    expect(result.current.status).toBe('signing');

    await act(async () => {
      resolveSign('signedXdr');
      await Promise.resolve();
    });

    seen.push(result.current.status);
    expect(result.current.status).toBe('submitted');

    let hash: string | null = null;
    await act(async () => {
      resolveSubmit('tx-hash-abc');
      hash = await runPromise;
    });

    seen.push(result.current.status);
    expect(seen).toEqual(['signing', 'submitted', 'confirmed']);
    expect(hash).toBe('tx-hash-abc');
    expect(result.current.status).toBe('confirmed');
    expect(result.current.txHash).toBe('tx-hash-abc');
    expect(result.current.error).toBeNull();
  });

  it('transitions idle -> signing -> failed and clears tx hash', async () => {
    const { result } = renderHook(() => useTransaction());

    await act(async () => {
      try {
        await result.current.run({
          sign: () => Promise.resolve('signedXdr'),
          submit: () => Promise.reject(new Error('submit failed')),
        });
      } catch {
        // Expected
      }
    });

    expect(result.current.status).toBe('failed');
    expect(result.current.txHash).toBeNull();
    expect(result.current.error?.message).toBe('submit failed');
  });

  it('resets back to idle', async () => {
    const { result } = renderHook(() => useTransaction());

    await act(async () => {
      await result.current.run({
        sign: () => Promise.resolve('signedXdr'),
        submit: () => Promise.resolve('tx-hash-xyz'),
      });
    });

    expect(result.current.status).toBe('confirmed');
    expect(result.current.txHash).toBe('tx-hash-xyz');

    act(() => {
      result.current.reset();
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.txHash).toBeNull();
    expect(result.current.error).toBeNull();
  });
});
