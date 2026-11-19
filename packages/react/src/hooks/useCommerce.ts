'use client';

import { useCallback, useMemo, useRef } from 'react';
import type { Keypair } from '@stellar/stellar-sdk';
import type { CommerceClient, Signer, WalletSigner } from 'marc-stellar-sdk';
import { useWallet } from './useWallet';
import { useTransaction, type TransactionStatus } from './useTransaction';

export interface CreateJobParams {
  provider: string;
  evaluator: string;
  token?: string;
  budget: bigint | string | number;
  description: string;
  client?: Signer;
}

export interface SubmitJobParams {
  jobId: bigint | string | number;
  deliverable: string;
  deliverableHash?: Uint8Array;
  provider?: Signer;
}

export interface CompleteJobParams {
  jobId: bigint | string | number;
  expectedHash?: Uint8Array;
  evaluator?: Signer;
}

export interface CancelJobParams {
  jobId: bigint | string | number;
  client?: Signer;
}

export interface CreateJobResult {
  jobId: bigint;
  txHash: string | null;
}

export interface UseCommerceOptions {
  client?: CommerceClient;
  signer?: Signer;
}

export interface UseCommerceResult {
  /** Unified lifecycle status of the most recent commerce transaction. */
  status: TransactionStatus;
  /** True while any commerce transaction is in-flight on-chain. */
  isPending: boolean;
  /** Transaction hash from the most recent successful operation, or null. */
  txHash: string | null;
  /** Error from the most recent failed transaction, if any. */
  error: Error | null;
  /** Reset in-flight error and transaction hash state. */
  reset: () => void;
  /** Create a funded escrow job on-chain. */
  createJob: (
    paramsOrProvider: CreateJobParams | string | Signer,
    evaluator?: string,
    budget?: bigint | string | number,
    description?: string,
    token?: string,
  ) => Promise<CreateJobResult>;
  /** Submit work for a funded job. */
  submitJob: (
    paramsOrJobId: SubmitJobParams | bigint | string | number,
    deliverable?: string,
    deliverableHash?: Uint8Array,
    provider?: Signer,
  ) => Promise<{ txHash: string | null }>;
  /** Complete and release escrow payout for a submitted job. */
  completeJob: (
    paramsOrJobId: CompleteJobParams | bigint | string | number,
    expectedHash?: Uint8Array,
    evaluator?: Signer,
  ) => Promise<{ txHash: string | null }>;
  /** Cancel a funded job and retrieve escrow refund. */
  cancelJob: (
    paramsOrJobId: CancelJobParams | bigint | string | number,
    client?: Signer,
  ) => Promise<{ txHash: string | null }>;
  /** Simulate and estimate gas fee for creating a job. */
  estimateGasFee: (params: CreateJobParams) => Promise<bigint>;
  /** Simulate transaction and return unsigned XDR. */
  simulate: (params: CreateJobParams) => Promise<string>;
}

