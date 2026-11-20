import { useEffect, useState } from 'react';
import { CommerceClient, TESTNET } from 'marc-stellar-sdk';
import type { Job } from 'marc-stellar-sdk';

const client = new CommerceClient(TESTNET);

export default function JobTracker({ jobId }: { jobId: bigint | null }) {
  const [id, setId] = useState(jobId ? String(jobId) : '');
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function lookup() {
    if (!id) return;
    setLoading(true);
    setError(null);
    client
      .getJob(BigInt(id))
      .then(setJob)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => { if (jobId) { setId(String(jobId)); } }, [jobId]);
  useEffect(() => { if (id) lookup(); }, [id]); // eslint-disable-line

  const statusColor: Record<string, string> = {
    Funded: '#4ade80', Submitted: '#facc15', Completed: '#60a5fa',
    Cancelled: '#f87171', Disputed: '#fb923c',
  };

  return (
    <div className="card">
      <h2>📊 Job Tracker</h2>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        <input
          placeholder="Job ID"
          value={id}
          onChange={(e) => setId(e.target.value)}
          style={{ marginBottom: 0 }}
        />
        <button onClick={lookup}>Look up</button>
      </div>
      {loading && <p style={{ color: '#888' }}>Loading…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && !error && id && !job && <p style={{ color: '#888' }}>No job found for this id.</p>}
      {job && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>Job #{String(job.id)}</strong>
            <span style={{ color: statusColor[String(job.status)] ?? '#888', fontWeight: 600 }}>
              {String(job.status)}
            </span>
          </div>
          <p style={{ marginTop: '0.5rem', fontSize: '0.9rem' }}>{job.description}</p>
          <div style={{ marginTop: '0.75rem', fontSize: '0.8rem', color: '#888' }}>
            <div>Budget: {Number(job.budget) / 1_000_000} USDC</div>
            <div className="addr">Client: {job.client}</div>
            <div className="addr">Provider: {job.provider}</div>
            {job.deliverable && <div style={{ marginTop: '0.5rem' }}>Deliverable: <a href={job.deliverable} target="_blank" rel="noreferrer">{job.deliverable}</a></div>}
          </div>
        </>
      )}
    </div>
  );
}
