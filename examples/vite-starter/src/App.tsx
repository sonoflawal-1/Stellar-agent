import { useState } from 'react';
import AgentDirectory from './components/AgentDirectory';
import CreateJob from './components/CreateJob';
import JobTracker from './components/JobTracker';
import WalletConnect from './components/WalletConnect';

type Tab = 'agents' | 'create' | 'tracker';

export default function App() {
  const [tab, setTab] = useState<Tab>('agents');
  const [walletKey, setWalletKey] = useState<string | null>(null);
  const [trackedJobId, setTrackedJobId] = useState<bigint | null>(null);

  return (
    <div className="container">
      <h1>🐻 Bear Protocol</h1>
      <p style={{ color: '#888', marginBottom: '1.5rem' }}>
        Agent commerce on Stellar — connect wallet, browse agents, fund jobs.
      </p>

      <WalletConnect walletKey={walletKey} onConnect={setWalletKey} />

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
        {(['agents', 'create', 'tracker'] as Tab[]).map((t) => (
          <button
            key={t}
            className={`tab${tab === t ? ' active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'agents' ? '🤖 Agents' : t === 'create' ? '💼 Create Job' : '📊 Track Job'}
          </button>
        ))}
      </div>

      {tab === 'agents' && <AgentDirectory walletKey={walletKey} />}
      {tab === 'create' && (
        <CreateJob
          walletKey={walletKey}
          onJobCreated={(id) => {
            setTrackedJobId(id);
            setTab('tracker');
          }}
        />
      )}
      {tab === 'tracker' && <JobTracker jobId={trackedJobId} />}
    </div>
  );
}
