import { useState } from 'react';
import { CommerceClient, TESTNET } from 'marc-stellar-sdk';
import { Keypair } from '@stellar/stellar-sdk';

const client = new CommerceClient(TESTNET);

interface Props {
  walletKey: string | null;
  onJobCreated: (id: bigint) => void;
}

export default function CreateJob({ walletKey, onJobCreated }: Props) {
  const [provider, setProvider] = useState('');
  const [evaluator, setEvaluator] = useState('');
  const [budget, setBudget] = useState('10000000');
  const [description, setDescription] = useState('');
  const [secret, setSecret] = useState('');
  const [status, setStatus] = useState<'idle' | 'pending' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');

  async function submit() {
    if (!secret) { setError('Enter your secret key to sign the transaction.'); return; }
    try {
      setStatus('pending');
      setError('');
      const kp = Keypair.fromSecret(secret);
      const jobId = await client.approveAndCreateJob(
        kp,
        provider,
        evaluator,
        TESTNET.usdcToken,
        BigInt(budget),
        description,
      );
      setStatus('done');
      onJobCreated(jobId);
    } catch (e: unknown) {
      setStatus('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="card">
      <h2>💼 Create Escrow Job</h2>
      <p style={{ color: '#888', fontSize: '0.85rem', marginBottom: '1rem' }}>
        Fund a job into escrow. The provider delivers, the evaluator approves, funds release.
      </p>
      <label>Provider address</label>
      <input placeholder="G..." value={provider} onChange={(e) => setProvider(e.target.value)} />
      <label>Evaluator address</label>
      <input placeholder="G..." value={evaluator} onChange={(e) => setEvaluator(e.target.value)} />
      <label>Budget (micro-USDC, 1 USDC = 1 000 000)</label>
      <input type="number" value={budget} onChange={(e) => setBudget(e.target.value)} />
      <label>Description</label>
      <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      <label style={{ color: '#f87171' }}>Secret key (testnet only — never use mainnet keys here)</label>
      <input type="password" placeholder="S..." value={secret} onChange={(e) => setSecret(e.target.value)} />
      <button onClick={submit} disabled={status === 'pending'}>
        {status === 'pending' ? 'Creating…' : 'Create Job'}
      </button>
      {status === 'done' && <p className="success">Job created! Navigating to tracker…</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
