import { useEffect, useState } from 'react';
import { IdentityClient, TESTNET } from 'marc-stellar-sdk';
import type { Agent } from 'marc-stellar-sdk';

const client = new IdentityClient(TESTNET);

export default function AgentDirectory({ walletKey }: { walletKey: string | null }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client
      .listAgents(50n)
      .then(setAgents)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p style={{ color: '#888' }}>Loading agents…</p>;
  if (error) return <p className="error">{error}</p>;
  if (agents.length === 0) return <p style={{ color: '#888' }}>No agents registered yet.</p>;

  return (
    <div>
      <h2>🤖 Registered Agents ({agents.length})</h2>
      {agents.map((a) => (
        <div key={String(a.id)} className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>Agent #{String(a.id)}</strong>
            {walletKey && walletKey === a.owner && (
              <span className="badge" style={{ background: '#2a3a1a', color: '#4ade80' }}>You</span>
            )}
          </div>
          <p className="addr">{a.owner}</p>
          <p style={{ fontSize: '0.85rem', color: '#888', marginTop: '0.4rem' }}>
            <a href={a.uri} target="_blank" rel="noreferrer">{a.uri}</a>
          </p>
        </div>
      ))}
    </div>
  );
}
