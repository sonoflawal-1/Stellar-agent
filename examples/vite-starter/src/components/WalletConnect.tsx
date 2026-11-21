import { WalletConnectButton } from '@bear-protocol/react';

interface Props {
  walletKey: string | null;
  onConnect: (key: string) => void;
}

export default function WalletConnect({ walletKey, onConnect }: Props) {
  return (
    <div className="card" style={{ marginBottom: '1.5rem' }}>
      <strong>Wallet</strong>
      <div style={{ marginTop: '0.5rem' }}>
        <WalletConnectButton
          className="wallet-connect-button"
          onConnect={onConnect}
        />
      </div>
      {walletKey && (
        <p className="addr" style={{ marginTop: '0.5rem' }}>
          ✅ Connected: {walletKey.slice(0, 8)}…{walletKey.slice(-6)}
        </p>
      )}
    </div>
  );
}