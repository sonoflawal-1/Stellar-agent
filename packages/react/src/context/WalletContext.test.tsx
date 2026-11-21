import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { WalletProvider, useWalletContext } from './WalletContext';
import { useWallet } from '../hooks/useWallet';

const freighterMock = {
  isConnected: vi.fn().mockResolvedValue(true),
  getPublicKey: vi.fn().mockResolvedValue('GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTBVDJ42LPBK4EK4YLYL2QQ5K'),
  getNetwork: vi.fn().mockResolvedValue('TESTNET'),
  signTransaction: vi.fn().mockResolvedValue('signedXdrFreighter'),
  requestAccess: vi.fn().mockResolvedValue({
    publicKey: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTBVDJ42LPBK4EK4YLYL2QQ5K',
  }),
};

vi.mock('@stellar/freighter-api', () => ({
  default: freighterMock,
  ...freighterMock,
}));

describe('WalletProvider and useWalletContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws error when useWalletContext is invoked outside of WalletProvider', () => {
    expect(() => {
      renderHook(() => useWalletContext());
    }).toThrow(/useWalletContext must be used within a WalletProvider/);
  });

  it('shares wallet connection across children within WalletProvider', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <WalletProvider>{children}</WalletProvider>
    );

    const { result } = renderHook(() => useWallet(), { wrapper });

    expect(result.current.connected).toBe(false);
    expect(result.current.address).toBeNull();

    await act(async () => {
      await result.current.connect('freighter');
    });

    expect(result.current.connected).toBe(true);
    expect(result.current.address).toBe(
      'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTBVDJ42LPBK4EK4YLYL2QQ5K',
    );
    expect(result.current.walletType).toBe('freighter');

    // Test signTransaction
    let signedXdr: string = '';
    await act(async () => {
      signedXdr = await result.current.signTransaction('unsignedXdr');
    });
    expect(signedXdr).toBe('signedXdrFreighter');
  });
});
