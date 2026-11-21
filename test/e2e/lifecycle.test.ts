import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  BASE_FEE,
  Contract,
  SorobanRpc,
  nativeToScVal,
  scValToNative,
  Address,
} from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const NETWORK = process.env.E2E_NETWORK ?? 'testnet';
const RPC_URL =
  process.env.E2E_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const HORIZON_URL =
  process.env.E2E_HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
const FRIENDBOT_URL =
  process.env.E2E_FRIENDBOT_URL ?? 'https://friendbot.stellar.org';
const NETWORK_PASSPHRASE =
  process.env.E2E_NETWORK_PASSPHRASE ?? Networks.TESTNET;

const IDENTITY_CONTRACT_ID = process.env.E2E_IDENTITY_CONTRACT_ID ?? '';
const ESCROW_CONTRACT_ID = process.env.E2E_ESCROW_CONTRACT_ID ?? '';
const TOKEN_CONTRACT_ID = process.env.E2E_TOKEN_CONTRACT_ID ?? '';
const TREASURY_ADDRESS = process.env.E2E_TREASURY_ADDRESS ?? '';
const INDEXER_URL = process.env.E2E_INDEXER_URL ?? '';

const JOB_AMOUNT = 10_000_000n; // 10 USDC at 7 decimals
const PROVIDER_BPS = 9_900n; // 99%
const TREASURY_BPS = 100n; // 1%
const BPS_DENOMINATOR = 10_000n;

const EXPECTED_PROVIDER_INCREASE = (JOB_AMOUNT * PROVIDER_BPS) / BPS_DENOMINATOR;
const EXPECTED_TREASURY_INCREASE = (JOB_AMOUNT * TREASURY_BPS) / BPS_DENOMINATOR;

const RUN_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 1_000;
const POLL_MAX_ATTEMPTS = 30;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const horizon = new Horizon.Server(HORIZON_URL);
const rpc = new SorobanRpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith('http://') });

interface TxRecord {
  label: string;
  hash: string;
}

const txLog: TxRecord[] = [];

function logTx(label: string, hash: string): void {
  txLog.push({ label, hash });
  // eslint-disable-next-line no-console
  console.log(`[e2e] ${label}: ${hash}`);
}

function diagnostics(err: unknown): string {
  const lines: string[] = [];
  lines.push('=== E2E lifecycle failure diagnostics ===');
  lines.push(`network: ${NETWORK}`);
  lines.push(`rpc: ${RPC_URL}`);
  lines.push(`horizon: ${HORIZON_URL}`);
  lines.push(`identity contract: ${IDENTITY_CONTRACT_ID}`);
  lines.push(`escrow contract: ${ESCROW_CONTRACT_ID}`);
  lines.push(`token contract: ${TOKEN_CONTRACT_ID}`);
  lines.push(`treasury: ${TREASURY_ADDRESS}`);
  lines.push(`indexer: ${INDEXER_URL}`);
  lines.push('--- transaction hashes ---');
  if (txLog.length === 0) {
    lines.push('(no transactions submitted)');
  } else {
    for (const tx of txLog) {
      lines.push(`${tx.label}: ${tx.hash}`);
    }
  }
  lines.push('--- error ---');
  if (err instanceof Error) {
    lines.push(`${err.name}: ${err.message}`);
    if (err.stack) lines.push(err.stack);
  } else {
    lines.push(String(err));
  }
  return lines.join('\n');
}

async function fundWithFriendbot(publicKey: string): Promise<void> {
  const url = `${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Friendbot funding failed for ${publicKey}: ${res.status} ${res.statusText}`,
    );
  }
  await res.json();
}

