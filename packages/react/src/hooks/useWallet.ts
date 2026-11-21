'use client';

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { WalletContext } from '../context/WalletContext';

/**
 * Supported Stellar wallet providers.
 */
export type WalletProvider = 'freighter' | 'xbull' | 'albedo';

/**
 * Connection status of the wallet.
 */
export type WalletStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Balances for native XLM and SAC USDC.
 */
export interface WalletBalances {
  xlm: string | null;
  usdc: string | null;
}

/**
 * Options accepted by the useWallet hook and WalletProvider.
 */
export interface UseWalletOptions {
  /**
   * Whether to auto-connect to the last selected wallet provider on mount.
   * @default true
   */
  autoConnect?: boolean;
  /**
   * localStorage key used to persist the active provider.
   * @default 'marc-stellar:wallet-provider'
   */
  storageKey?: string;
  /**
   * Horizon server URL for balance lookups.
   * @default 'https://horizon.stellar.org'
   */
  horizonUrl?: string;
  /**
   * Called after a successful connection.
   */
  onConnect?: (address: string, provider: WalletProvider) => void;
  /**
   * Called after disconnection.
   */
  onDisconnect?: () => void;
  /**
   * Called when a connection attempt fails.
   */
  onError?: (error: Error) => void;
}

/**
 * Result returned by the useWallet hook.
 */
export interface UseWalletResult {
  /** Connected public key (G...), or null when disconnected. */
  address: string | null;
  /** Alias for address to support both naming conventions. */
  publicKey: string | null;
  /** True when a wallet is connected. */
  connected: boolean;
  /** Alias for connected. */
  isConnected: boolean;
  /** Active wallet provider identifier. */
  walletType: WalletProvider | null;
  /** Alias for walletType. */
  wallet: WalletProvider | null;
  /** Alias for walletType. */
  provider: WalletProvider | null;
  /** Current connection status. */
  status: WalletStatus;
  /** True while a connection attempt is in flight. */
  isConnecting: boolean;
  /** True after component has mounted on client (SSR-safe flag). */
  isMounted: boolean;
  /** Formatted native XLM balance, or null when unavailable. */
  balance: string | null;
  /** Detailed balances including XLM and USDC. */
  balances: WalletBalances;
  /** Last error encountered during connect/disconnect/sign, if any. */
  error: Error | null;
  /** Connect to the specified wallet provider. */
  connect: (provider: WalletProvider) => Promise<void>;
  /** Disconnect the active wallet. */
  disconnect: () => Promise<void>;
  /** Switch to a different wallet provider. */
  switchWallet: (provider: WalletProvider) => Promise<void>;
  /** Sign transaction XDR using the active wallet. */
  signTransaction: (xdr: string, opts?: { networkPassphrase?: string }) => Promise<string>;
  /** Manually refresh XLM and USDC balances. */
  refreshBalance: () => Promise<void>;
}

const DEFAULT_STORAGE_KEY = 'marc-stellar:wallet-provider';
const DEFAULT_HORIZON_URL = 'https://horizon.stellar.org';

const isBrowser = (): boolean => typeof window !== 'undefined';

const safeGetStorage = (key: string): string | null => {
  if (!isBrowser()) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const safeSetStorage = (key: string, value: string): void => {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage errors
  }
};

const safeRemoveStorage = (key: string): void => {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore
  }
};

const isWalletProvider = (value: unknown): value is WalletProvider =>
  value === 'freighter' || value === 'xbull' || value === 'albedo';

interface FreighterApi {
  isConnected?: () => Promise<boolean>;
  requestAccess?: () => Promise<{ address?: string; publicKey?: string } | string>;
  getPublicKey?: () => Promise<string>;
  getAddress?: () => Promise<{ address?: string; publicKey?: string } | string>;
  getNetwork?: () => Promise<string>;
  signTransaction?: (xdr: string, opts?: unknown) => Promise<string | { signedTxXdr?: string }>;
}

interface XBullApi {
  connect?: () => Promise<{ publicKey?: string; address?: string } | string>;
  getPublicKey?: () => Promise<string>;
  getNetwork?: () => Promise<string>;
  disconnect?: () => Promise<void>;
  signTransaction?: (xdr: string, opts?: unknown) => Promise<string | { signedTxXdr?: string }>;
}

interface AlbedoApi {
  connect?: () => Promise<{ publicKey?: string; pubkey?: string } | string>;
  publicKey?: (opts?: Record<string, unknown>) => Promise<{ pubkey?: string; publicKey?: string } | string>;
  getPublicKey?: () => Promise<string>;
  getNetwork?: () => Promise<string>;
  disconnect?: () => Promise<void>;
  signTransaction?: (xdr: string, opts?: unknown) => Promise<string>;
  tx?: (opts: { xdr: string; [key: string]: unknown }) => Promise<{ signed_envelope_xdr?: string; xdr?: string }>;
}

