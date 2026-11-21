/**
 * Lifecycle states for a job in `agentic_commerce`.
 *
 * The string values match the Rust enum variant names emitted by
 * `scValToNative` so we can round-trip without a manual mapping table.
 *
 * NOTE: `Open` is reserved for a future "unfunded intent" flow — the current
 * contract transitions straight to `Funded` during `create_job` because the
 * escrow transfer happens atomically. We keep the variant here so the SDK
 * doesn't break when the contract grows.
 */
export enum JobStatus {
  Open = "Open",
  Funded = "Funded",
  Submitted = "Submitted",
  Completed = "Completed",
  Rejected = "Rejected",
  Cancelled = "Cancelled",
  Disputed = "Disputed",
}

/**
 * Reverse mapping from the raw numeric status returned by `getJob()` to the
 * corresponding `JobStatus` string value.
 *
 * The Soroban contract stores `JobStatus` as a compact u32 enum on-chain.
 * When `scValToNative` decodes it you get a number (0-6). The index order
 * matches the Rust enum declaration in `agentic-commerce/src/lib.rs`.
 */
export const JobStatusFromNumber: Record<number, JobStatus> = {
  0: JobStatus.Open,
  1: JobStatus.Funded,
  2: JobStatus.Submitted,
  3: JobStatus.Completed,
  4: JobStatus.Rejected,
  5: JobStatus.Cancelled,
  6: JobStatus.Disputed,
};