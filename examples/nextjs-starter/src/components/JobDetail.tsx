'use client';
import { useEffect, useState } from 'react';
import { CommerceClient, TESTNET } from 'marc-stellar-sdk';
import type { Job } from 'marc-stellar-sdk';

const client = new CommerceClient(TESTNET);

export default function JobDetail({ jobId }: { jobId: bigint }) {
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    client.getJob(jobId).then(setJob).finally(() => setLoading(false));
  }, [jobId]);

  if (loading) return <p style={{ color: '#888' }}>Loading…</p>;
  if (!job) return <p className="error">Job not found.</p>;

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <strong>Job #{String(job.id)}</strong>
        <span>{String(job.status)}</span>
      </div>
      <p style={{ marginTop: '0.5rem' }}>{job.description}</p>
      <p style={{ fontSize: '0.8rem', color: '#888', marginTop: '0.5rem' }}>
        Budget: {Number(job.budget) / 1_000_000} USDC
      </p>
    </div>
  );
}