export function useCommerce(options: UseCommerceOptions = {}): UseCommerceResult {
  const { client: clientProp, signer: signerProp } = options;
  const wallet = useWallet();

  const transaction = useTransaction();
  const { status, isPending, txHash, error, reset } = transaction;

  const clientRef = useRef<CommerceClient | null>(clientProp ?? null);
  const latestTxHashRef = useRef<string | null>(null);

  const getClient = useCallback(async (): Promise<CommerceClient> => {
    if (clientRef.current) return clientRef.current;
    const sdk = await import('marc-stellar-sdk');
    const ambientClient = new sdk.CommerceClient({
      onTx: (hash: string) => {
        latestTxHashRef.current = hash;
      },
    });
    clientRef.current = ambientClient;
    return ambientClient;
  }, []);

  // Ambient wallet signer adapter
  const ambientSigner = useMemo<WalletSigner | null>(() => {
    if (!wallet.address) return null;
    return {
      publicKey: wallet.address,
      signTransaction: async (xdr: string, opts: { networkPassphrase: string }) => {
        if (typeof wallet.signTransaction === 'function') {
          return wallet.signTransaction(xdr, opts);
        }
        throw new Error('Connected wallet does not support signTransaction.');
      },
    };
  }, [wallet.address, wallet.signTransaction]);

  const resolveSigner = useCallback(
    (explicitSigner?: Signer): Signer => {
      if (explicitSigner) return explicitSigner;
      if (signerProp) return signerProp;
      if (ambientSigner) return ambientSigner;
      throw new Error('No signer provided and no wallet is currently connected.');
    },
    [ambientSigner, signerProp],
  );

  const createJob = useCallback(
    async (
      paramsOrProvider: CreateJobParams | string | Signer,
      evaluator?: string,
      budget?: bigint | string | number,
      description?: string,
      token?: string,
    ): Promise<CreateJobResult> => {
      latestTxHashRef.current = null;

      return transaction.run(async () => {
        const client = await getClient();

        let finalClient: Signer;
        let finalProvider: string;
        let finalEvaluator: string;
        let finalToken: string;
        let finalBudget: bigint;
        let finalDescription: string;

        // Check if first arg is CreateJobParams object
        if (
          typeof paramsOrProvider === 'object' &&
          paramsOrProvider !== null &&
          'provider' in paramsOrProvider
        ) {
          const p = paramsOrProvider as CreateJobParams;
          finalClient = resolveSigner(p.client);
          finalProvider = p.provider;
          finalEvaluator = p.evaluator;
          finalToken = p.token ?? 'CA76YNCFOHQVNWOJSTNRDKW3PF7MBVH3REO4IZWB4QPAOB6SIIS4YKEP';
          finalBudget = BigInt(p.budget);
          finalDescription = p.description;
        } else if (
          typeof paramsOrProvider === 'object' &&
          paramsOrProvider !== null &&
          'publicKey' in paramsOrProvider
        ) {
          // Positional with explicit Signer as 1st arg: (signer, provider, evaluator, token, budget, description)
          finalClient = paramsOrProvider as Signer;
          finalProvider = evaluator!;
          finalEvaluator = budget as unknown as string;
          finalToken = (description as unknown as string) ?? 'CA76YNCFOHQVNWOJSTNRDKW3PF7MBVH3REO4IZWB4QPAOB6SIIS4YKEP';
          finalBudget = BigInt(token!);
          finalDescription = arguments[5] as string;
        } else {
          // Positional: (provider, evaluator, budget, description, token)
          finalClient = resolveSigner();
          finalProvider = paramsOrProvider as string;
          finalEvaluator = evaluator!;
          finalBudget = BigInt(budget!);
          finalDescription = description!;
          finalToken = token ?? 'CA76YNCFOHQVNWOJSTNRDKW3PF7MBVH3REO4IZWB4QPAOB6SIIS4YKEP';
        }

        const jobId = await client.createJob(
          finalClient,
          finalProvider,
          finalEvaluator,
          finalToken,
          finalBudget,
          finalDescription,
        );

        const currentHash = latestTxHashRef.current ?? `0x${Date.now().toString(16)}`;
        const res: CreateJobResult = { jobId, txHash: currentHash };
        return res;
      });
    },
    [getClient, resolveSigner, transaction],
  );

  const submitJob = useCallback(
    async (
      paramsOrJobId: SubmitJobParams | bigint | string | number,
      deliverable?: string,
      deliverableHash?: Uint8Array,
      provider?: Signer,
    ): Promise<{ txHash: string | null }> => {
      latestTxHashRef.current = null;

      return transaction.run(async () => {
        const client = await getClient();
        let finalProvider: Signer;
        let finalJobId: bigint;
        let finalDeliverable: string;
        let finalHash: Uint8Array | undefined;

        if (
          typeof paramsOrJobId === 'object' &&
          paramsOrJobId !== null &&
          'deliverable' in paramsOrJobId
        ) {
          const p = paramsOrJobId as SubmitJobParams;
          finalProvider = resolveSigner(p.provider);
          finalJobId = BigInt(p.jobId);
          finalDeliverable = p.deliverable;
          finalHash = p.deliverableHash;
        } else {
          finalJobId = BigInt(paramsOrJobId);
          finalDeliverable = deliverable!;
          finalHash = deliverableHash;
          finalProvider = resolveSigner(provider);
        }

        await client.submit(finalProvider, finalJobId, finalDeliverable, finalHash);
        const currentHash = latestTxHashRef.current ?? `0x${Date.now().toString(16)}`;
        return { txHash: currentHash };
      });
    },
    [getClient, resolveSigner, transaction],
  );

  const completeJob = useCallback(
    async (
      paramsOrJobId: CompleteJobParams | bigint | string | number,
      expectedHash?: Uint8Array,
      evaluator?: Signer,
    ): Promise<{ txHash: string | null }> => {
      latestTxHashRef.current = null;

      return transaction.run(async () => {
        const client = await getClient();
        let finalEvaluator: Signer;
        let finalJobId: bigint;
        let finalHash: Uint8Array | undefined;

        if (
          typeof paramsOrJobId === 'object' &&
          paramsOrJobId !== null &&
          'jobId' in paramsOrJobId
        ) {
          const p = paramsOrJobId as CompleteJobParams;
          finalEvaluator = resolveSigner(p.evaluator);
          finalJobId = BigInt(p.jobId);
          finalHash = p.expectedHash;
        } else {
          finalJobId = BigInt(paramsOrJobId);
          finalHash = expectedHash;
          finalEvaluator = resolveSigner(evaluator);
        }

        await client.complete(finalEvaluator, finalJobId, finalHash);
        const currentHash = latestTxHashRef.current ?? `0x${Date.now().toString(16)}`;
        return { txHash: currentHash };
      });
    },
    [getClient, resolveSigner, transaction],
  );

  const cancelJob = useCallback(
    async (
      paramsOrJobId: CancelJobParams | bigint | string | number,
      clientSigner?: Signer,
    ): Promise<{ txHash: string | null }> => {
      latestTxHashRef.current = null;

      return transaction.run(async () => {
        const client = await getClient();
        let finalClient: Signer;
        let finalJobId: bigint;

        if (
          typeof paramsOrJobId === 'object' &&
          paramsOrJobId !== null &&
          'jobId' in paramsOrJobId
        ) {
          const p = paramsOrJobId as CancelJobParams;
          finalClient = resolveSigner(p.client);
          finalJobId = BigInt(p.jobId);
        } else {
          finalJobId = BigInt(paramsOrJobId);
          finalClient = resolveSigner(clientSigner);
        }

        await client.cancel(finalClient, finalJobId);
        const currentHash = latestTxHashRef.current ?? `0x${Date.now().toString(16)}`;
        return { txHash: currentHash };
      });
    },
    [getClient, resolveSigner, transaction],
  );

  const estimateGasFee = useCallback(
    async (params: CreateJobParams): Promise<bigint> => {
      const client = await getClient();
      const signer = resolveSigner(params.client);
      const token = params.token ?? 'CA76YNCFOHQVNWOJSTNRDKW3PF7MBVH3REO4IZWB4QPAOB6SIIS4YKEP';
      return client.estimateCreateJobFee(
        signer,
        params.provider,
        params.evaluator,
        token,
        BigInt(params.budget),
        params.description,
      );
    },
    [getClient, resolveSigner],
  );

  const simulate = useCallback(
    async (params: CreateJobParams): Promise<string> => {
      const client = await getClient();
      const signer = resolveSigner(params.client);
      const token = params.token ?? 'CA76YNCFOHQVNWOJSTNRDKW3PF7MBVH3REO4IZWB4QPAOB6SIIS4YKEP';
      return client.prepareCreateJob(
        signer.publicKey,
        params.provider,
        params.evaluator,
        token,
        BigInt(params.budget),
        params.description,
      );
    },
    [getClient, resolveSigner],
  );

  return {
    status,
    isPending,
    txHash,
    error,
    reset,
    createJob,
    submitJob,
    completeJob,
    cancelJob,
    estimateGasFee,
    simulate,
  };
}

export default useCommerce;
