'use client';
import { useState } from 'react';
import { CommerceClient, TESTNET } from 'marc-stellar-sdk';
import { Keypair } from '@stellar/stellar-sdk';

const client = new CommerceClient(TESTNET);

export default function JobForm() {
  const [provider, setProvider] = useState('');
  const [evaluator, setEvaluator] = useState('');
  const [budget, setBudget] = useState('10000000');
  const [desc, setDesc] = useState('');
  const [secret, setSecret] = useState('');
  const [jobId, setJobId] = useState<bigint | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const formEmpty = !provider && !evaluator && !desc;

  async function create() {
    setPending(true); setError('');
    try {
      const kp = Keypair.fromSecret(secret);
      const id = await client.approveAndCreateJob(kp, provider, evaluator, TESTNET.usdcToken, BigInt(budget), desc);
      setJobId(id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: '2rem' }}>
      <h2>Create Job</h2>
      {formEmpty && !pending && <p className="muted">Fill in provider, evaluator, and description to create a job.</p>}
      {pending && <p className="muted">Submitting transaction…</p>}
      <input placeholder="Provider G..." value={provider} onChange={(e) => setProvider(e.target.value)} />
      <input placeholder="Evaluator G..." value={evaluator} onChange={(e) => setEvaluator(e.target.value)} />
      <input type="number" placeholder="Budget (micro-USDC)" value={budget} onChange={(e) => setBudget(e.target.value)} />
      <textarea rows={2} placeholder="Description" value={desc} onChange={(e) => setDesc(e.target.value)} />
      <input type="password" placeholder="Secret key (S...)" value={secret} onChange={(e) => setSecret(e.target.value)} />
      <button onClick={create} disabled={pending}>{pending ? 'Creating…' : 'Create Job'}</button>
      {jobId && <p className="success">Created job #{String(jobId)} — <a href={`/jobs/${jobId}`}>View</a></p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
