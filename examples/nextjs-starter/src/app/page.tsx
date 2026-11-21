'use client';

import AgentList from '@/components/AgentList';
import JobForm from '@/components/JobForm';
import { WalletProvider, useWallet } from '@bear-protocol/react';

function WalletConnectButton() {
  const { address, connected, connect, disconnect } = useWallet();

  return (
    <button
      onClick={() => {
        if (connected) {
          disconnect();
        } else {
          connect();
        }
      }}
      style={{
        padding: '0.5rem 1rem',
        borderRadius: '0.5rem',
        border: '1px solid #444',
        background: connected ? '#1f2937' : '#2563eb',
        color: '#fff',
        cursor: 'pointer',
      }}
    >
      {connected && address
        ? `${address.slice(0, 6)}…${address.slice(-4)} — Disconnect`
        : 'Connect Wallet'}
    </button>
  );
}

function HomeContent() {
  return (
    <main className="container">
      <h1>🐻 Bear Protocol</h1>
      <p style={{ color: '#888', marginBottom: '2rem' }}>
        Agent commerce on Stellar — Next.js 14 App Router edition.
      </p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1.5rem' }}>
        <WalletConnectButton />
      </div>
      <AgentList />
      <JobForm />
    </main>
  );
}

export default function Home() {
  return (
    <WalletProvider>
      <HomeContent />
    </WalletProvider>
  );
}