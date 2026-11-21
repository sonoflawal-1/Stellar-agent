'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keypair } from '@stellar/stellar-sdk';
import type { CommerceClient, Signer, ChannelVoucher } from 'marc-stellar-sdk';
import { createChannelVoucher, verifyChannelVoucher } from 'marc-stellar-sdk';
import { useWallet } from './useWallet';

export interface OpenChannelParams {
  provider: string;
  deposit: bigint | string | number;
  token?: string;
  payer?: Signer;
  voucherKeypair?: Keypair;
}

export interface UsePaymentChannelOptions {
  client?: CommerceClient;
  voucherKeypair?: Keypair;
  initialDeposit?: bigint | string | number;
  payerSigner?: Signer;
  storageKeyPrefix?: string;
}

export interface UsePaymentChannelResult {
  /** Current channel ID, or null if no channel is active. */
  channelId: bigint | null;
  /** Total tokens deposited into escrow for this channel. */
  deposit: bigint;
  /** Cumulative amount spent across all issued vouchers. */
  spent: bigint;
  /** Remaining unspent balance in the channel. */
  remaining: bigint;
  /** Real-time channel utilization percentage (0 - 100). */
  utilization: number;
  /** Current monotonic voucher nonce. */
  nonce: bigint;
  /** The most recent cryptographic voucher generated. */
  latestVoucher: ChannelVoucher | null;
  /** True if the channel is currently open and funded. */
  isOpen: boolean;
  /** True while an on-chain transaction (open, close, forceClose) is in flight. */
  isPending: boolean;
  /** Error from the most recent failed operation, if any. */
  error: Error | null;
  /** Open an escrowed micropayment channel on-chain. */
  openChannel: (params: OpenChannelParams) => Promise<bigint>;
  /**
   * Instantly generate an off-chain cryptographic Ed25519 voucher (<5ms).
   *
   * @param amountOrIncrement Amount to allocate or increment by.
   * @param isIncremental If true, adds to previously spent amount. Defaults to true.
   */
  createVoucher: (amountOrIncrement: bigint | string | number, isIncremental?: boolean) => ChannelVoucher;
  /** Verify a voucher's Ed25519 signature off-chain. */
  verifyVoucher: (voucher: ChannelVoucher, publicKey?: string) => boolean;
  /** Cooperatively close the channel by submitting the highest voucher. */
  closeChannel: (voucher?: ChannelVoucher, participant?: Signer) => Promise<void>;
  /** Dispute / timeout closure: settle the channel after its challenge period. */
  forceClose: (caller?: Signer) => Promise<void>;
  /** Reset local channel state and clear storage. */
  reset: () => void;
}

const DEFAULT_PREFIX = 'marc-stellar:channel:';

function getStoredValue(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setStoredValue(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage quota or access errors
  }
}

function removeStoredValue(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore
  }
}

/**
 * usePaymentChannel manages off-chain micropayment channels, real-time voucher
 * generation with monotonic nonce ordering, and on-chain settlement.
 */