async function waitForAccount(publicKey: string): Promise<void> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    try {
      await horizon.loadAccount(publicKey);
      return;
    } catch {
      await sleep(POLL_INTERVAL_MS);
    }
  }
  throw new Error(`Account ${publicKey} not found on Horizon after funding`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function submitClassic(
  source: Keypair,
  operations: Operation[],
  label: string,
): Promise<string> {
  const account = await horizon.loadAccount(source.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  for (const op of operations) builder.addOperation(op);
  const tx = builder.setTimeout(30).build();
  tx.sign(source);
  const res = await horizon.submitTransaction(tx);
  logTx(label, res.hash);
  return res.hash;
}

async function invokeContract(
  source: Keypair,
  contractId: string,
  method: string,
  args: unknown[],
  label: string,
): Promise<{ hash: string; returnValue: unknown }> {
  const contract = new Contract(contractId);
  const account = await rpc.getAccount(source.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args.map((a) => nativeToScVal(a))))
    .setTimeout(30)
    .build();

  const prepared = await rpc.prepareTransaction(tx);
  prepared.sign(source);

  const sendResponse = await rpc.sendTransaction(prepared);
  if (sendResponse.status === 'ERROR') {
    throw new Error(
      `sendTransaction failed for ${label}: ${JSON.stringify(sendResponse)}`,
    );
  }

  const hash = sendResponse.hash;
  logTx(label, hash);

  let getResponse = await rpc.getTransaction(hash);
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    if (getResponse.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
      break;
    }
    await sleep(POLL_INTERVAL_MS);
    getResponse = await rpc.getTransaction(hash);
  }

  if (getResponse.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(
      `Transaction ${label} (${hash}) did not succeed: ${JSON.stringify(getResponse)}`,
    );
  }

  const returnValue =
    getResponse.returnValue !== undefined
      ? scValToNative(getResponse.returnValue)
      : undefined;

  return { hash, returnValue };
}

async function readContract(
  source: Keypair,
  contractId: string,
  method: string,
  args: unknown[],
): Promise<unknown> {
  const contract = new Contract(contractId);
  const account = await rpc.getAccount(source.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args.map((a) => nativeToScVal(a))))
    .setTimeout(30)
    .build();

  const simulated = await rpc.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(simulated)) {
    throw new Error(
      `simulateTransaction failed for ${method}: ${simulated.error}`,
    );
  }
  if (!simulated.result) {
    throw new Error(`simulateTransaction returned no result for ${method}`);
  }
  return scValToNative(simulated.result.retval);
}

async function tokenBalance(publicKey: string): Promise<bigint> {
  const raw = await readContract(
    Keypair.random(),
    TOKEN_CONTRACT_ID,
    'balance',
    [publicKey],
  );
  return BigInt(raw as bigint | number | string);
}

