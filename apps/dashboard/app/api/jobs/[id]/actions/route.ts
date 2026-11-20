import { NextRequest, NextResponse } from "next/server";
import { getJob } from "@/lib/jobs";

// Contract rules mirrored from the escrow contract:
// - dispute is only allowed while the job is in an active (funded/in-progress) state
// - claim-refund is only allowed after the review window has elapsed without approval
const DISPUTABLE_STATES = new Set(["funded", "in_progress", "submitted"]);
const REFUNDABLE_STATES = new Set(["funded", "in_progress", "submitted"]);

export interface ActionEligibility {
  allowed: boolean;
  reason?: string;
}

export interface JobActionsResponse {
  jobId: string;
  state: string;
  actions: {
    dispute: ActionEligibility;
    claimRefund: ActionEligibility;
  };
}

function evaluateDispute(job: {
  state: string;
}): ActionEligibility {
  if (!DISPUTABLE_STATES.has(job.state)) {
    return {
      allowed: false,
      reason: `Dispute is not available while the job is "${job.state}".`,
    };
  }
  return { allowed: true };
}

function evaluateClaimRefund(job: {
  state: string;
  reviewWindowEndsAt?: string | number | Date | null;
}): ActionEligibility {
  if (!REFUNDABLE_STATES.has(job.state)) {
    return {
      allowed: false,
      reason: `Refund is not available while the job is "${job.state}".`,
    };
  }

  if (!job.reviewWindowEndsAt) {
    return {
      allowed: false,
      reason: "Refund is not available until the review window is set.",
    };
  }

  const reviewWindowEndsAt = new Date(job.reviewWindowEndsAt).getTime();
  if (Number.isNaN(reviewWindowEndsAt)) {
    return {
      allowed: false,
      reason: "Refund is not available: invalid review window.",
    };
  }

  if (Date.now() < reviewWindowEndsAt) {
    return {
      allowed: false,
      reason: "Refund is not available until the review window has elapsed.",
    };
  }

  return { allowed: true };
}

export function evaluateJobActions(job: {
  state: string;
  reviewWindowEndsAt?: string | number | Date | null;
}): JobActionsResponse["actions"] {
  return {
    dispute: evaluateDispute(job),
    claimRefund: evaluateClaimRefund(job),
  };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const job = await getJob(params.id);

  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const body: JobActionsResponse = {
    jobId: job.id,
    state: job.state,
    actions: evaluateJobActions(job),
  };

  return NextResponse.json(body);
}
