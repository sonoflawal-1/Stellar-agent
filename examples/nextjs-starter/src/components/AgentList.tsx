'use client';
import { useEffect, useState } from 'react';
import { IdentityClient, TESTNET } from 'marc-stellar-sdk';
import type { Agent } from 'marc-stellar-sdk';

const client = new IdentityClient(TESTNET);

export default function AgentList() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    client.listAgents(50n).then(setAgents).finally(() => setLoading(false));
  }, []);

  if (loading) return <p style={{ color: '#888' }}>Loading agents…</p>;

  return (
    <div>
      <h2>Registered Agents ({agents.length})</h2>
      {agents.map((a) => (
        <div key={String(a.id)} className="card">
          <strong>Agent #{String(a.id)}</strong>
          <p className="addr">{a.owner}</p>
          <p style={{ fontSize: '0.85rem' }}><a href={a.uri} target="_blank" rel="noreferrer">{a.uri}</a></p>
        </div>
      ))}
    </div>
  );
}
