import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { Keypair } from '@stellar/stellar-sdk';
import type { CommerceClient, Signer } from 'marc-stellar-sdk';
import { usePaymentChannel } from './usePaymentChannel';

const voucherKp = Keypair.random();
const mockPayer: Signer = {
  publicKey: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTBVDJ42LPBK4EK4YLYL2QQ5K',
  signTransaction: vi.fn().mockResolvedValue('signedXdr'),
};

describe('usePaymentChannel', () => {
  let mockCommerceClient: {
    openChannel: ReturnType<typeof vi.fn>;
    closeChannel: ReturnType<typeof vi.fn>;
    forceClose: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockCommerceClient = {
      openChannel: vi.fn().mockResolvedValue({
        channelId: 999n,
        createVoucher: vi.fn(),
      }),
      closeChannel: vi.fn().mockResolvedValue(undefined),
      forceClose: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('generates valid cryptographic vouchers off-chain in <5ms', () => {
    const { result } = renderHook(() =>
      usePaymentChannel(100n, {
        initialDeposit: 10_000_000n,
        voucherKeypair: voucherKp,
        client: mockCommerceClient as unknown as CommerceClient,
      }),
    );

    const start = performance.now();
    let voucher: ReturnType<typeof result.current.createVoucher>;

    act(() => {
      voucher = result.current.createVoucher(500_000n);
    });

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5); // Acceptance criteria: <5ms

    expect(voucher!).toBeDefined();
    expect(voucher!.channelId).toBe(100n);
    expect(voucher!.amount).toBe(500_000n);
    expect(voucher!.nonce).toBe(1n);
    expect(voucher!.signature).toBeInstanceOf(Uint8Array);

    const isValid = result.current.verifyVoucher(voucher!);
    expect(isValid).toBe(true);
  });

  it('computes real-time channel utilization percentage', () => {
    const { result } = renderHook(() =>
      usePaymentChannel(100n, {
        initialDeposit: 1_000_000n,
        voucherKeypair: voucherKp,
      }),
    );

    expect(result.current.utilization).toBe(0);
    expect(result.current.remaining).toBe(1_000_000n);

    act(() => {
      result.current.createVoucher(250_000n);
    });

    expect(result.current.spent).toBe(250_000n);
    expect(result.current.remaining).toBe(750_000n);
    expect(result.current.utilization).toBe(25); // 25%

    act(() => {
      result.current.createVoucher(250_000n);
    });

    expect(result.current.spent).toBe(500_000n);
    expect(result.current.remaining).toBe(500_000n);
    expect(result.current.utilization).toBe(50); // 50%
  });

  it('enforces monotonic nonce and deposit boundary check', () => {
    const { result } = renderHook(() =>
      usePaymentChannel(100n, {
        initialDeposit: 1_000_000n,
        voucherKeypair: voucherKp,
      }),
    );

    act(() => {
      result.current.createVoucher(100_000n);
    });
    expect(result.current.nonce).toBe(1n);

    act(() => {
      result.current.createVoucher(100_000n);
    });
    expect(result.current.nonce).toBe(2n);

    // Attempting to exceed deposit throws
    expect(() => {
      act(() => {
        result.current.createVoucher(900_000n);
      });
    }).toThrow(/Channel deposit exceeded/);
  });

  it('opens a new on-chain payment channel', async () => {
    const { result } = renderHook(() =>
      usePaymentChannel(null, {
        client: mockCommerceClient as unknown as CommerceClient,
        payerSigner: mockPayer,
        voucherKeypair: voucherKp,
      }),
    );

    let id: bigint = 0n;
    await act(async () => {
      id = await result.current.openChannel({
        provider: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAA',
        deposit: 5_000_000n,
      });
    });

    expect(id).toBe(999n);
    expect(result.current.channelId).toBe(999n);
    expect(result.current.deposit).toBe(5_000_000n);
    expect(result.current.isOpen).toBe(true);
    expect(mockCommerceClient.openChannel).toHaveBeenCalled();
  });

  it('handles cooperative close and force close workflows', async () => {
    const { result } = renderHook(() =>
      usePaymentChannel(100n, {
        initialDeposit: 1_000_000n,
        voucherKeypair: voucherKp,
        client: mockCommerceClient as unknown as CommerceClient,
        payerSigner: mockPayer,
      }),
    );

    let voucher: ReturnType<typeof result.current.createVoucher>;
    act(() => {
      voucher = result.current.createVoucher(300_000n);
    });

    // Cooperative closure
    await act(async () => {
      await result.current.closeChannel(voucher);
    });

    expect(mockCommerceClient.closeChannel).toHaveBeenCalledWith(
      100n,
      voucher!,
      mockPayer,
    );

    // Force close dispute settlement
    await act(async () => {
      await result.current.forceClose();
    });

    expect(mockCommerceClient.forceClose).toHaveBeenCalledWith(mockPayer, 100n);
  });
});
