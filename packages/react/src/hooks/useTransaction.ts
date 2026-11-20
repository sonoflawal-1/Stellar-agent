import { useCallback, useRef, useState } from "react";

/**
 * Lifecycle status of a transaction.
 *
 * - `idle`: no transaction has been started yet
 * - `signing`: the transaction is being signed / prepared
 * - `submitted`: the transaction has been submitted and a hash is available
 * - `confirmed`: the transaction has been confirmed on-chain
 * - `failed`: the transaction failed at any stage
 */
export type TransactionStatus =
  | "idle"
  | "signing"
  | "submitted"
  | "confirmed"
  | "failed";

/**
 * State exposed by the {@link useTransaction} hook.
 */
export interface TransactionState {
  /** Current lifecycle status. */
  status: TransactionStatus;
  /** Transaction hash, available once the transaction has been submitted. */
  txHash: string | null;
  /** Error captured during the transaction lifecycle, if any. */
  error: Error | null;
}

/**
 * Result of the async transaction function passed to {@link useTransaction}.
 */
export interface TransactionResult {
  /** The transaction hash. */
  txHash: string;
}

/**
 * Async transaction function invoked by {@link useTransaction}.
 *
 * It should perform the signing/submission work and resolve with the
 * transaction hash. It may optionally wait for confirmation before
 * resolving; either way the hook transitions to `confirmed` on success.
 */
export type TransactionFn = () => Promise<TransactionResult | string>;

/**
 * Return value of the {@link useTransaction} hook.
 */
export interface UseTransactionReturn extends TransactionState {
  /** Whether a transaction is currently in flight (`signing` or `submitted`). */
  isLoading: boolean;
  /** Whether the last transaction completed successfully. */
  isSuccess: boolean;
  /** Whether the last transaction failed. */
  isError: boolean;
  /**
   * Run a transaction through the lifecycle:
   * `signing` -> `submitted` -> `confirmed` (or `failed`).
   *
   * Resolves with the transaction hash on success and rejects with the
   * captured error on failure.
   */
  run: (fn: TransactionFn) => Promise<string>;
  /** Reset the state back to `idle`. */
  reset: () => void;
}

const initialState: TransactionState = {
  status: "idle",
  txHash: null,
  error: null,
};

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(typeof value === "string" ? value : "Transaction failed");
}

function extractHash(result: TransactionResult | string): string {
  if (typeof result === "string") {
    return result;
  }
  if (result && typeof result.txHash === "string") {
    return result.txHash;
  }
  throw new Error("Transaction function did not return a transaction hash");
}

/**
 * Hook that manages the lifecycle of a transaction.
 *
 * Tracks status transitions (`idle`, `signing`, `submitted`, `confirmed`,
 * `failed`), exposes the transaction hash on submission/success, and captures
 * any error that occurs.
 *
 * @example
 * ```tsx
 * const { run, status, txHash, error } = useTransaction();
 *
 * const handleSubmit = () => run(async () => {
 *   const hash = await createJob(...);
 *   return hash;
 * });
 * ```
 */
export function useTransaction(): UseTransactionReturn {
  const [state, setState] = useState<TransactionState>(initialState);

  // Track the latest run so stale async results don't overwrite newer state.
  const runIdRef = useRef(0);

  const reset = useCallback(() => {
    runIdRef.current += 1;
    setState(initialState);
  }, []);

  const run = useCallback(async (fn: TransactionFn): Promise<string> => {
    const runId = ++runIdRef.current;

    setState({ status: "signing", txHash: null, error: null });

    try {
      const result = await fn();
      const txHash = extractHash(result);

      if (runId === runIdRef.current) {
        setState({ status: "submitted", txHash, error: null });
      }

      // Transition to confirmed. If the caller's function already waited for
      // confirmation, this simply reflects the final successful state.
      if (runId === runIdRef.current) {
        setState({ status: "confirmed", txHash, error: null });
      }

      return txHash;
    } catch (err) {
      const error = toError(err);

      if (runId === runIdRef.current) {
        setState((prev) => ({
          status: "failed",
          txHash: prev.txHash,
          error,
        }));
      }

      throw error;
    }
  }, []);

  const isLoading = state.status === "signing" || state.status === "submitted";
  const isSuccess = state.status === "confirmed";
  const isError = state.status === "failed";

  return {
    ...state,
    isLoading,
    isSuccess,
    isError,
    run,
    reset,
  };
}

export default useTransaction;