import { scValToNative, xdr } from "@stellar/stellar-sdk";

const JOB_EVENT_TYPES = new Set([
  "JobSubmitted",
  "JobCompleted",
  "JobCancelled",
  "JobDisputed",
]);

export function getJobEventType(event: Record<string, unknown>): string | null {
  const eventType = event.event_type ?? event.eventType ?? event.type;
  if (typeof eventType === "string" && JOB_EVENT_TYPES.has(eventType)) {
    return eventType;
  }

  const payload = (event.payload ?? event.data) as Record<string, unknown> | undefined;
  const topics = payload?.topics;
  if (!Array.isArray(topics) || topics.length === 0) return null;
  const topic = topics[0];
  try {
    const raw =
      typeof topic === "string"
        ? topic
        : typeof topic === "object" && topic !== null && "xdr" in topic
          ? (topic as { xdr: string }).xdr
          : null;
    if (raw) {
      const decoded = String(scValToNative(xdr.ScVal.fromXDR(raw, "base64")));
      return JOB_EVENT_TYPES.has(decoded) ? decoded : null;
    }
    if (typeof topic === "object" && topic !== null && "value" in topic) {
      const decoded = String((topic as { value: unknown }).value);
      return JOB_EVENT_TYPES.has(decoded) ? decoded : null;
    }
  } catch {
    return null;
  }
  return null;
}

function eventJobId(event: Record<string, unknown>): bigint | null {
  const payload = (event.payload ?? event.data) as Record<string, unknown> | undefined;
  const value = payload?.value;
  try {
    let nativeValue: unknown = value;
    if (value instanceof xdr.ScVal) {
      nativeValue = scValToNative(value);
    } else if (typeof value === "string") {
      nativeValue = scValToNative(xdr.ScVal.fromXDR(value, "base64"));
    } else if (
      typeof value === "object" &&
      value !== null &&
      "xdr" in value &&
      typeof value.xdr === "string"
    ) {
      nativeValue = scValToNative(xdr.ScVal.fromXDR(value.xdr, "base64"));
    }
    const rawJobId = Array.isArray(nativeValue)
      ? nativeValue[0]
      : typeof nativeValue === "object" && nativeValue !== null
        ? (nativeValue as Record<string, unknown>).job_id ??
          (nativeValue as Record<string, unknown>).jobId ??
          (nativeValue as Record<string, unknown>).id
        : nativeValue;
    if (typeof rawJobId === "bigint") return rawJobId;
    if (typeof rawJobId === "string" || typeof rawJobId === "number") {
      return BigInt(rawJobId);
    }
  } catch {
    return null;
  }
  return null;
}

export function matchesJobEvent(
  event: Record<string, unknown>,
  contractId: string,
  jobId: bigint,
): boolean {
  const contract = event.contract ?? event.contract_id ?? event.contractId;
  return (
    contract === contractId &&
    getJobEventType(event) !== null &&
    eventJobId(event) === jobId
  );
}

export type JobLifecycleStepKey =
  | "created"
  | "funded"
  | "submitted"
  | "completed"
  | "disputed";

export interface JobLifecycleStep {
  key: JobLifecycleStepKey;
  label: string;
  /** Order in which the step occurs in the job lifecycle. */
  order: number;
}

export const JOB_LIFECYCLE_STEPS: readonly JobLifecycleStep[] = [
  { key: "created", label: "Created", order: 0 },
  { key: "funded", label: "Funded", order: 1 },
  { key: "submitted", label: "Submitted", order: 2 },
  { key: "completed", label: "Completed", order: 3 },
  { key: "disputed", label: "Disputed", order: 3 },
];

const EVENT_TYPE_TO_STEP: Record<string, JobLifecycleStepKey> = {
  JobCreated: "created",
  JobFunded: "funded",
  JobSubmitted: "submitted",
  JobCompleted: "completed",
  JobCancelled: "completed",
  JobDisputed: "disputed",
};

/**
 * Maps a raw event type (e.g. `JobSubmitted`) to its lifecycle step.
 * Returns `null` for unknown or missing event types.
 */
export function getLifecycleStepForEventType(
  eventType: string | null | undefined,
): JobLifecycleStep | null {
  if (!eventType) return null;
  const key = EVENT_TYPE_TO_STEP[eventType];
  if (!key) return null;
  return JOB_LIFECYCLE_STEPS.find((step) => step.key === key) ?? null;
}

export interface NormalizedJobEvent {
  type: string | null;
  step: JobLifecycleStep | null;
  /** Ledger close time in milliseconds since epoch, or `null` if unavailable. */
  ledgerCloseTime: number | null;
  /** Transaction hash, or `null` if unavailable. */
  txHash: string | null;
}

function toLedgerCloseTime(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic: values below 1e12 are seconds, otherwise milliseconds.
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber)) return toLedgerCloseTime(asNumber);
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : time;
  }
  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

/**
 * Normalizes the fields the timeline renderer needs from a raw event,
 * tolerating missing or differently-named fields.
 */
export function normalizeJobEvent(
  event: Record<string, unknown>,
): NormalizedJobEvent {
  const type = getJobEventType(event);
  const ledgerCloseTime = toLedgerCloseTime(
    event.ledger_close_time ??
      event.ledgerCloseTime ??
      event.ledger_closed_at ??
      event.ledgerClosedAt ??
      event.close_time ??
      event.closeTime ??
      event.timestamp ??
      event.created_at,
  );
  const txHash = firstString(
    event.tx_hash,
    event.txHash,
    event.transaction_hash,
    event.transactionHash,
    event.hash,
  );
  return {
    type,
    step: getLifecycleStepForEventType(type),
    ledgerCloseTime,
    txHash,
  };
}

/**
 * Builds an ordered lifecycle timeline from a list of raw events.
 * Every lifecycle step is always present; steps without a matching event
 * have `event: null` so the renderer can show a pending state.
 */
export interface JobTimelineEntry {
  step: JobLifecycleStep;
  event: NormalizedJobEvent | null;
}

export function buildJobTimeline(
  events: readonly Record<string, unknown>[] | null | undefined,
): JobTimelineEntry[] {
  const byStep = new Map<JobLifecycleStepKey, NormalizedJobEvent>();
  for (const raw of events ?? []) {
    const normalized = normalizeJobEvent(raw);
    if (!normalized.step) continue;
    const existing = byStep.get(normalized.step.key);
    // Keep the earliest event for each step.
    if (
      !existing ||
      (normalized.ledgerCloseTime !== null &&
        (existing.ledgerCloseTime === null ||
          normalized.ledgerCloseTime < existing.ledgerCloseTime))
    ) {
      byStep.set(normalized.step.key, normalized);
    }
  }

  return [...JOB_LIFECYCLE_STEPS]
    .sort((a, b) => a.order - b.order)
    .map((step) => ({ step, event: byStep.get(step.key) ?? null }));
}