interface WalletWindow extends Window {
  freighterApi?: FreighterApi;
  freighter?: FreighterApi;
  xBullSDK?: XBullApi;
  albedo?: AlbedoApi;
}

const getWalletWindow = (): WalletWindow | null =>
  isBrowser() ? (window as unknown as WalletWindow) : null;

const extractAddress = (value: unknown): string | null => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.address === 'string') return obj.address;
    if (typeof obj.publicKey === 'string') return obj.publicKey;
    if (typeof obj.pubkey === 'string') return obj.pubkey;
  }
  return null;
};

/** Connect Freighter using module adapter with window fallback */
const connectFreighter = async (): Promise<string> => {
  let address: string | null = null;

  try {
    const freighter = await import('@stellar/freighter-api');
    const api = (freighter.default || freighter) as FreighterApi;
    if (typeof api.requestAccess === 'function') {
      const res = await api.requestAccess();
      address = extractAddress(res);
    }
    if (!address && typeof api.getPublicKey === 'function') {
      address = extractAddress(await api.getPublicKey());
    }
    if (!address && typeof api.getAddress === 'function') {
      address = extractAddress(await api.getAddress());
    }
  } catch {
    // Module not found or mock environment
  }

  if (!address) {
    const win = getWalletWindow();
    const api = win?.freighterApi ?? win?.freighter;
    if (api) {
      if (typeof api.requestAccess === 'function') {
        address = extractAddress(await api.requestAccess());
      }
      if (!address && typeof api.getAddress === 'function') {
        address = extractAddress(await api.getAddress());
      }
      if (!address && typeof api.getPublicKey === 'function') {
        address = extractAddress(await api.getPublicKey());
      }
    }
  }

  if (address) return address;
  throw new Error('Freighter wallet is not installed or access was rejected.');
};

/** Connect xBull using module adapter with window fallback */
const connectXBull = async (): Promise<string> => {
  let address: string | null = null;

  try {
    const xbull = await import('@creit.tech/xbull-wallet-connect');
    const api = (xbull.default || xbull) as XBullApi;
    if (typeof api.connect === 'function') {
      const res = await api.connect();
      address = extractAddress(res);
    }
    if (!address && typeof api.getPublicKey === 'function') {
      address = extractAddress(await api.getPublicKey());
    }
  } catch {
    // Module not found or mock environment
  }

  if (!address) {
    const win = getWalletWindow();
    const api = win?.xBullSDK;
    if (api) {
      if (typeof api.connect === 'function') {
        address = extractAddress(await api.connect());
      }
      if (!address && typeof api.getPublicKey === 'function') {
        address = extractAddress(await api.getPublicKey());
      }
    }
  }

  if (address) return address;
  throw new Error('xBull wallet is not installed or connection failed.');
};

/** Connect Albedo using module adapter with window fallback */
const connectAlbedo = async (): Promise<string> => {
  let address: string | null = null;

  try {
    const albedo = await import('@albedo-link/intent');
    const api = (albedo.default || albedo) as AlbedoApi;
    if (typeof api.connect === 'function') {
      const res = await api.connect();
      address = extractAddress(res);
    }
    if (!address && typeof api.getPublicKey === 'function') {
      address = extractAddress(await api.getPublicKey());
    }
    if (!address && typeof api.publicKey === 'function') {
      const res = await api.publicKey();
      address = extractAddress(res);
    }
  } catch {
    // Module not found or mock environment
  }

  if (!address) {
    const win = getWalletWindow();
    const api = win?.albedo;
    if (api) {
      if (typeof api.connect === 'function') {
        address = extractAddress(await api.connect());
      }
      if (!address && typeof api.getPublicKey === 'function') {
        address = extractAddress(await api.getPublicKey());
      }
      if (!address && typeof api.publicKey === 'function') {
        address = extractAddress(await api.publicKey());
      }
    }
  }

  if (address) return address;
  throw new Error('Albedo wallet is not available.');
};

const connectProvider = async (provider: WalletProvider): Promise<string> => {
  switch (provider) {
    case 'freighter':
      return connectFreighter();
    case 'xbull':
      return connectXBull();
    case 'albedo':
      return connectAlbedo();
    default:
      throw new Error(`Unsupported wallet provider: ${String(provider)}`);
  }
};

