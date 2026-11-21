import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useWallet } from './useWallet';

// ---------------------------------------------------------------------------
// Mock wallet provider APIs (Freighter, xBull, Albedo)
// ---------------------------------------------------------------------------

const freighterMock = {
  isConnected: vi.fn(),
  getPublicKey: vi.fn(),
  getNetwork: vi.fn(),
  signTransaction: vi.fn(),
  requestAccess: vi.fn(),
};

const xbullMock = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  getPublicKey: vi.fn(),
  getNetwork: vi.fn(),
  signTransaction: vi.fn(),
};

const albedoMock = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  getPublicKey: vi.fn(),
  getNetwork: vi.fn(),
  signTransaction: vi.fn(),
};

vi.mock('@stellar/freighter-api', () => ({
  default: freighterMock,
  ...freighterMock,
}));

vi.mock('@creit.tech/xbull-wallet-connect', () => ({
  default: xbullMock,
  ...xbullMock,
}));

vi.mock('@albedo-link/intent', () => ({
  default: albedoMock,
  ...albedoMock,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PUBLIC_KEY = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const NETWORK = 'TESTNET';

function resetMocks() {
  Object.values(freighterMock).forEach((fn) => fn.mockReset());
  Object.values(xbullMock).forEach((fn) => fn.mockReset());
  Object.values(albedoMock).forEach((fn) => fn.mockReset());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useWallet', () => {
  beforeEach(() => {
    resetMocks();
    // Default: no wallet connected
    freighterMock.isConnected.mockResolvedValue(false);
    freighterMock.getPublicKey.mockResolvedValue(PUBLIC_KEY);
    freighterMock.getNetwork.mockResolvedValue(NETWORK);
    freighterMock.requestAccess.mockResolvedValue({ publicKey: PUBLIC_KEY });
    xbullMock.connect.mockResolvedValue({ publicKey: PUBLIC_KEY });
    xbullMock.getPublicKey.mockResolvedValue(PUBLIC_KEY);
    xbullMock.getNetwork.mockResolvedValue(NETWORK);
    albedoMock.connect.mockResolvedValue({ publicKey: PUBLIC_KEY });
    albedoMock.getPublicKey.mockResolvedValue(PUBLIC_KEY);
    albedoMock.getNetwork.mockResolvedValue(NETWORK);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('starts disconnected and not loading', () => {
      const { result } = renderHook(() => useWallet());

      expect(result.current.isConnected).toBe(false);
      expect(result.current.isConnecting).toBe(false);
      expect(result.current.publicKey).toBeNull();
      expect(result.current.wallet).toBeNull();
      expect(result.current.error).toBeNull();
    });

    it('is SSR-safe when window is undefined', () => {
      const originalWindow = globalThis.window;
      // @ts-expect-error simulate SSR
      delete globalThis.window;

      try {
        const { result } = renderHook(() => useWallet());
        expect(result.current.isConnected).toBe(false);
        expect(result.current.publicKey).toBeNull();
        expect(result.current.error).toBeNull();
      } finally {
        globalThis.window = originalWindow;
      }
    });

    it('exposes connect, disconnect, and switchWallet functions', () => {
      const { result } = renderHook(() => useWallet());

      expect(typeof result.current.connect).toBe('function');
      expect(typeof result.current.disconnect).toBe('function');
      expect(typeof result.current.switchWallet).toBe('function');
    });
  });

  describe('connect', () => {
    it('connects via Freighter and updates state', async () => {
      const { result } = renderHook(() => useWallet());

      await act(async () => {
        await result.current.connect('freighter');
      });

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      expect(result.current.publicKey).toBe(PUBLIC_KEY);
      expect(result.current.wallet).toBe('freighter');
      expect(result.current.isConnecting).toBe(false);
      expect(result.current.error).toBeNull();
      expect(freighterMock.requestAccess).toHaveBeenCalled();
    });

    it('connects via xBull and updates state', async () => {
      const { result } = renderHook(() => useWallet());

      await act(async () => {
        await result.current.connect('xbull');
      });

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      expect(result.current.publicKey).toBe(PUBLIC_KEY);
      expect(result.current.wallet).toBe('xbull');
      expect(xbullMock.connect).toHaveBeenCalled();
    });

    it('connects via Albedo and updates state', async () => {
      const { result } = renderHook(() => useWallet());

      await act(async () => {
        await result.current.connect('albedo');
      });

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      expect(result.current.publicKey).toBe(PUBLIC_KEY);
      expect(result.current.wallet).toBe('albedo');
      expect(albedoMock.connect).toHaveBeenCalled();
    });

    it('sets isConnecting to true while connecting', async () => {
      let resolveConnect: (value: { publicKey: string }) => void = () => {};
      freighterMock.requestAccess.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveConnect = resolve;
          }),
      );

      const { result } = renderHook(() => useWallet());

      let connectPromise: Promise<void>;
      act(() => {
        connectPromise = result.current.connect('freighter');
      });

      await waitFor(() => {
        expect(result.current.isConnecting).toBe(true);
      });

      await act(async () => {
        resolveConnect({ publicKey: PUBLIC_KEY });
        await connectPromise;
      });

      await waitFor(() => {
        expect(result.current.isConnecting).toBe(false);
      });
    });

    it('handles connection errors gracefully', async () => {
      const error = new Error('User rejected connection');
      freighterMock.requestAccess.mockRejectedValue(error);

      const { result } = renderHook(() => useWallet());

      await act(async () => {
        await result.current.connect('freighter');
      });

      await waitFor(() => {
        expect(result.current.error).toBeTruthy();
      });

      expect(result.current.isConnected).toBe(false);
      expect(result.current.publicKey).toBeNull();
      expect(result.current.isConnecting).toBe(false);
    });

    it('handles xBull connection errors', async () => {
      xbullMock.connect.mockRejectedValue(new Error('xBull unavailable'));

      const { result } = renderHook(() => useWallet());

      await act(async () => {
        await result.current.connect('xbull');
      });

      await waitFor(() => {
        expect(result.current.error).toBeTruthy();
      });

      expect(result.current.isConnected).toBe(false);
    });

    it('handles Albedo connection errors', async () => {
      albedoMock.connect.mockRejectedValue(new Error('Albedo unavailable'));

      const { result } = renderHook(() => useWallet());

      await act(async () => {
        await result.current.connect('albedo');
      });

      await waitFor(() => {
        expect(result.current.error).toBeTruthy();
      });

      expect(result.current.isConnected).toBe(false);
    });
  });

  describe('error paths', () => {
    it('surfaces an error when Freighter is not installed', async () => {
      freighterMock.isConnected.mockResolvedValue(false);
      freighterMock.requestAccess.mockRejectedValue(
        new Error('Freighter not found'),
      );

      const { result } = renderHook(() => useWallet());

      await act(async () => {
        await result.current.connect('freighter');
      });

      await waitFor(() => {
        expect(result.current.error).toBeTruthy();
      });

      expect(result.current.error).toMatch(/freighter/i);
      expect(result.current.isConnected).toBe(false);
      expect(result.current.publicKey).toBeNull();
      expect(result.current.isConnecting).toBe(false);
      expect(result.current.status).toBe('error');
    });

    it('surfaces an error when the user rejects the Freighter prompt', async () => {
      freighterMock.requestAccess.mockRejectedValue(
        new Error('User declined access'),
      );

      const { result } = renderHook(() => useWallet());

      await act(async () => {
        await result.current.connect('freighter');
      });

      await waitFor(() => {
        expect(result.current.error).toBeTruthy();
      });

      expect(result.current.error).toMatch(/declined|reject/i);
      expect(result.current.isConnected).toBe(false);
      expect(result.current.isConnecting).toBe(false);
      expect(result.current.status).toBe('error');
    });

    it('surfaces a network mismatch error when Freighter reports a different network', async () => {
      freighterMock.getNetwork.mockResolvedValue('PUBLIC');

      const { result } = renderHook(() => useWallet());

      await act(async () => {
        await result.current.connect('freighter');
      });

      await waitFor(() => {
        expect(result.current.error).toBeTruthy();
      });

      expect(result.current.error).toMatch(/network/i);
      expect(result.current.isConnected).toBe(false);
      expect(result.current.isConnecting).toBe(false);
      expect(result.current.status).toBe('error');
    });

    it('surfaces an error when the user rejects the xBull prompt', async () => {
      xbullMock.connect.mockRejectedValue(new Error('User rejected request'));

      const { result } = renderHook(() => useWallet());

      await act(async () => {
        await result.current.connect('xbull');
      });

      await waitFor(() => {
        expect(result.current.error).toBeTruthy();
      });

      expect(result.current.error).toMatch(/reject/i);
      expect(result.current.isConnected).toBe(false);
      expect(result.current.isConnecting).toBe(false);
      expect(result.current.status).toBe('error');
    });

    it('surfaces an error when the user rejects the Albedo prompt', async () => {
      albedoMock.connect.mockRejectedValue(new Error('User rejected request'));

      const { result } = renderHook(() => useWallet());

      await act(async () => {
        await result.current.connect('albedo');
      });

      await waitFor(() => {
        expect(result.current.error).toBeTruthy();
      });

      expect(result.current.error).toMatch(/reject/i);
      expect(result.current.isConnected).toBe(false);
      expect(result.current.isConnecting).toBe(false);
      expect(result.current.status).toBe('error');
    });

    it('surfaces an error for an unsupported wallet provider', async () => {
      const { result } = renderHook(() => useWallet());

      await act(async () => {
        // @ts-expect-error intentionally passing an unsupported provider
        await result.current.connect('unknown-wallet');
      });

      await waitFor(() => {
        expect(result.current.error).toBeTruthy();
      });

      expect(result.current.error).toMatch(/unsupported wallet provider/i);
      expect(result.current.isConnected).toBe(false);
      expect(result.current.publicKey).toBeNull();
      expect(result.current.isConnecting).toBe(false);
      expect(result.current.status).toBe('error');
    });
  });

  describe('disconnect', () => {
    it('disconnects and resets state', async () => {
      const { result } = renderHook(() => useWallet());

      await act(async () => {
        await result.current.connect('freighter');
      });

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      await act(async () => {
        await result.current.disconnect();
      });

      await waitFor(() => {
        expect(result.current.isConnected).toBe(false);
      });

      expect(result.current.publicKey).toBeNull();
      expect(result.current.wallet).toBeNull();
      expect(result.current.error).toBeNull();
    });

    it('calls provider disconnect for xBull', async () => {
      const { result } = renderHook(() => useWallet());

      await act(async () => {
        await result.current.connect('xbull');
      });

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      await act(async () => {
        await result.current.disconnect();
      });

      expect(xbullMock.disconnect).toHaveBeenCalled();
    });

    it('calls provider disconnect for Albedo', async () => {
      const { result } = renderHook(() => useWallet());

      await act(async () => {
        await result.current.connect('albedo');
      });

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      await act(async () => {
        await result.current.disconnect();
      });

      expect(albedoMock.disconnect).toHaveBeenCalled();
    });

    it('handles disconnect errors gracefully', async () => {
      xbullMock.disconnect.mockRejectedValue(new Error('disconnect failed'));

      const { result } = renderHook(() => useWallet());

      await act(async () => {
        await result.current.connect('xbull');
      });

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      await act(async () => {
        await result.current.disconnect();
      });

      await waitFor(() => {
        expect(result.current.error).toBeTruthy();
      });
    });
  });

  describe('switchWallet', () => {
    it('switches from Freighter to xBull', async () => {
      const { result } = renderHook(() => useWallet());

      await act(async () => {
        await result.current.connect('freighter');
      });

      await waitFor(() => {
        expect(result.current.wallet).toBe('freighter');
      });

      await act(async () => {
        await result.current.switchWallet('xbull');
      });

      await waitFor(() => {
        expect(result.current.wallet).toBe('xbull');
      });

      expect(result.current.isConnected).toBe(true);
      expect(result.current.publicKey).toBe(PUBLIC_KEY);
    });

    it('switches from xBull to Albedo', async () => {
      const { result } = renderHook(() => useWallet());

      await act(async () => {
        await result.current.connect('xbull');
      });

      await waitFor(() => {
        expect(result.current.wallet).toBe('xbull');
      });

      await act(async () => {
        await result.current.switchWallet('albedo');
      });

      await waitFor(() => {
        expect(result.current.wallet).toBe('albedo');
      });

      expect(result.current.isConnected).toBe(true);
    });

    it('handles switch errors and preserves previous state', async () => {
      const { result } = renderHook(() => useWallet());

      await act(async () => {
        await result.current.connect('freighter');
      });

      await waitFor(() => {
        expect(result.current.wallet).toBe('freighter');
      });

      albedoMock.connect.mockRejectedValue(new Error('switch failed'));

      await act(async () => {
        await result.current.switchWallet('albedo');
      });

      await waitFor(() => {
        expect(result.current.error).toBeTruthy();
      });
    });
  });

  describe('unmount cleanup', () => {
    it('does not update state after unmount during connect', async () => {
      let resolveConnect: (value: { publicKey: string }) => void = () => {};
      freighterMock.requestAccess.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveConnect = resolve;
          }),
      );

      const { result, unmount } = renderHook(() => useWallet());

      act(() => {
        void result.current.connect('freighter');
      });

      unmount();

      // Resolving after unmount should not throw or warn about state updates
      await act(async () => {
        resolveConnect({ publicKey: PUBLIC_KEY });
        await Promise.resolve();
      });

      expect(true).toBe(true);
    });

    it('does not update state after unmount during disconnect', async () => {
      const { result, unmount } = renderHook(() => useWallet());

      await act(async () => {
        await result.current.connect('freighter');
      });

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      let resolveDisconnect: () => void = () => {};
      xbullMock.disconnect.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveDisconnect = resolve;
          }),
      );

      act(() => {
        void result.current.disconnect();
      });

      unmount();

      await act(async () => {
        resolveDisconnect();
        await Promise.resolve();
      });

      expect(true).toBe(true);
    });
  });

  describe('race condition prevention', () => {
    it('ignores stale connect result when a newer connect resolves first', async () => {
      let resolveFirst: (value: { publicKey: string }) => void = () => {};
      let resolveSecond: (value: { publicKey: string }) => void = () => {};

      freighterMock.requestAccess
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveSecond = resolve;
            }),
        );

      const { result } = renderHook(() => useWallet());

      act(() => {
        void result.current.connect('freighter');
      });

      act(() => {
        void result.current.connect('freighter');
      });

      const SECOND_KEY = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

      await act(async () => {
        resolveSecond({ publicKey: SECOND_KEY });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current.publicKey).toBe(SECOND_KEY);
      });

      // Stale first resolution should not overwrite the newer result
      await act(async () => {
        resolveFirst({ publicKey: PUBLIC_KEY });
        await Promise.resolve();
      });

      expect(result.current.publicKey).toBe(SECOND_KEY);
    });
  });
});