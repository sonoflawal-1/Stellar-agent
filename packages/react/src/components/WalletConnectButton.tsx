'use client';

import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

export interface WalletProvider {
  id: string;
  name: string;
  icon?: React.ReactNode;
  description?: string;
}

export interface WalletConnectButtonProps {
  className?: string;
  style?: React.CSSProperties;
  onConnect?: (providerId: string) => void;
  onDisconnect?: () => void;
  address?: string | null;
  balance?: string | null;
  providers?: WalletProvider[];
  explorerUrl?: (address: string) => string;
  isConnecting?: boolean;
  labels?: {
    connect?: string;
    copyAddress?: string;
    viewOnExplorer?: string;
    switchWallet?: string;
    disconnect?: string;
    selectWallet?: string;
    copied?: string;
    close?: string;
    connecting?: string;
    connectedAs?: string;
    disconnected?: string;
    connected?: string;
  };
}

const DEFAULT_PROVIDERS: WalletProvider[] = [
  {
    id: 'freighter',
    name: 'Freighter',
    description: 'Browser extension wallet by Stellar Development Foundation',
    icon: <span aria-hidden="true">🦊</span>,
  },
  {
    id: 'xbull',
    name: 'xBull',
    description: 'Feature-rich Stellar wallet',
    icon: <span aria-hidden="true">🐂</span>,
  },
  {
    id: 'albedo',
    name: 'Albedo',
    description: 'Web-based Stellar wallet',
    icon: <span aria-hidden="true">🌐</span>,
  },
];

const DEFAULT_LABELS = {
  connect: 'Connect Wallet',
  copyAddress: 'Copy Address',
  viewOnExplorer: 'View on Explorer',
  switchWallet: 'Switch Wallet',
  disconnect: 'Disconnect',
  selectWallet: 'Select a Wallet',
  copied: 'Copied!',
  close: 'Close',
  connecting: 'Connecting…',
  connectedAs: 'Connected as',
  disconnected: 'Disconnected',
  connected: 'Wallet connected',
};

const visuallyHiddenStyle: React.CSSProperties = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