const disconnectProvider = async (provider: WalletProvider | null): Promise<void> => {
  if (!provider) return;
  if (provider === 'xbull') {
    try {
      const xbull = await import('@creit.tech/xbull-wallet-connect');
      const api = (xbull.default || xbull) as XBullApi;
      if (typeof api.disconnect === 'function') {
        await api.disconnect();
      }
    } catch (err) {
      const win = getWalletWindow();
      if (win?.xBullSDK && typeof win.xBullSDK.disconnect === 'function') {
        await win.xBullSDK.disconnect();
      } else {
        throw err;
      }
    }
  } else if (provider === 'albedo') {
    try {
      const albedo = await import('@albedo-link/intent');
      const api = (albedo.default || albedo) as AlbedoApi;
      if (typeof api.disconnect === 'function') {
        await api.disconnect();
      }
    } catch (err) {
      const win = getWalletWindow();
      if (win?.albedo && typeof win.albedo.disconnect === 'function') {
        await win.albedo.disconnect();
      } else {
        throw err;
      }
    }
  }
};

const fetchTokenBalances = async (
  address: string,
  horizonUrl: string,
): Promise<WalletBalances> => {
  if (!isBrowser() || typeof fetch !== 'function') {
    return { xlm: null, usdc: null };
  }
  try {
    const res = await fetch(`${horizonUrl}/accounts/${encodeURIComponent(address)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return { xlm: null, usdc: null };
    const data = (await res.json()) as {
      balances?: Array<{ asset_type?: string; asset_code?: string; balance?: string }>;
    };

    const native = data.balances?.find((b) => b.asset_type === 'native');
    const usdc = data.balances?.find((b) => b.asset_code === 'USDC');

    return {
      xlm: native?.balance ?? null,
      usdc: usdc?.balance ?? null,
    };
  } catch {
    return { xlm: null, usdc: null };
  }
};

/**
 * Underlying wallet state manager.
 */
export function useWalletState(options: UseWalletOptions = {}): UseWalletResult {
  const {
    autoConnect = false,
    storageKey = DEFAULT_STORAGE_KEY,
    horizonUrl = DEFAULT_HORIZON_URL,
    onConnect,
    onDisconnect,
    onError,
  } = options;

  const [isMounted, setIsMounted] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [balances, setBalances] = useState<WalletBalances>({ xlm: null, usdc: null });
  const [provider, setProvider] = useState<WalletProvider | null>(null);
  const [status, setStatus] = useState<WalletStatus>('disconnected');
  const [error, setError] = useState<Error | null>(null);

  const connectRunId = useRef(0);
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onConnectRef.current = onConnect;
  }, [onConnect]);

  useEffect(() => {
    onDisconnectRef.current = onDisconnect;
  }, [onDisconnect]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const refreshBalance = useCallback(async () => {
    if (!address) {
      setBalances({ xlm: null, usdc: null });
      return;
    }
    const nextBalances = await fetchTokenBalances(address, horizonUrl);
    setBalances(nextBalances);
  }, [address, horizonUrl]);

  const connect = useCallback(
    async (nextProvider: WalletProvider) => {
      if (!isWalletProvider(nextProvider)) {
        const err = new Error(`Unsupported wallet provider: ${String(nextProvider)}`);
        setError(err);
        setStatus('error');
        onErrorRef.current?.(err);
        return;
      }

      const runId = ++connectRunId.current;
      setStatus('connecting');
      setError(null);
      setProvider(nextProvider);

      try {
        const nextAddress = await connectProvider(nextProvider);
        if (runId !== connectRunId.current) return;

        setAddress(nextAddress);
        setStatus('connected');
        safeSetStorage(storageKey, nextProvider);
        onConnectRef.current?.(nextAddress, nextProvider);

        const nextBalances = await fetchTokenBalances(nextAddress, horizonUrl);
        if (runId !== connectRunId.current) return;
        setBalances(nextBalances);
      } catch (err) {
        if (runId !== connectRunId.current) return;
        const normalized = err instanceof Error ? err : new Error(String(err));
        setAddress(null);
        setBalances({ xlm: null, usdc: null });
        setStatus('error');
        setError(normalized);
        onErrorRef.current?.(normalized);
      }
    },
    [horizonUrl, storageKey],
  );

  const disconnect = useCallback(async () => {
    const activeProvider = provider;
    try {
      await disconnectProvider(activeProvider);
      setAddress(null);
      setBalances({ xlm: null, usdc: null });
      setProvider(null);
      setStatus('disconnected');
      setError(null);
      safeRemoveStorage(storageKey);
      onDisconnectRef.current?.();
    } catch (err) {
      const normalized = err instanceof Error ? err : new Error(String(err));
      setError(normalized);
      setStatus('error');
      onErrorRef.current?.(normalized);
    }
  }, [provider, storageKey]);

  const switchWallet = useCallback(
    async (nextProvider: WalletProvider) => {
      await disconnect();
      await connect(nextProvider);
    },
    [connect, disconnect],
  );

  const signTransaction = useCallback(
    async (xdr: string, opts?: { networkPassphrase?: string }): Promise<string> => {
      if (!provider) {
        throw new Error('Cannot sign transaction: no wallet connected.');
      }

      if (provider === 'freighter') {
        try {
          const freighter = await import('@stellar/freighter-api');
          const api = (freighter.default || freighter) as FreighterApi;
          if (typeof api.signTransaction === 'function') {
            const res = await api.signTransaction(xdr, opts);
            if (typeof res === 'string') return res;
            if (res && typeof (res as { signedTxXdr?: string }).signedTxXdr === 'string') {
              return (res as { signedTxXdr?: string }).signedTxXdr!;
            }
          }
        } catch {
          // Fall back to window
        }
        const win = getWalletWindow();
        const api = win?.freighterApi ?? win?.freighter;
        if (api && typeof api.signTransaction === 'function') {
          const res = await api.signTransaction(xdr, opts);
          return typeof res === 'string' ? res : (res as { signedTxXdr?: string })?.signedTxXdr ?? xdr;
        }
      } else if (provider === 'xbull') {
        try {
          const xbull = await import('@creit.tech/xbull-wallet-connect');
          const api = (xbull.default || xbull) as XBullApi;
          if (typeof api.signTransaction === 'function') {
            const res = await api.signTransaction(xdr, opts);
            return typeof res === 'string' ? res : (res as { signedTxXdr?: string })?.signedTxXdr ?? xdr;
          }
        } catch {
          // Fall back to window
        }
        const win = getWalletWindow();
        const api = win?.xBullSDK;
        if (api && typeof api.signTransaction === 'function') {
          const res = await api.signTransaction(xdr, opts);
          return typeof res === 'string' ? res : (res as { signedTxXdr?: string })?.signedTxXdr ?? xdr;
        }
      } else if (provider === 'albedo') {
        try {
          const albedo = await import('@albedo-link/intent');
          const api = (albedo.default || albedo) as AlbedoApi;
          if (typeof api.signTransaction === 'function') {
            return await api.signTransaction(xdr, opts);
          }
          if (typeof api.tx === 'function') {
            const res = await api.tx({ xdr, ...(opts as object) });
            return res.signed_envelope_xdr || res.xdr || xdr;
          }
        } catch {
          // Fall back to window
        }
        const win = getWalletWindow();
        const api = win?.albedo;
        if (api) {
          if (typeof api.signTransaction === 'function') {
            return await api.signTransaction(xdr, opts);
          }
          if (typeof api.tx === 'function') {
            const res = await api.tx({ xdr, ...(opts as object) });
            return res.signed_envelope_xdr || res.xdr || xdr;
          }
        }
      }

      throw new Error(`signTransaction not supported for provider: ${provider}`);
    },
    [provider],
  );

  // Auto-connect on mount if previous session stored
  useEffect(() => {
    setIsMounted(true);
    if (!isBrowser()) return;

    if (autoConnect) {
      const stored = safeGetStorage(storageKey);
      if (isWalletProvider(stored)) {
        void connect(stored);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for account/network changes
  useEffect(() => {
    if (!isBrowser() || status !== 'connected' || !address) return;

    let active = true;
    const interval = setInterval(async () => {
      try {
        if (provider === 'freighter') {
          const freighter = await import('@stellar/freighter-api');
          const api = (freighter.default || freighter) as FreighterApi;
          if (typeof api.getPublicKey === 'function') {
            const currentPk = await api.getPublicKey();
            if (active && currentPk && currentPk !== address) {
              setAddress(currentPk);
              void refreshBalance();
            }
          }
        }
      } catch {
        // Ignore background polling errors
      }
    }, 4000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [address, provider, refreshBalance, status]);

  const isConnecting = status === 'connecting';
  const isConnected = status === 'connected' && address !== null;

  return useMemo<UseWalletResult>(
    () => ({
      address,
      publicKey: address,
      connected: isConnected,
      isConnected,
      walletType: provider,
      wallet: provider,
      provider,
      status,
      isConnecting,
      isMounted,
      balance: balances.xlm,
      balances,
      error,
      connect,
      disconnect,
      switchWallet,
      signTransaction,
      refreshBalance,
    }),
    [
      address,
      balances,
      connect,
      disconnect,
      error,
      isConnected,
      isConnecting,
      isMounted,
      provider,
      refreshBalance,
      signTransaction,
      status,
      switchWallet,
    ],
  );
}

/**
 * useWallet hook accessing ambient WalletProvider context when present,
 * or managing local wallet state when used standalone.
 */
export function useWallet(options?: UseWalletOptions): UseWalletResult {
  const context = useContext(WalletContext);
  const standalone = useWalletState(options);
  return context ?? standalone;
}

export default useWallet;
