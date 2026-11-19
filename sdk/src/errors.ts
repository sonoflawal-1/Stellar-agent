/**
 * Custom error classes and Soroban error-code mapping helpers for the MARC SDK.
 *
 * Implements typed error handling for failed contract invocations, simulation
 * failures, and RPC timeouts (#547).
 */

/** Known contract error codes across MARC Soroban contracts. */
export const KnownContractErrorCode = {
  // agentic-commerce error codes
  SelfEscrow: 1,
  InvalidParties: 2,
  ContractPaused: 3,
  // agent-identity error codes
  AgentNotFound: 1,
  AlreadyRegistered: 2,
} as const;

/** Human-readable explanation mapping for agentic-commerce error codes. */
export const COMMERCE_ERROR_MESSAGES: Record<number, string> = {
  1: "SelfEscrow: client cannot escrow funds to themselves",
  2: "InvalidParties: provider and evaluator cannot be the same address",
  3: "ContractPaused: contract is paused; state-changing operations are disabled",
};

/** Human-readable explanation mapping for agent-identity error codes. */
export const IDENTITY_ERROR_MESSAGES: Record<number, string> = {
  1: "AgentNotFound: no agent found with the specified ID",
  2: "AlreadyRegistered: address is already registered to an agent",
};

/** Default mapping of known contract error codes to descriptive error messages. */
export const KNOWN_CONTRACT_ERRORS: Record<number, string> = {
  1: "SelfEscrow: client cannot escrow funds to themselves",
  2: "InvalidParties: provider and evaluator cannot be the same address",
  3: "ContractPaused: contract is paused; state-changing operations are disabled",
};

/**
 * Thrown when a contract invocation or simulation fails with an on-chain Soroban contract error.
 *
 * Provides typed access to the contract error code, contract address, and human-readable explanation.
 */
export class ContractError extends Error {
  /** The on-chain numeric error code (e.g. 1 for SelfEscrow, 2 for InvalidParties). */
  readonly code: number;
  /** The Stellar contract address that emitted or triggered the error. */
  readonly contract: string;
  /** Human-readable explanation of why the contract call was rejected. */
  readonly explanation: string;

  constructor(code: number, contract: string, explanation?: string) {
    const resolvedExplanation =
      explanation || KNOWN_CONTRACT_ERRORS[code] || `Contract error code #${code}`;
    super(`Contract error #${code} on ${contract}: ${resolvedExplanation}`);
    this.name = "ContractError";
    this.code = code;
    this.contract = contract;
    this.explanation = resolvedExplanation;
    Object.setPrototypeOf(this, ContractError.prototype);
  }
}

/**
 * Thrown when a Soroban transaction simulation fails.
 *
 * Includes the raw simulation response from the Soroban RPC server and the transaction XDR.
 */
export class SimulationError extends Error {
  /** Raw simulation response from Soroban RPC. */
  readonly rawResponse: unknown;
  /** Transaction XDR string that was simulated. */
  readonly xdr?: string;

  constructor(message: string, rawResponse: unknown, xdr?: string) {
    super(`Simulation error: ${message}`);
    this.name = "SimulationError";
    this.rawResponse = rawResponse;
    this.xdr = xdr;
    Object.setPrototypeOf(this, SimulationError.prototype);
  }
}

/**
 * Thrown when transaction submission or polling exceeds the timeout threshold.
 *
 * Includes the transaction hash and the duration waited in milliseconds.
 */
export class TransactionTimeoutError extends Error {
  /** The transaction hash that timed out. */
  readonly txHash: string;
  /** Elapsed time before timeout in milliseconds. */
  readonly durationMs: number;

  constructor(txHash: string, durationMs: number, message?: string) {
    const msg = message || `Transaction ${txHash} timed out after ${durationMs}ms`;
    super(msg);
    this.name = "TransactionTimeoutError";
    this.txHash = txHash;
    this.durationMs = durationMs;
    Object.setPrototypeOf(this, TransactionTimeoutError.prototype);
  }
}

/**
 * Thrown when `marcFetch` exhausts all retries after an HTTP 402 payment
 * challenge without the payment settling in time (#651).
 *
 * Includes the request URL, the number of attempts made, and the total
 * elapsed time spent waiting for settlement.
 */
export class MarcPaymentTimeoutError extends Error {
  /** The request URL that kept returning HTTP 402. */
  readonly url: string;
  /** Total number of attempts made (initial request plus retries). */
  readonly attempts: number;
  /** Total elapsed time spent retrying in milliseconds. */
  readonly durationMs: number;

  constructor(url: string, attempts: number, durationMs: number, message?: string) {
    const msg =
      message ||
      `Payment for ${url} did not settle after ${attempts} attempt(s) (${durationMs}ms)`;
    super(msg);
    this.name = "MarcPaymentTimeoutError";
    this.url = url;
    this.attempts = attempts;
    this.durationMs = durationMs;
    Object.setPrototypeOf(this, MarcPaymentTimeoutError.prototype);
  }
}

/**
 * Thrown when a `marcFetch` request would exceed a configured spending budget
 * guard (`maxPerRequest` or rolling `maxPerWindow`) (#955).
 *
 * The request is aborted before any funds are sent.
 */
export class BudgetExceededError extends Error {
  /** Which budget limit was exceeded. */
  readonly limitType: "perRequest" | "perWindow";
  /** The configured limit that was exceeded (in stroops). */
  readonly limit: number;
  /** The amount that would have been spent (in stroops). */
  readonly attempted: number;
  /** Rolling window size in milliseconds (only set for `perWindow`). */
  readonly windowMs?: number;
  /** The request URL that triggered the budget check. */
  readonly url: string;