export function usePaymentChannel(
  initialChannelId?: bigint | string | number | null,
  options: UsePaymentChannelOptions = {},
): UsePaymentChannelResult {
  const {
    client: clientProp,
    voucherKeypair: initialVoucherKeypair,
    initialDeposit = 0n,
    payerSigner: initialPayerSigner,
    storageKeyPrefix = DEFAULT_PREFIX,
  } = options;

  const wallet = useWallet();

  const [channelId, setChannelId] = useState<bigint | null>(() => {
    if (initialChannelId !== null && initialChannelId !== undefined) {
      try {
        return BigInt(initialChannelId);
      } catch {
        return null;
      }
    }
    return null;
  });

  const [deposit, setDeposit] = useState<bigint>(() => BigInt(initialDeposit));
  const [spent, setSpent] = useState<bigint>(0n);
  const [nonce, setNonce] = useState<bigint>(0n);
  const [latestVoucher, setLatestVoucher] = useState<ChannelVoucher | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // In-memory keypair for signing vouchers
  const voucherKpRef = useRef<Keypair>(initialVoucherKeypair ?? Keypair.random());

  // Load persisted state if channelId exists
  useEffect(() => {
    if (channelId === null) return;
    const key = `${storageKeyPrefix}${channelId.toString()}`;
    const raw = getStoredValue(key);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.deposit) setDeposit(BigInt(parsed.deposit));
        if (parsed.spent) setSpent(BigInt(parsed.spent));
        if (parsed.nonce) setNonce(BigInt(parsed.nonce));
      } catch {
        // Ignore parse error
      }
    }
  }, [channelId, storageKeyPrefix]);

  const saveChannelState = useCallback(
    (id: bigint, newDeposit: bigint, newSpent: bigint, newNonce: bigint) => {
      const key = `${storageKeyPrefix}${id.toString()}`;
      setStoredValue(
        key,
        JSON.stringify({
          channelId: id.toString(),
          deposit: newDeposit.toString(),
          spent: newSpent.toString(),
          nonce: newNonce.toString(),
        }),
      );
    },
    [storageKeyPrefix],
  );

  const getClient = useCallback(async (): Promise<CommerceClient> => {
    if (clientProp) return clientProp;
    const sdk = await import('marc-stellar-sdk');
    return new sdk.CommerceClient();
  }, [clientProp]);

  const resolveSigner = useCallback(
    (explicitSigner?: Signer): Signer => {
      if (explicitSigner) return explicitSigner;
      if (initialPayerSigner) return initialPayerSigner;
      if (wallet.address) {
        return {
          publicKey: wallet.address,
          signTransaction: async (xdr: string, opts: { networkPassphrase: string }) => {
            if (typeof wallet.signTransaction === 'function') {
              return wallet.signTransaction(xdr, opts);
            }
            throw new Error('Connected wallet cannot sign transactions.');
          },
        };
      }
      throw new Error('No payer signer provided and no wallet is connected.');
    },
    [initialPayerSigner, wallet.address, wallet.signTransaction],
  );

  const openChannel = useCallback(
    async (params: OpenChannelParams): Promise<bigint> => {
      setIsPending(true);
      setError(null);

      try {
        const client = await getClient();
        const payer = resolveSigner(params.payer);
        const kp = params.voucherKeypair ?? voucherKpRef.current;
        voucherKpRef.current = kp;

        const dep = BigInt(params.deposit);
        const token = params.token ?? 'CA76YNCFOHQVNWOJSTNRDKW3PF7MBVH3REO4IZWB4QPAOB6SIIS4YKEP';

        const session = await client.openChannel(payer, params.provider, dep, kp, token);

        const newId = session.channelId;
        setChannelId(newId);
        setDeposit(dep);
        setSpent(0n);
        setNonce(0n);
        setLatestVoucher(null);

        saveChannelState(newId, dep, 0n, 0n);

        return newId;
      } catch (err) {
        const normalized = err instanceof Error ? err : new Error(String(err));
        setError(normalized);
        throw normalized;
      } finally {
        setIsPending(false);
      }
    },
    [getClient, resolveSigner, saveChannelState],
  );

  const createVoucher = useCallback(
    (amountOrIncrement: bigint | string | number, isIncremental = true): ChannelVoucher => {
      if (channelId === null) {
        throw new Error('Cannot create voucher: no active payment channel.');
      }

      const delta = BigInt(amountOrIncrement);
      if (delta <= 0n) {
        throw new Error('Voucher amount must be positive.');
      }

      const nextSpent = isIncremental ? spent + delta : delta;

      if (deposit > 0n && nextSpent > deposit) {
        throw new Error(`Channel deposit exceeded: attempted ${nextSpent} but deposit is ${deposit}.`);
      }

      const nextNonce = nonce + 1n;
      const voucher = createChannelVoucher(channelId, nextSpent, nextNonce, voucherKpRef.current);

      setSpent(nextSpent);
      setNonce(nextNonce);
      setLatestVoucher(voucher);

      saveChannelState(channelId, deposit, nextSpent, nextNonce);

      return voucher;
    },
    [channelId, deposit, nonce, saveChannelState, spent],
  );

  const verifyVoucher = useCallback(
    (voucher: ChannelVoucher, publicKey?: string): boolean => {
      const pubkey = publicKey ?? voucherKpRef.current.publicKey();
      return verifyChannelVoucher(voucher, pubkey);
    },
    [],
  );

  const closeChannel = useCallback(
    async (voucher?: ChannelVoucher, participant?: Signer): Promise<void> => {
      if (channelId === null) {
        throw new Error('Cannot close channel: no active channel ID.');
      }

      const v = voucher ?? latestVoucher;
      if (!v) {
        throw new Error('Cannot close channel without a valid voucher.');
      }

      setIsPending(true);
      setError(null);

      try {
        const client = await getClient();
        const signer = resolveSigner(participant);
        await client.closeChannel(channelId, v, signer);
      } catch (err) {
        const normalized = err instanceof Error ? err : new Error(String(err));
        setError(normalized);
        throw normalized;
      } finally {
        setIsPending(false);
      }
    },
    [channelId, getClient, latestVoucher, resolveSigner],
  );

  const forceClose = useCallback(
    async (caller?: Signer): Promise<void> => {
      if (channelId === null) {
        throw new Error('Cannot force-close: no active channel ID.');
      }

      setIsPending(true);
      setError(null);

      try {
        const client = await getClient();
        const signer = resolveSigner(caller);
        await client.forceClose(signer, channelId);
      } catch (err) {
        const normalized = err instanceof Error ? err : new Error(String(err));
        setError(normalized);
        throw normalized;
      } finally {
        setIsPending(false);
      }
    },
    [channelId, getClient, resolveSigner],
  );

  const reset = useCallback(() => {
    if (channelId !== null) {
      removeStoredValue(`${storageKeyPrefix}${channelId.toString()}`);
    }
    setChannelId(null);
    setDeposit(0n);
    setSpent(0n);
    setNonce(0n);
    setLatestVoucher(null);
    setError(null);
  }, [channelId, storageKeyPrefix]);

  const remaining = useMemo(() => {
    return deposit > spent ? deposit - spent : 0n;
  }, [deposit, spent]);

  const utilization = useMemo(() => {
    if (deposit <= 0n) return 0;
    const pct = Number((spent * 10000n) / deposit) / 100;
    return Math.min(Math.max(pct, 0), 100);
  }, [deposit, spent]);

  const isOpen = channelId !== null && deposit > 0n;

  return {
    channelId,
    deposit,
    spent,
    remaining,
    utilization,
    nonce,
    latestVoucher,
    isOpen,
    isPending,
    error,
    openChannel,
    createVoucher,
    verifyVoucher,
    closeChannel,
    forceClose,
    reset,
  };
}

export default usePaymentChannel;