function truncateAddress(address: string): string {
  if (!address) return '';
  if (address.length <= 10) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function getAvatarGlyph(address: string): string {
  if (!address) return '?';
  return address.charAt(0).toUpperCase();
}

function defaultExplorerUrl(address: string): string {
  return `https://stellar.expert/explorer/public/account/${address}`;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export function WalletConnectButton({
  className,
  style,
  onConnect,
  onDisconnect,
  address = null,
  balance = null,
  providers = DEFAULT_PROVIDERS,
  explorerUrl = defaultExplorerUrl,
  isConnecting = false,
  labels: labelsProp,
}: WalletConnectButtonProps): React.ReactElement {
  const labels = useMemo(() => ({ ...DEFAULT_LABELS, ...labelsProp }), [labelsProp]);

  const [mounted, setMounted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [activeProviderIndex, setActiveProviderIndex] = useState(0);
  const [announcement, setAnnouncement] = useState('');

  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const providerRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const menuId = useId();
  const modalId = useId();
  const modalTitleId = useId();

  const isConnected = Boolean(address);

  useEffect(() => {
    setMounted(true);
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  // Announce connection status changes via the polite live region.
  const prevConnectedRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!mounted) return;
    const prev = prevConnectedRef.current;
    prevConnectedRef.current = isConnected;
    if (prev === null) return;
    if (isConnected && address) {
      setAnnouncement(`${labels.connectedAs} ${address}`);
    } else if (!isConnected && prev) {
      setAnnouncement(labels.disconnected);
    }
  }, [mounted, isConnected, address, labels.connectedAs, labels.disconnected]);

  useEffect(() => {
    if (isConnecting) {
      setAnnouncement(labels.connecting);
    }
  }, [isConnecting, labels.connecting]);

  const closeMenu = useCallback((restoreFocus = true) => {
    setMenuOpen(false);
    if (restoreFocus && triggerRef.current) {
      triggerRef.current.focus();
    }
  }, []);

  const closeModal = useCallback((restoreFocus = true) => {
    setModalOpen(false);
    if (restoreFocus && triggerRef.current) {
      triggerRef.current.focus();
    }
  }, []);

  const openModal = useCallback(() => {
    setMenuOpen(false);
    setActiveProviderIndex(0);
    setModalOpen(true);
  }, []);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (rootRef.current && target && !rootRef.current.contains(target)) {
        closeMenu(false);
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('mousedown', handlePointerDown);
      document.addEventListener('touchstart', handlePointerDown);
    }
    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('mousedown', handlePointerDown);
        document.removeEventListener('touchstart', handlePointerDown);
      }
    };
  }, [menuOpen, closeMenu]);

  // Focus first menu item when menu opens
  useEffect(() => {
    if (menuOpen && menuRef.current) {
      const first = menuRef.current.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      if (first) first.focus();
    }
  }, [menuOpen]);

  // Focus active provider when modal opens
  useEffect(() => {
    if (modalOpen) {
      const el = providerRefs.current[activeProviderIndex];
      if (el) {
        el.focus();
      } else if (modalRef.current) {
        const first = modalRef.current.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
        if (first) first.focus();
      }
    }
  }, [modalOpen, activeProviderIndex]);

  // Lock body scroll while modal open
  useEffect(() => {
    if (!modalOpen) return;
    if (typeof document === 'undefined') return;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, [modalOpen]);

  const handleMenuKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      if (!menuRef.current) return;
      const items = Array.from(
        menuRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (items.length === 0) return;
      event.preventDefault();
      const currentIndex = items.indexOf(document.activeElement as HTMLElement);
      let nextIndex: number;
      if (event.key === 'ArrowDown') {
        nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
      } else {
        nextIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
      }
      items[nextIndex].focus();
    },
    [closeMenu],
  );

  const handleModalKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeModal();
        return;
      }
      if (event.key === 'Tab') {
        if (!modalRef.current) return;
        const items = Array.from(
          modalRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        ).filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (items.length === 0) {
          event.preventDefault();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey) {
          if (document.activeElement === first) {
            event.preventDefault();
            last.focus();
          }
        } else if (document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const count = providers.length;
        if (count === 0) return;
        event.preventDefault();
        setActiveProviderIndex((prev) => {
          const next = event.key === 'ArrowDown' ? (prev + 1) % count : (prev - 1 + count) % count;
          const el = providerRefs.current[next];
          if (el) el.focus();
          return next;
        });
      }
    },
    [closeModal, providers.length],
  );

  const handleTriggerClick = useCallback(() => {
    if (!isConnected) {
      openModal();
      return;
    }
    setMenuOpen((prev) => !prev);
  }, [isConnected, openModal]);

  const handleSelectProvider = useCallback(
    (providerId: string) => {
      setModalOpen(false);
      setAnnouncement(labels.connecting);
      if (onConnect) {
        onConnect(providerId);
      }
      if (triggerRef.current) {
        triggerRef.current.focus();
      }
    },
    [onConnect, labels.connecting],
  );

  const handleCopyAddress = useCallback(async () => {
    if (!address) return;
    try {
      if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === 'function'
      ) {
        await navigator.clipboard.writeText(address);
      }
    } catch {
      // Ignore clipboard errors silently
    }
    setCopied(true);
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
    }
    copyTimeoutRef.current = setTimeout(() => {
      setCopied(false);
    }, 1500);
  }, [address]);

  const handleViewOnExplorer = useCallback(() => {
    if (!address) return;
    if (typeof window !== 'undefined') {
      window.open(explorerUrl(address), '_blank', 'noopener,noreferrer');
    }
    closeMenu();
  }, [address, explorerUrl, closeMenu]);

  const handleSwitchWallet = useCallback(() => {
    openModal();
  }, [openModal]);

  const handleDisconnect = useCallback(() => {
    setMenuOpen(false);
    setAnnouncement(labels.disconnected);
    if (onDisconnect) {
      onDisconnect();
    }
    if (triggerRef.current) {
      triggerRef.current.focus();
    }
  }, [onDisconnect, labels.disconnected]);

  const baseButtonStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.5rem 1rem',
    borderRadius: '0.5rem',
    border: '1px solid rgba(0,0,0,0.15)',
    background: '#ffffff',
    color: '#111827',
    font: 'inherit',
    cursor: 'pointer',
    lineHeight: 1.2,
  };

  const menuStyle: React.CSSProperties = {
    position: 'absolute',
    top: 'calc(100% + 0.5rem)',
    right: 0,
    minWidth: '12rem',
    background: '#ffffff',
    border: '1px solid rgba(0,0,0,0.12)',
    borderRadius: '0.5rem',
    boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
    padding: '0.25rem',
    zIndex: 50,
    display: 'flex',
    flexDirection: 'column',
  };

  const menuItemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    width: '100%',
    padding: '0.5rem 0.75rem',
    background: 'transparent',
    border: 'none',
    borderRadius: '0.375rem',
    textAlign: 'left',
    font: 'inherit',
    color: '#111827',
    cursor: 'pointer',
  };

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '1rem',
    zIndex: 100,
  };

  const modalStyle: React.CSSProperties = {
    background: '#ffffff',
    color: '#111827',
    borderRadius: '0.75rem',
    width: '100%',
    maxWidth: '24rem',
    maxHeight: 'calc(100vh - 2rem)',
    overflowY: 'auto',
    padding: '1.25rem',
    boxShadow: '0 20px 48px rgba(0,0,0,0.25)',
  };

  const providerButtonStyle = (active: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    width: '100%',
    padding: '0.75rem',
    marginBottom: '0.5rem',
    background: active ? 'rgba(59,130,246,0.08)' : 'transparent',
    border: active ? '1px solid rgba(59,130,246,0.5)' : '1px solid rgba(0,0,0,0.1)',
    borderRadius: '0.5rem',
    textAlign: 'left',
    font: 'inherit',
    color: '#111827',
    cursor: 'pointer',
  });

  // SSR-safe: render a stable initial state until mounted to avoid hydration mismatch.
  const showConnected = mounted && isConnected;

  const triggerAriaLabel = showConnected
    ? `${labels.connected}, ${truncateAddress(address as string)}`
    : isConnecting
      ? labels.connecting
      : labels.connect;

  return (
    <div
      ref={rootRef}
      className={className}
      style={{ position: 'relative', display: 'inline-block', ...style }}
    >
      <span role="status" aria-live="polite" style={visuallyHiddenStyle}>
        {announcement}
      </span>
      <button
        ref={triggerRef}
        type="button"
        aria-label={triggerAriaLabel}
        aria-busy={isConnecting || undefined}
        aria-haspopup={showConnected ? 'menu' : 'dialog'}
        aria-expanded={showConnected ? menuOpen : modalOpen}
        aria-controls={showConnected ? menuId : modalOpen ? modalId : undefined}
        onClick={handleTriggerClick}
        style={baseButtonStyle}
      >
        {showConnected ? (
          <>
            <span
              aria-hidden="true"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '1.5rem',
                height: '1.5rem',
                borderRadius: '50%',
                background: '#3b82f6',
                color: '#ffffff',
                fontSize: '0.75rem',
                fontWeight: 600,
              }}
            >
              {getAvatarGlyph(address as string)}
            </span>
            <span>{truncateAddress(address as string)}</span>
            {balance ? (
              <span style={{ opacity: 0.75, fontSize: '0.875em' }}>{balance}</span>
            ) : null}
          </>
        ) : (
          <>
            <span aria-hidden="true">✦</span>
            <span>{isConnecting ? labels.connecting : labels.connect}</span>
          </>
        )}
      </button>

      {showConnected && menuOpen ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={labels.selectWallet}
          onKeyDown={handleMenuKeyDown}
          style={menuStyle}
        >
          <button
            type="button"
            role="menuitem"
            aria-label={labels.copyAddress}
            onClick={handleCopyAddress}
            style={menuItemStyle}
          >
            <span aria-hidden="true">📋</span>
            <span aria-live="polite">{copied ? labels.copied : labels.copyAddress}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            aria-label={labels.viewOnExplorer}
            onClick={handleViewOnExplorer}
            style={menuItemStyle}
          >
            <span aria-hidden="true">🔗</span>
            <span>{labels.viewOnExplorer}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            aria-label={labels.switchWallet}
            onClick={handleSwitchWallet}
            style={menuItemStyle}
          >
            <span aria-hidden="true">🔄</span>
            <span>{labels.switchWallet}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            aria-label={labels.disconnect}
            onClick={handleDisconnect}
            style={menuItemStyle}
          >
            <span aria-hidden="true">⏻</span>
            <span>{labels.disconnect}</span>
          </button>
        </div>
      ) : null}

      {modalOpen ? (
        <div
          style={overlayStyle}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeModal();
            }
          }}
        >
          <div
            ref={modalRef}
            id={modalId}
            role="dialog"
            aria-modal="true"
            aria-labelledby={modalTitleId}
            onKeyDown={handleModalKeyDown}
            style={modalStyle}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '1rem',
              }}
            >
              <h2
                id={modalTitleId}
                style={{ margin: 0, fontSize: '1.125rem', fontWeight: 600 }}
              >
                {labels.selectWallet}
              </h2>
              <button
                type="button"
                aria-label={labels.close}
                onClick={() => closeModal()}
                style={{
                  background: 'transparent',
                  border: 'none',
                  fontSize: '1.25rem',
                  cursor: 'pointer',
                  color: '#111827',
                  lineHeight: 1,
                  padding: '0.25rem',
                }}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
            <div role="listbox" aria-label={labels.selectWallet}>
              {providers.map((provider, index) => (
                <button
                  key={provider.id}
                  ref={(el) => {
                    providerRefs.current[index] = el;
                  }}
                  type="button"
                  role="option"
                  aria-selected={index === activeProviderIndex}
                  aria-label={provider.name}
                  tabIndex={index === activeProviderIndex ? 0 : -1}
                  onClick={() => handleSelectProvider(provider.id)}
                  onFocus={() => setActiveProviderIndex(index)}
                  style={providerButtonStyle(index === activeProviderIndex)}
                >
                  <span aria-hidden="true" style={{ fontSize: '1.25rem' }}>
                    {provider.icon}
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontWeight: 600 }}>{provider.name}</span>
                    {provider.description ? (
                      <span style={{ fontSize: '0.75rem', opacity: 0.7 }}>
                        {provider.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default WalletConnectButton;