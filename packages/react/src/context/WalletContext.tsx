'use client';

import React, { createContext, useContext } from 'react';
import type { UseWalletOptions, UseWalletResult } from '../hooks/useWallet';
import { useWalletState } from '../hooks/useWallet';

export type WalletContextValue = UseWalletResult;

export const WalletContext = createContext<WalletContextValue | null>(null);

export interface WalletProviderProps {
  children: React.ReactNode;
  options?: UseWalletOptions;
}

/**
 * WalletProvider wraps application components with shared Stellar wallet context.
 * Enables synchronized multi-wallet connections, account listening, and automatic balance tracking.
 */
export function WalletProvider({ children, options }: WalletProviderProps): React.ReactElement {
  const wallet = useWalletState(options);
  return <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>;
}

/**
 * Hook to access the ambient WalletContext. Throws if called outside a WalletProvider.
 */
export function useWalletContext(): WalletContextValue {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error('useWalletContext must be used within a WalletProvider.');
  }
  return context;
}

export default WalletProvider;
