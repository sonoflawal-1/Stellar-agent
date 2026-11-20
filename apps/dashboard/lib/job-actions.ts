export type JobState =
  | "open"
  | "assigned"
  | "submitted"
  | "completed"
  | "disputed"
  | "refunded"
  | "cancelled";

export interface JobActionContext {
  state: JobState;
  /** Unix ms timestamp when the job was assigned to a provider. */
  assignedAt?: number | null;
  /** Unix ms timestamp when the provider submitted work. */
  submittedAt?: number | null;
  /** Unix ms timestamp when the job was completed/approved. */
  completedAt?: number | null;
  /** Unix ms timestamp of the last state change. */
  updatedAt?: number | null;
  /** Review window (ms) after submission before a dispute is allowed. */
  reviewWindowMs?: number;
  /** Dispute window (ms) after submission before a dispute is no longer allowed. */
  disputeWindowMs?: number;
  /** Refund timeout (ms) after assignment before a refund can be claimed. */
  refundTimeoutMs?: number;
  /** Current time override (ms) for deterministic testing. */
  now?: number;
}

export interface JobActionEligibility {
  allowed: boolean;
  reason?: string;
}

export interface JobActionsEligibility {
  dispute: JobActionEligibility;
  claimRefund: JobActionEligibility;
}

export const DEFAULT_REVIEW_WINDOW_MS = 0;
export const DEFAULT_DISPUTE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_REFUND_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

const DISPUTABLE_STATES: JobState[] = ["submitted", "completed"];
const REFUNDABLE_STATES: JobState[] = ["assigned", "submitted"];

function resolveNow(ctx: JobActionContext): number {
  return typeof ctx.now === "number" ? ctx.now : Date.now();
}

function evaluateDispute(ctx: JobActionContext, now: number): JobActionEligibility {
  if (!DISPUTABLE_STATES.includes(ctx.state)) {
    return {
      allowed: false,
      reason: `Disputes are not available while the job is ${ctx.state}.`,
    };
  }

  const anchor = ctx.submittedAt ?? ctx.completedAt ?? ctx.updatedAt ?? null;
  if (anchor == null) {
    return {
      allowed: false,
      reason: "Disputes require a recorded submission time.",
    };
  }

  const reviewWindowMs = ctx.reviewWindowMs ?? DEFAULT_REVIEW_WINDOW_MS;
  const disputeWindowMs = ctx.disputeWindowMs ?? DEFAULT_DISPUTE_WINDOW_MS;
  const elapsed = now - anchor;

  if (elapsed < reviewWindowMs) {
    return {
      allowed: false,
      reason: "The review window has not elapsed yet.",
    };
  }

  if (elapsed > disputeWindowMs) {
    return {
      allowed: false,
      reason: "The dispute window has expired.",
    };
  }

  return { allowed: true };
}

function evaluateClaimRefund(ctx: JobActionContext, now: number): JobActionEligibility {
  if (!REFUNDABLE_STATES.includes(ctx.state)) {
    return {
      allowed: false,
      reason: `Refunds are not available while the job is ${ctx.state}.`,
    };
  }

  const anchor = ctx.assignedAt ?? ctx.updatedAt ?? null;
  if (anchor == null) {
    return {
      allowed: false,
      reason: "Refunds require a recorded assignment time.",
    };
  }

  const refundTimeoutMs = ctx.refundTimeoutMs ?? DEFAULT_REFUND_TIMEOUT_MS;
  const elapsed = now - anchor;

  if (elapsed < refundTimeoutMs) {
    return {
      allowed: false,
      reason: "The refund timeout has not been reached yet.",
    };
  }

  return { allowed: true };
}

/**
 * Derive which job actions are currently allowed, mirroring the on-chain
 * contract rules for dispute and claim-refund. Returns a reason whenever an
 * action is denied so the dashboard can hide it and explain why.
 */
export function getJobActionsEligibility(ctx: JobActionContext): JobActionsEligibility {
  const now = resolveNow(ctx);
  return {
    dispute: evaluateDispute(ctx, now),
    claimRefund: evaluateClaimRefund(ctx, now),
  };
}