  constructor(
    limitType: "perRequest" | "perWindow",
    limit: number,
    attempted: number,
    url: string,
    windowMs?: number,
    message?: string,
  ) {
    const msg =
      message ||
      (limitType === "perRequest"
        ? `Payment of ${attempted} for ${url} exceeds maxPerRequest limit of ${limit}`
        : `Payment of ${attempted} for ${url} would exceed maxPerWindow limit of ${limit} over ${windowMs}ms`);
    super(msg);
    this.name = "BudgetExceededError";
    this.limitType = limitType;
    this.limit = limit;
    this.attempted = attempted;
    this.windowMs = windowMs;
    this.url = url;
    Object.setPrototypeOf(this, BudgetExceededError.prototype);
  }
}

/**
 * Thrown when the payment server rejects a submitted payment proof (#953).
 *
 * No retry is attempted; the server explicitly refused the proof.
 */
export class PaymentRejectedError extends Error {
  /** The request URL whose payment proof was rejected. */
  readonly url: string;
  /** Human-readable reason supplied by the server (or a default). */
  readonly reason: string;
  /** HTTP status code returned by the server, if available. */
  readonly status?: number;

  constructor(url: string, reason: string, status?: number, message?: string) {
    const msg = message || `Payment proof for ${url} was rejected: ${reason}`;
    super(msg);
    this.name = "PaymentRejectedError";
    this.url = url;
    this.reason = reason;
    this.status = status;
    Object.setPrototypeOf(this, PaymentRejectedError.prototype);
  }
}

/**
 * Thrown when the payer account does not hold enough funds to satisfy a
 * payment challenge (#953).
 *
 * No funds are sent when this error is raised.
 */
export class InsufficientFundsError extends Error {
  /** The request URL that required payment. */
  readonly url: string;
  /** The amount required by the challenge (in stroops). */
  readonly required: number;
  /** The amount available on the payer account (in stroops). */
  readonly available: number;

  constructor(url: string, required: number, available: number, message?: string) {
    const msg =
      message ||
      `Insufficient funds for ${url}: required ${required}, available ${available}`;
    super(msg);
    this.name = "InsufficientFundsError";
    this.url = url;
    this.required = required;
    this.available = available;
    Object.setPrototypeOf(this, InsufficientFundsError.prototype);
  }
}

/**
 * Thrown when a submitted payment transaction does not reach a terminal state
 * within the configured timeout (#953).
 *
 * Distinct from {@link MarcPaymentTimeoutError}, which covers exhausting all
 * 402 retry attempts; this covers a single pending transaction timing out.
 */
export class PaymentPendingTimeoutError extends Error {
  /** The request URL that required payment. */
  readonly url: string;
  /** The transaction hash that remained pending. */
  readonly txHash: string;
  /** Elapsed time before timeout in milliseconds. */
  readonly durationMs: number;

  constructor(url: string, txHash: string, durationMs: number, message?: string) {
    const msg =
      message ||
      `Payment transaction ${txHash} for ${url} still pending after ${durationMs}ms`;
    super(msg);
    this.name = "PaymentPendingTimeoutError";
    this.url = url;
    this.txHash = txHash;
    this.durationMs = durationMs;
    Object.setPrototypeOf(this, PaymentPendingTimeoutError.prototype);
  }
}

/**
 * Thrown when a 402 payment challenge fails client-side allowlist validation
 * (#956): the requested `payTo`, `asset`, or `amount` is not permitted by the
 * configured `allowedPayees` / `allowedAssets` / `maxAmount` policy.
 *
 * The challenge is rejected before any payment is constructed or submitted, so
 * no network payment is made.
 */
export class ChallengeRejectedError extends Error {
  /** The request URL whose 402 challenge was rejected. */
  readonly url: string;
  /** Which challenge field failed validation. */
  readonly field: "payTo" | "asset" | "amount";
  /** The value supplied by the (untrusted) server challenge. */
  readonly value: string;
  /** Human-readable reason for the rejection. */
  readonly reason: string;

  constructor(
    url: string,
    field: "payTo" | "asset" | "amount",
    value: string,
    reason: string,
    message?: string,
  ) {
    const msg =
      message ||
      `402 challenge for ${url} rejected: ${field} "${value}" is not allowed (${reason})`;
    super(msg);
    this.name = "ChallengeRejectedError";
    this.url = url;
    this.field = field;
    this.value = value;
    this.reason = reason;
    Object.setPrototypeOf(this, ChallengeRejectedError.prototype);
  }
}

/**
 * Extract an on-chain Soroban contract error code from a message or error string if present.
 *
 * Handles standard Soroban host error strings such as:
 * - `"Error(Contract, #1)"`
 * - `"Error(Contract, 1)"`
 * - `"submit failed: Error(Contract, #2)"`
 *
 * @param message - The raw error message or details string to parse.
 * @returns The integer error code if found, or `null`.
 */
export function extractContractErrorCode(message: string): number | null {
  if (typeof message !== "string") return null;
  const match = message.match(/Error\(Contract,\s*#?([0-9]+)\)/i);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Resolve a human-readable explanation for a contract error code and optional contract address.
 */
export function resolveContractErrorExplanation(
  code: number,
  contractAddress?: string,
  identityContract?: string,
): string {
  if (identityContract && contractAddress === identityContract) {
    return IDENTITY_ERROR_MESSAGES[code] || `Identity contract error #${code}`;
  }
  return (
    COMMERCE_ERROR_MESSAGES[code] ||
    KNOWN_CONTRACT_ERRORS[code] ||
    `Contract error code #${code}`
  );
}