async function waitForIndexerRecord(
  predicate: (record: Record<string, unknown>) => boolean,
  description: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${INDEXER_URL}/events`);
      if (res.ok) {
        const body = (await res.json()) as { events?: Record<string, unknown>[] };
        const events = body.events ?? [];
        const match = events.find(predicate);
        if (match) return match;
      }
    } catch {
      // indexer may not be up yet; keep polling
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Indexer record not found: ${description}`);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('E2E: full agent commerce lifecycle', () => {
  let seller: Keypair;
  let buyer: Keypair;
  let evaluator: Keypair;

  let sellerAgentId: string;
  let jobId: string;

  let buyerBalanceBefore: bigint;
  let sellerBalanceBefore: bigint;
  let treasuryBalanceBefore: bigint;

  beforeAll(async () => {
    if (!IDENTITY_CONTRACT_ID || !ESCROW_CONTRACT_ID || !TOKEN_CONTRACT_ID) {
      throw new Error(
        'Missing required env vars: E2E_IDENTITY_CONTRACT_ID, E2E_ESCROW_CONTRACT_ID, E2E_TOKEN_CONTRACT_ID',
      );
    }

    seller = Keypair.random();
    buyer = Keypair.random();
    evaluator = Keypair.random();

    await Promise.all([
      fundWithFriendbot(seller.publicKey()),
      fundWithFriendbot(buyer.publicKey()),
      fundWithFriendbot(evaluator.publicKey()),
    ]);

    await Promise.all([
      waitForAccount(seller.publicKey()),
      waitForAccount(buyer.publicKey()),
      waitForAccount(evaluator.publicKey()),
    ]);
  }, RUN_TIMEOUT_MS);

  afterAll(() => {
    // eslint-disable-next-line no-console
    console.log('[e2e] transaction log:', JSON.stringify(txLog, null, 2));
  });

  it(
    'registers a new seller agent in the identity contract',
    async () => {
      try {
        const { returnValue } = await invokeContract(
          seller,
          IDENTITY_CONTRACT_ID,
          'register_agent',
          [seller.publicKey(), 'seller', 'e2e-seller'],
          'register_agent',
        );
        sellerAgentId = String(returnValue ?? seller.publicKey());
        expect(sellerAgentId).toBeTruthy();

        const registered = await readContract(
          seller,
          IDENTITY_CONTRACT_ID,
          'get_agent',
          [seller.publicKey()],
        );
        expect(registered).toBeTruthy();
      } catch (err) {
        throw new Error(diagnostics(err));
      }
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'buyer funds a 10 USDC escrow job',
    async () => {
      try {
        buyerBalanceBefore = await tokenBalance(buyer.publicKey());
        sellerBalanceBefore = await tokenBalance(seller.publicKey());
        treasuryBalanceBefore = await tokenBalance(TREASURY_ADDRESS);

        expect(buyerBalanceBefore).toBeGreaterThanOrEqual(JOB_AMOUNT);

        const { returnValue } = await invokeContract(
          buyer,
          ESCROW_CONTRACT_ID,
          'create_job',
          [
            buyer.publicKey(),
            seller.publicKey(),
            evaluator.publicKey(),
            JOB_AMOUNT,
            TOKEN_CONTRACT_ID,
          ],
          'create_job',
        );
        jobId = String(returnValue ?? '');
        expect(jobId).toBeTruthy();

        await invokeContract(
          buyer,
          ESCROW_CONTRACT_ID,
          'fund_job',
          [jobId],
          'fund_job',
        );

        const buyerBalanceAfterFunding = await tokenBalance(buyer.publicKey());
        expect(buyerBalanceAfterFunding).toBe(
          buyerBalanceBefore - JOB_AMOUNT,
        );
      } catch (err) {
        throw new Error(diagnostics(err));
      }
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'seller receives the job, executes the task, and submits a deliverable',
    async () => {
      try {
        const job = await readContract(
          seller,
          ESCROW_CONTRACT_ID,
          'get_job',
          [jobId],
        );
        expect(job).toBeTruthy();

        const deliverable = 'e2e-deliverable-hash';
        await invokeContract(
          seller,
          ESCROW_CONTRACT_ID,
          'submit_deliverable',
          [jobId, deliverable],
          'submit_deliverable',
        );

        const updated = (await readContract(
          seller,
          ESCROW_CONTRACT_ID,
          'get_job',
          [jobId],
        )) as Record<string, unknown>;
        expect(updated).toBeTruthy();
      } catch (err) {
        throw new Error(diagnostics(err));
      }
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'evaluator validates the deliverable and triggers completion',
    async () => {
      try {
        await invokeContract(
          evaluator,
          ESCROW_CONTRACT_ID,
          'approve_job',
          [jobId],
          'approve_job',
        );

        const completed = (await readContract(
          evaluator,
          ESCROW_CONTRACT_ID,
          'get_job',
          [jobId],
        )) as Record<string, unknown>;
        expect(completed).toBeTruthy();
      } catch (err) {
        throw new Error(diagnostics(err));
      }
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'splits payment 99% to provider and 1% to treasury',
    async () => {
      try {
        const sellerBalanceAfter = await tokenBalance(seller.publicKey());
        const treasuryBalanceAfter = await tokenBalance(TREASURY_ADDRESS);

        expect(sellerBalanceAfter - sellerBalanceBefore).toBe(
          EXPECTED_PROVIDER_INCREASE,
        );
        expect(treasuryBalanceAfter - treasuryBalanceBefore).toBe(
          EXPECTED_TREASURY_INCREASE,
        );
        expect(EXPECTED_PROVIDER_INCREASE + EXPECTED_TREASURY_INCREASE).toBe(
          JOB_AMOUNT,
        );
      } catch (err) {
        throw new Error(diagnostics(err));
      }
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'emits completion events and records them in the indexer',
    async () => {
      try {
        const record = await waitForIndexerRecord(
          (r) =>
            r.jobId === jobId ||
            r.job_id === jobId ||
            r.event === 'job_completed',
          `job completion for ${jobId}`,
        );
        expect(record).toBeTruthy();
      } catch (err) {
        throw new Error(diagnostics(err));
      }
    },
    RUN_TIMEOUT_MS,
  );
});