import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';

import { WalletConnectButton } from './WalletConnectButton';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockSwitchWallet = vi.fn();

const mockWalletState = {
  connected: false,
  address: null as string | null,
  balance: null as string | null,
  provider: null as string | null,
  connect: mockConnect,
  disconnect: mockDisconnect,
  switchWallet: mockSwitchWallet,
};

vi.mock('../hooks/useWallet', () => ({
  useWallet: () => mockWalletState,
}));

const CONNECTED_ADDRESS = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV';
const TRUNCATED_ADDRESS = 'GABC...UV';

const originalClipboard = navigator.clipboard;

beforeEach(() => {
  vi.clearAllMocks();
  mockWalletState.connected = false;
  mockWalletState.address = null;
  mockWalletState.balance = null;
  mockWalletState.provider = null;

  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
    writable: true,
  });

  Object.defineProperty(window, 'open', {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: originalClipboard,
    configurable: true,
    writable: true,
  });
});

function setConnected(overrides: Partial<typeof mockWalletState> = {}) {
  mockWalletState.connected = true;
  mockWalletState.address = CONNECTED_ADDRESS;
  mockWalletState.balance = '100.00 XLM';
  mockWalletState.provider = 'freighter';
  Object.assign(mockWalletState, overrides);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WalletConnectButton', () => {
  describe('disconnected state', () => {
    it('renders the Connect Wallet label with brand icon', () => {
      render(<WalletConnectButton />);

      const button = screen.getByRole('button', { name: /connect wallet/i });
      expect(button).toBeInTheDocument();
      expect(button).toHaveAttribute('aria-haspopup', 'dialog');
      expect(button).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByTestId('wallet-brand-icon')).toBeInTheDocument();
    });

    it('opens the wallet selection modal on click', async () => {
      const user = userEvent.setup();
      render(<WalletConnectButton />);

      await user.click(screen.getByRole('button', { name: /connect wallet/i }));

      const dialog = await screen.findByRole('dialog');
      expect(dialog).toBeInTheDocument();
      expect(within(dialog).getByText(/freighter/i)).toBeInTheDocument();
      expect(within(dialog).getByText(/xbull/i)).toBeInTheDocument();
      expect(within(dialog).getByText(/albedo/i)).toBeInTheDocument();
    });

    it('calls onConnect and connect when a provider is selected', async () => {
      const user = userEvent.setup();
      const onConnect = vi.fn();
      render(<WalletConnectButton onConnect={onConnect} />);

      await user.click(screen.getByRole('button', { name: /connect wallet/i }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /freighter/i }));

      expect(mockConnect).toHaveBeenCalledWith('freighter');
      await waitFor(() => expect(onConnect).toHaveBeenCalledWith('freighter'));
    });

    it('supports selecting xBull and Albedo providers', async () => {
      const user = userEvent.setup();
      render(<WalletConnectButton />);

      await user.click(screen.getByRole('button', { name: /connect wallet/i }));
      let dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /xbull/i }));
      expect(mockConnect).toHaveBeenCalledWith('xbull');

      await user.click(screen.getByRole('button', { name: /connect wallet/i }));
      dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /albedo/i }));
      expect(mockConnect).toHaveBeenCalledWith('albedo');
    });
  });

  describe('connected state', () => {
    it('displays truncated address, avatar glyph, and balance', () => {
      setConnected();
      render(<WalletConnectButton />);

      const button = screen.getByRole('button', { name: /wallet/i });
      expect(button).toBeInTheDocument();
      expect(screen.getByText(TRUNCATED_ADDRESS)).toBeInTheDocument();
      expect(screen.getByTestId('wallet-avatar')).toBeInTheDocument();
      expect(screen.getByText('100.00 XLM')).toBeInTheDocument();
    });

    it('opens the dropdown menu with all actions', async () => {
      setConnected();
      const user = userEvent.setup();
      render(<WalletConnectButton />);

      await user.click(screen.getByRole('button', { name: /wallet/i }));

      const menu = await screen.findByRole('menu');
      expect(within(menu).getByRole('menuitem', { name: /copy address/i })).toBeInTheDocument();
      expect(within(menu).getByRole('menuitem', { name: /view on explorer/i })).toBeInTheDocument();
      expect(within(menu).getByRole('menuitem', { name: /switch wallet/i })).toBeInTheDocument();
      expect(within(menu).getByRole('menuitem', { name: /disconnect/i })).toBeInTheDocument();
    });

    it('copies the address to the clipboard', async () => {
      setConnected();
      const user = userEvent.setup();
      render(<WalletConnectButton />);

      await user.click(screen.getByRole('button', { name: /wallet/i }));
      const menu = await screen.findByRole('menu');
      await user.click(within(menu).getByRole('menuitem', { name: /copy address/i }));

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(CONNECTED_ADDRESS);
    });

    it('opens the explorer in a new tab', async () => {
      setConnected();
      const user = userEvent.setup();
      render(<WalletConnectButton />);

      await user.click(screen.getByRole('button', { name: /wallet/i }));
      const menu = await screen.findByRole('menu');
      await user.click(within(menu).getByRole('menuitem', { name: /view on explorer/i }));

      expect(window.open).toHaveBeenCalled();
      const url = (window.open as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain(CONNECTED_ADDRESS);
    });

    it('switches wallet by reopening the selection modal', async () => {
      setConnected();
      const user = userEvent.setup();
      render(<WalletConnectButton />);

      await user.click(screen.getByRole('button', { name: /wallet/i }));
      const menu = await screen.findByRole('menu');
      await user.click(within(menu).getByRole('menuitem', { name: /switch wallet/i }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/freighter/i)).toBeInTheDocument();
    });

    it('disconnects the wallet', async () => {
      setConnected();
      const user = userEvent.setup();
      render(<WalletConnectButton />);

      await user.click(screen.getByRole('button', { name: /wallet/i }));
      const menu = await screen.findByRole('menu');
      await user.click(within(menu).getByRole('menuitem', { name: /disconnect/i }));

      expect(mockDisconnect).toHaveBeenCalled();
    });
  });

  describe('accessibility and keyboard controls', () => {
    it('toggles the dropdown with Enter and closes with Escape', async () => {
      setConnected();
      const user = userEvent.setup();
      render(<WalletConnectButton />);

      const trigger = screen.getByRole('button', { name: /wallet/i });
      trigger.focus();
      await user.keyboard('{Enter}');

      const menu = await screen.findByRole('menu');
      expect(menu).toBeInTheDocument();

      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    });

    it('moves focus through menu items with arrow keys', async () => {
      setConnected();
      const user = userEvent.setup();
      render(<WalletConnectButton />);

      const trigger = screen.getByRole('button', { name: /wallet/i });
      trigger.focus();
      await user.keyboard('{Enter}');

      const menu = await screen.findByRole('menu');
      const items = within(menu).getAllByRole('menuitem');
      await waitFor(() => expect(items[0]).toHaveFocus());

      await user.keyboard('{ArrowDown}');
      expect(items[1]).toHaveFocus();

      await user.keyboard('{ArrowUp}');
      expect(items[0]).toHaveFocus();
    });

    it('closes the modal with Escape and restores focus to trigger', async () => {
      const user = userEvent.setup();
      render(<WalletConnectButton />);

      const trigger = screen.getByRole('button', { name: /connect wallet/i });
      await user.click(trigger);

      const dialog = await screen.findByRole('dialog');
      expect(dialog).toBeInTheDocument();

      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(trigger).toHaveFocus();
    });

    it('traps focus inside the modal', async () => {
      const user = userEvent.setup();
      render(<WalletConnectButton />);

      await user.click(screen.getByRole('button', { name: /connect wallet/i }));
      const dialog = await screen.findByRole('dialog');

      const focusable = within(dialog).getAllByRole('button');
      expect(focusable.length).toBeGreaterThan(0);
      await waitFor(() => expect(focusable[0]).toHaveFocus());
    });

    it('announces the connecting state via a live region', async () => {
      const user = userEvent.setup();
      render(<WalletConnectButton />);

      await user.click(screen.getByRole('button', { name: /connect wallet/i }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /freighter/i }));

      const liveRegion = screen.getByRole('status');
      expect(liveRegion).toHaveAttribute('aria-live', 'polite');
      await waitFor(() => expect(liveRegion).toHaveTextContent(/connecting/i));
    });

    it('announces the connected address via a live region', async () => {
      setConnected();
      render(<WalletConnectButton />);

      const liveRegion = screen.getByRole('status');
      expect(liveRegion).toHaveAttribute('aria-live', 'polite');
      await waitFor(() => expect(liveRegion).toHaveTextContent(/connected/i));
      expect(liveRegion).toHaveTextContent(CONNECTED_ADDRESS);
    });

    it('exposes an accessible name including the connected address on the trigger', () => {
      setConnected();
      render(<WalletConnectButton />);

      const button = screen.getByRole('button', { name: new RegExp(CONNECTED_ADDRESS) });
      expect(button).toBeInTheDocument();
    });

    it('has no axe violations in the disconnected state', async () => {
      const { container } = render(<WalletConnectButton />);
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it('has no axe violations in the connected state', async () => {
      setConnected();
      const { container } = render(<WalletConnectButton />);
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it('has no axe violations with the wallet selection modal open', async () => {
      const user = userEvent.setup();
      const { container } = render(<WalletConnectButton />);

      await user.click(screen.getByRole('button', { name: /connect wallet/i }));
      await screen.findByRole('dialog');

      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });
  });

  describe('customization', () => {
    it('applies a custom className', () => {
      const { container } = render(<WalletConnectButton className="my-custom-class" />);
      const root = container.firstChild as HTMLElement;
      expect(root).toHaveClass('my-custom-class');
    });

    it('applies custom inline styles', () => {
      const { container } = render(
        <WalletConnectButton style={{ backgroundColor: 'rgb(1, 2, 3)' }} />
      );
      const root = container.firstChild as HTMLElement;
      expect(root).toHaveStyle({ backgroundColor: 'rgb(1, 2, 3)' });
    });

    it('renders a custom label when provided', () => {
      render(<WalletConnectButton label="Sign In" />);
      expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
    });
  });
});