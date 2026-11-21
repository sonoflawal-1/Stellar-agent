// Mirrors the on-chain `JobStatus` enum in the agentic-commerce contract.
export type JobStatus =
  | 'Open'
  | 'Funded'
  | 'Submitted'
  | 'Completed'
  | 'Rejected'
  | 'Cancelled'
  | 'Disputed';

export type JobStatusType = JobStatus;

// ---------------------------------------------------------------------------
// Agent detail (#975)
// ---------------------------------------------------------------------------

/** A single validation error produced when checking agent metadata against
 * `docs/agent-metadata-schema-v1.json`. */
export interface MetadataValidationError {
  /** JSON pointer-ish path to the offending field, e.g. `/name` or `/skills/0`. */
  path: string;
  /** Human readable message describing why validation failed. */
  message: string;
  /** Optional JSON-schema keyword that failed (e.g. `required`, `type`). */
  keyword?: string;
}

/** Result of validating an agent's metadata JSON against the v1 schema. */
export interface MetadataValidationResult {
  /** True when the metadata is valid against the schema. */
  valid: boolean;
  /** Validation errors; empty when `valid` is true. */
  errors: MetadataValidationError[];
  /** The parsed metadata object, if it could be parsed as JSON. */
  metadata?: Record<string, unknown> | null;
  /** Set when the raw metadata could not be parsed as JSON at all. */
  parseError?: string | null;
}

/** Reputation summary for an agent, sourced from the indexer. */
export interface AgentReputation {
  /** Aggregate score (indexer-defined scale, typically 0-100). */
  score: number;
  /** Total number of jobs the agent has participated in. */
  totalJobs: number;
  /** Number of successfully completed jobs. */
  completedJobs: number;
  /** Number of rejected or failed jobs. */
  failedJobs: number;
  /** Number of disputed jobs. */
  disputedJobs: number;
  /** Optional average rating (0-5) if ratings are available. */
  averageRating?: number | null;
  /** Number of ratings contributing to `averageRating`. */
  ratingCount?: number;
  /** ISO timestamp of when the reputation was last updated. */
  updatedAt?: string | null;
}

/** A single entry in an agent's job history. */
export interface AgentJobHistoryEntry {
  /** On-chain job id. */
  jobId: string;
  /** Current status of the job. */
  status: JobStatus;
  /** Role the agent played in the job. */
  role: 'client' | 'provider' | 'evaluator' | 'unknown';
  /** Counterparty address, if known. */
  counterparty?: string | null;
  /** Job amount as a string (base units) to avoid precision loss. */
  amount?: string | null;
  /** ISO timestamp of when the job was created. */
  createdAt?: string | null;
  /** ISO timestamp of when the job reached a terminal state. */
  completedAt?: string | null;
}

/** Full agent detail response returned by the dashboard server. */
export interface AgentDetail {
  /** Agent address / id. */
  address: string;
  /** Optional human readable name from metadata. */
  name?: string | null;
  /** Optional description from metadata. */
  description?: string | null;
  /** Raw metadata JSON as stored on-chain / in the indexer. */
  rawMetadata?: string | null;
  /** Result of validating `rawMetadata` against the v1 schema. */
  metadataValidation: MetadataValidationResult;
  /** Reputation summary from the indexer. */
  reputation: AgentReputation;
  /** Recent job history from the indexer. */
  jobHistory: AgentJobHistoryEntry[];
  /** ISO timestamp of when the agent was first seen. */
  createdAt?: string | null;
}

// ---------------------------------------------------------------------------
// Network switcher (#976)
// ---------------------------------------------------------------------------

/** Supported network presets exposed by `/api/network`. */
export type NetworkPreset = 'testnet' | 'futurenet' | 'mainnet';

/** Network preset descriptor returned by `/api/network`. */
export interface NetworkPresetInfo {
  /** Preset identifier. */
  id: NetworkPreset;
  /** Human readable label. */
  label: string;
  /** Stellar network passphrase. */
  networkPassphrase: string;
  /** Soroban RPC URL. */
  rpcUrl: string;
  /** Horizon URL, if applicable. */
  horizonUrl?: string | null;
  /** Contract id for the agentic-commerce contract on this network. */
  contractId?: string | null;
  /** Whether switching to this network requires explicit confirmation. */
  requiresConfirmation: boolean;
}

/** Response shape of `/api/network`. */
export interface NetworkResponse {
  /** Currently active preset. */
  current: NetworkPreset;
  /** All available presets. */
  presets: NetworkPresetInfo[];
}

/** Client-side state for the network switcher. */
export interface NetworkSwitcherState {
  /** Currently active preset (as reported by the server). */
  current: NetworkPreset;
  /** Preset the user is attempting to switch to, pending confirmation. */
  pending: NetworkPreset | null;
  /** Available presets. */
  presets: NetworkPresetInfo[];
  /** True while a switch request is in flight. */
  switching: boolean;
  /** Error message from the last failed switch, if any. */
  error: string | null;
  /** True when the connected wallet's network does not match `current`. */
  walletMismatch: boolean;
  /** The wallet's reported network passphrase, if known. */
  walletNetworkPassphrase?: string | null;
}

/** Request body for switching networks. */
export interface NetworkSwitchRequest {
  /** Target preset. */
  network: NetworkPreset;
  /** Explicit confirmation flag; required for presets with `requiresConfirmation`. */
  confirm?: boolean;
}

/** Response body for a network switch. */
export interface NetworkSwitchResponse {
  /** Whether the switch succeeded. */
  ok: boolean;
  /** Newly active preset on success. */
  current?: NetworkPreset;
  /** Error message on failure. */
  error?: string;
  /** True when the switch was rejected because confirmation was missing. */
  requiresConfirmation?: boolean;
}