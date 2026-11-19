import { z } from "zod";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

/**
 * Validate a Stellar StrKey Ed25519 secret key (starts with "S").
 */
export const StellarSecretKeySchema = z.string().refine(
  (value) => {
    try {
      Keypair.fromSecret(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: "Invalid Stellar secret key (expected StrKey Ed25519 secret starting with 'S')" },
);

/**
 * Validate a Stellar StrKey Ed25519 public key (starts with "G").
 */
export const StellarPublicKeySchema = z.string().refine(
  (value) => {
    try {
      return StrKey.isValidEd25519PublicKey(value);
    } catch {
      return false;
    }
  },
  { message: "Invalid Stellar public key (expected StrKey Ed25519 public key starting with 'G')" },
);

export const ContractAddressesSchema = z.object({
  AGENT_IDENTITY_CONTRACT: StellarPublicKeySchema,
  AGENTIC_COMMERCE_CONTRACT: StellarPublicKeySchema,
  USDC_TOKEN_CONTRACT: StellarPublicKeySchema,
});

export type ContractAddresses = z.infer<typeof ContractAddressesSchema>;

export const AgentConfigSchema = z.object({
  STELLAR_RPC_URL: z.string().url({ message: "STELLAR_RPC_URL must be a valid URL" }),
  STELLAR_NETWORK_PASSPHRASE: z
    .string()
    .min(1, { message: "STELLAR_NETWORK_PASSPHRASE must not be empty" }),
  SECRET_KEY: StellarSecretKeySchema,
  CONTRACT_ADDRESSES: ContractAddressesSchema,
  PORT: z.coerce
    .number({ invalid_type_error: "PORT must be a number" })
    .int({ message: "PORT must be an integer" })
    .positive({ message: "PORT must be a positive integer" })
    .max(65535, { message: "PORT must be <= 65535" }),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/**
 * Format Zod issues into a readable terminal table.
 */
export function formatConfigIssues(issues: z.ZodIssue[]): string {
  const rows = issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));
  const pathWidth = Math.max(4, ...rows.map((r) => r.path.length));
  const msgWidth = Math.max(7, ...rows.map((r) => r.message.length));
  const line = `+-${"-".repeat(pathWidth)}-+-${"-".repeat(msgWidth)}-+`;
  const formatRow = (path: string, message: string) =>
    `| ${path.padEnd(pathWidth)} | ${message.padEnd(msgWidth)} |`;
  const out = [
    line,
    formatRow("Path", "Message"),
    line,
    ...rows.map((r) => formatRow(r.path, r.message)),
    line,
  ];
  return out.join("\n");
}

/**
 * Flatten a Zod schema into a list of leaf env keys with their descriptions.
 * Used to generate `.env.example` files from the schema.
 */
export interface EnvSchemaEntry {
  key: string;
  description?: string;
  optional: boolean;
}

function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current: z.ZodTypeAny = schema;
  // Unwrap optional/nullable/default/effects wrappers to inspect the inner type.
  for (;;) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodDefault) {
      current = current.removeDefault() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodEffects) {
      current = current.innerType() as z.ZodTypeAny;
      continue;
    }
    return current;
  }
}

function isOptionalSchema(schema: z.ZodTypeAny): boolean {
  let current: z.ZodTypeAny = schema;
  for (;;) {
    if (current instanceof z.ZodOptional) return true;
    if (current instanceof z.ZodNullable) {
      current = current.unwrap() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodDefault) return true;
    if (current instanceof z.ZodEffects) {
      current = current.innerType() as z.ZodTypeAny;
      continue;
    }
    return false;
  }
}

/**
 * Flatten an env schema into a list of leaf keys. Nested objects are flattened
 * with their keys joined by `_` (e.g. CONTRACT_ADDRESSES.AGENT_IDENTITY_CONTRACT
 * becomes AGENT_IDENTITY_CONTRACT).
 */
export function describeEnvSchema(
  schema: z.ZodObject<z.ZodRawShape>,
  prefix = "",
): EnvSchemaEntry[] {
  const entries: EnvSchemaEntry[] = [];
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  for (const [key, value] of Object.entries(shape)) {
    const inner = unwrapSchema(value);
    if (inner instanceof z.ZodObject) {
      entries.push(...describeEnvSchema(inner as z.ZodObject<z.ZodRawShape>, prefix));
      continue;
    }
    entries.push({
      key: `${prefix}${key}`,
      description: value.description,
      optional: isOptionalSchema(value),
    });
  }
  return entries;
}

/**
 * Render a `.env.example` file body from an env schema.
 */
export function generateEnvExample(schema: z.ZodObject<z.ZodRawShape>): string {
  const entries = describeEnvSchema(schema);
  const lines: string[] = [
    "# Generated from the agent env schema. Do not edit by hand.",
    "",
  ];
  for (const entry of entries) {
    if (entry.description) lines.push(`# ${entry.description}`);
    lines.push(`${entry.key}=`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Validate a raw environment object against AgentConfigSchema.
 * Throws a readable error (with a terminal table) on failure.
 */
export function validateAgentConfig(
  env: Record<string, string | undefined> = process.env,
): AgentConfig {
  const result = AgentConfigSchema.safeParse({
    STELLAR_RPC_URL: env.STELLAR_RPC_URL,
    STELLAR_NETWORK_PASSPHRASE: env.STELLAR_NETWORK_PASSPHRASE,
    SECRET_KEY: env.SECRET_KEY,
    CONTRACT_ADDRESSES: {
      AGENT_IDENTITY_CONTRACT: env.AGENT_IDENTITY_CONTRACT,
      AGENTIC_COMMERCE_CONTRACT: env.AGENTIC_COMMERCE_CONTRACT,
      USDC_TOKEN_CONTRACT: env.USDC_TOKEN_CONTRACT,
    },
    PORT: env.PORT,
  });
  if (!result.success) {
    throw new Error(
      `Invalid agent configuration:\n${formatConfigIssues(result.error.issues)}`,
    );
  }
  return result.data;
}

/**
 * Validate `env` against `schema` at agent startup. On failure, prints a
 * formatted table of missing/invalid keys to stderr and exits with code 1.
 * On success, returns the parsed configuration.
 */
export function validateEnv<T extends z.ZodTypeAny>(
  schema: T,
  env: Record<string, string | undefined> = process.env,
  options: {
    logger?: Pick<Console, "error">;
    exit?: (code: number) => void;
  } = {},
): z.infer<T> {
  const logger = options.logger ?? console;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const result = schema.safeParse(env);
  if (!result.success) {
    logger.error(
      `Invalid agent configuration:\n${formatConfigIssues(result.error.issues)}`,
    );
    exit(1);
    // If exit is stubbed (e.g. in tests), throw so callers don't continue.
    throw new Error("Invalid agent configuration");
  }
  return result.data as z.infer<T>;
}

/**
 * Strictly typed agent configuration, validated at boot.
 */
export const agentConfig: AgentConfig = validateAgentConfig(process.env);

export const AGENT_LLM_PROVIDER = process.env.AGENT_LLM_PROVIDER ?? "openai";
export const AGENT_LLM_MODEL =
  process.env.AGENT_LLM_MODEL ??
  (AGENT_LLM_PROVIDER === "anthropic" ? "claude-3-5-sonnet-latest" : "gpt-4o");

/**
 * Per-agent env schemas. Each agent validates its own required variables at
 * startup via `validateEnv(<schema>)`.
 */
export const BuyerAgentEnvSchema = AgentConfigSchema.extend({
  AGENT_LLM_PROVIDER: z
    .enum(["openai", "anthropic"])
    .default("openai")
    .describe("LLM provider used for task classification"),
  AGENT_LLM_MODEL: z
    .string()
    .optional()
    .describe("Override the default LLM model name"),
  OPENAI_API_KEY: z
    .string()
    .optional()
    .describe("Required when AGENT_LLM_PROVIDER=openai"),
  ANTHROPIC_API_KEY: z
    .string()
    .optional()
    .describe("Required when AGENT_LLM_PROVIDER=anthropic"),
});

export type BuyerAgentEnv = z.infer<typeof BuyerAgentEnvSchema>;

export const SellerAgentEnvSchema = AgentConfigSchema.extend({
  AGENT_LLM_PROVIDER: z
    .enum(["openai", "anthropic"])
    .default("openai")
    .describe("LLM provider used for task execution"),
  AGENT_LLM_MODEL: z
    .string()
    .optional()
    .describe("Override the default LLM model name"),
  OPENAI_API_KEY: z
    .string()
    .optional()
    .describe("Required when AGENT_LLM_PROVIDER=openai"),
  ANTHROPIC_API_KEY: z
    .string()
    .optional()
    .describe("Required when AGENT_LLM_PROVIDER=anthropic"),
});

export type SellerAgentEnv = z.infer<typeof SellerAgentEnvSchema>;

export const AGENT_ENV_SCHEMAS = {
  buyer: BuyerAgentEnvSchema,
  seller: SellerAgentEnvSchema,
} as const;

export type AgentName = keyof typeof AGENT_ENV_SCHEMAS;

export const CAPABILITY_TAGS = [
  "code-generation",
  "code-review",
  "data-analysis",
  "translation",
  "summarization",
  "image-generation",
  "web-scraping",
  "smart-contract-audit",
] as const;

export type CapabilityTag = (typeof CAPABILITY_TAGS)[number];

export const TaskClassificationSchema = z.object({
  capabilities: z.array(z.enum(CAPABILITY_TAGS)).min(1),
  summary: z.string(),
  maxPrice: z.number().nonnegative().optional(),
});

export type TaskClassification = z.infer<typeof TaskClassificationSchema>;

export const ProviderSelectionSchema = z.object({
  jobId: z.string(),
  provider: z.string(),
  cost: z.number().nonnegative(),
  result: z.unknown().optional(),
});

export type ProviderSelection = z.infer<typeof ProviderSelectionSchema>;

export interface RegistryAgent {
  id: string;
  capabilities: CapabilityTag[];
  reputation: number;
  price: number;
}

/**
 * Emit `.env.example` content for a given agent (or all agents) from the
 * registered env schemas. Used by scripts/generate-env-example.ts.
 */
export function generateAgentEnvExample(agent: AgentName): string {
  return generateEnvExample(AGENT_ENV_SCHEMAS[agent]);
}

interface LlmMessage {
  role: "system" | "user";
  content: string;
}

async function callOpenAi(messages: LlmMessage[]): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: AGENT_LLM_MODEL,
      messages,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI request failed: ${res.status}`);
  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  return data.choices[0].message.content;
}

async function callAnthropic(messages: LlmMessage[]): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const system = messages.find((m) => m.role === "system")?.content;
  const userMessages = messages.filter((m) => m.role === "user");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: AGENT_LLM_MODEL,
      max_tokens: 1024,
      system,
      messages: userMessages,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic request failed: ${res.status}`);
  const data = (await res.json()) as { content: { text: string }[] };
  return data.content[0].text;
}

async function callLlm(messages: LlmMessage[]): Promise<string> {
  return AGENT_LLM_PROVIDER === "anthropic"
    ? callAnthropic(messages)
    : callOpenAi(messages);
}

function extractJson(raw: string): unknown {
  const match = raw.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : raw);
}

/**
 * Classify a natural-language task into capability tags using the configured LLM.
 */
export async function classifyTask(prompt: string): Promise<TaskClassification> {
  const raw = await callLlm([
    {
      role: "system",
      content:
        "You classify buyer tasks. Respond with JSON only: " +
        `{"capabilities": string[], "summary": string, "maxPrice"?: number}. ` +
        `Allowed capabilities: ${CAPABILITY_TAGS.join(", ")}.`,
    },
    { role: "user", content: prompt },
  ]);
  return TaskClassificationSchema.parse(extractJson(raw));
}

/**
 * Find registry agents that cover every requested capability.
 */
export function findMatchingAgents(
  agents: RegistryAgent[],
  capabilities: CapabilityTag[],
): RegistryAgent[] {
  return agents.filter((agent) =>
    capabilities.every((cap) => agent.capabilities.includes(cap)),
  );
}

/**
 * Select the best provider by reputation score and price.
 */
export function selectProvider(
  agents: RegistryAgent[],
  maxPrice?: number,
): RegistryAgent | undefined {
  const candidates =
    maxPrice === undefined ? agents : agents.filter((a) => a.price <= maxPrice);
  return candidates.sort((a, b) => {
    if (b.reputation !== a.reputation) return b.reputation - a.reputation;
    return a.price - b.price;
  })[0];
}

export interface EscrowJob {
  id: string;
  provider: string;
  cost: number;
  status: "pending" | "completed" | "failed";
  result?: unknown;
}

export interface BuyerAgentDeps {
  listAgents: () => Promise<RegistryAgent[]>;
  createEscrowJob: (input: {
    provider: string;
    cost: number;
    capabilities: CapabilityTag[];
  }) => Promise<EscrowJob>;
  getJob: (jobId: string) => Promise<EscrowJob>;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  factor?: number;
  /** Maximum delay cap in ms (defaults to 30000). */
  maxDelayMs?: number;
  /** Jitter ratio in [0, 1]; delay is randomized within +/- jitter * delay. */
  jitter?: number;
  /** Predicate to decide whether an error is retryable. Defaults to isRetryableError. */
  isRetryable?: (error: unknown) => boolean;
  /** Called before each retry sleep with the attempt number and computed delay. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Injectable sleep for tests. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Injectable random source for deterministic jitter in tests. */
  random?: () => number;
}

export const DEFAULT_RETRY_OPTIONS: Required<
  Pick<RetryOptions, "maxRetries" | "initialDelayMs" | "factor" | "maxDelayMs" | "jitter">
> = {
  maxRetries: 5,
  initialDelayMs: 1000,
  factor: 2,
  maxDelayMs: 30000,
  jitter: 0.2,
};

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const RETRYABLE_MESSAGE_PATTERNS = [
  /\b429\b/,
  /\b503\b/,
  /rate.?limit/i,
  /too many requests/i,
  /service unavailable/i,
  /temporarily unavailable/i,
  /timed? ?out/i,
  /socket hang up/i,
  /network error/i,
  /fetch failed/i,
];

function extractHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as Record<string, unknown>;
  const candidates = [e.status, e.statusCode, e.httpStatus];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  if (e.response && typeof e.response === "object") {
    const status = (e.response as Record<string, unknown>).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

function extractErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as Record<string, unknown>;
  if (typeof e.code === "string") return e.code;
  if (e.cause && typeof e.cause === "object") {
    const causeCode = (e.cause as Record<string, unknown>).code;
    if (typeof causeCode === "string") return causeCode;
  }
  return undefined;
}

/**
 * Determine whether an error is transient and safe to retry.
 * Retries HTTP 429/503 (and other transient statuses), common network error
 * codes such as ECONNRESET, and rate-limit/timeout messages.
 */
export function isRetryableError(error: unknown): boolean {
  if (!error) return false;
  const status = extractHttpStatus(error);
  if (status !== undefined && RETRYABLE_HTTP_STATUSES.has(status)) return true;
  const code = extractErrorCode(error);
  if (code && RETRYABLE_ERROR_CODES.has(code)) return true;
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (message && RETRYABLE_MESSAGE_PATTERNS.some((re) => re.test(message))) {
    return true;
  }
  return false;
}

/**
 * Compute the jittered exponential backoff delay for a given retry attempt.
 * attempt is 1-based: attempt 1 uses initialDelayMs, attempt 2 uses
 * initialDelayMs * factor, and so on, capped at maxDelayMs.
 */
export function computeBackoffDelay(
  attempt: number,
  options: RetryOptions = {},
  random: () => number = Math.random,
): number {
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_RETRY_OPTIONS.initialDelayMs;
  const factor = options.factor ?? DEFAULT_RETRY_OPTIONS.factor;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RETRY_OPTIONS.maxDelayMs;
  const jitter = options.jitter ?? DEFAULT_RETRY_OPTIONS.jitter;

  const safeAttempt = Math.max(1, Math.floor(attempt));
  const base = Math.min(initialDelayMs * Math.pow(factor, safeAttempt - 1), maxDelayMs);
  if (jitter <= 0) return Math.round(base);
  const clampedJitter = Math.min(jitter, 1);
  // random in [0, 1) -> offset in [-clampedJitter, +clampedJitter)
  const offset = (random() * 2 - 1) * clampedJitter;
  return Math.max(0, Math.round(base * (1 + offset)));
}

/**
 * Execute `fn` with exponential backoff and jitter. Only retryable errors are
 * retried; non-retryable errors are rethrown immediately. When retries are
 * exhausted, the last error is rethrown.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_RETRY_OPTIONS.maxRetries;
  const isRetryable = options.isRetryable ?? isRetryableError;
  const sleepFn = options.sleepFn ?? sleep;
  const random = options.random ?? Math.random;

  let attempt = 0;
  // Total attempts = 1 initial + maxRetries retries.
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxRetries || !isRetryable(error)) {
        throw error;
      }
      attempt += 1;
      const delayMs = computeBackoffDelay(attempt, options, random);
      options.onRetry?.(error, attempt, delayMs);
      await sleepFn(delayMs);
    }
  }
}

export interface DeadLetterJobRecord {
  id: string;
  jobId: string;
  agentId?: string;
  provider?: string;
  payload: unknown;
  errorMessage: string;
  errorStack?: string;
  errorName?: string;
  attempts: number;
  createdAt: string;
  replayedAt?: string;
  status: "pending" | "replayed" | "resolved";
}

export interface DeadLetterJobInput {
  jobId: string;
  agentId?: string;
  provider?: string;
  payload: unknown;
  error: unknown;
  attempts: number;
}

export interface DeadLetterQueueStore {
  /** Persist a failed job to the dead_letter_jobs table. */
  save: (record: DeadLetterJobRecord) => Promise<void>;
  /** List DLQ entries, optionally filtered by status. */
  list: (status?: DeadLetterJobRecord["status"]) => Promise<DeadLetterJobRecord[]>;
  /** Fetch a single DLQ entry by id. */
  get: (id: string) => Promise<DeadLetterJobRecord | undefined>;
  /** Mark an entry as replayed/resolved. */
  markReplayed: (id: string, status: "replayed" | "resolved") => Promise<void>;
}

let deadLetterQueueStore: DeadLetterQueueStore | undefined;

/**
 * Register the persistence hook used to write to the dead_letter_jobs table.
 * Call this during agent startup once the DB connection is available.
 */
export function setDeadLetterQueueStore(store: DeadLetterQueueStore | undefined): void {
  deadLetterQueueStore = store;
}

export function getDeadLetterQueueStore(): DeadLetterQueueStore | undefined {
  return deadLetterQueueStore;
}

function serializeError(error: unknown): {
  errorMessage: string;
  errorStack?: string;
  errorName?: string;
} {
  if (error instanceof Error) {
    return {
      errorMessage: error.message,
      errorStack: error.stack,
      errorName: error.name,
    };
  }
  if (typeof error === "string") return { errorMessage: error };
  try {
    return { errorMessage: JSON.stringify(error) };
  } catch {
    return { errorMessage: String(error) };
  }
}

function generateDlqId(): string {
  return `dlq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Serialize a failed job and its full error diagnostics to the dead_letter_jobs
 * table via the registered store. Returns the persisted record.
 */
export async function persistToDeadLetterQueue(
  input: DeadLetterJobInput,
  store: DeadLetterQueueStore | undefined = deadLetterQueueStore,
): Promise<DeadLetterJobRecord> {
  const { errorMessage, errorStack, errorName } = serializeError(input.error);
  const record: DeadLetterJobRecord = {
    id: generateDlqId(),
    jobId: input.jobId,
    agentId: input.agentId,
    provider: input.provider,
    payload: input.payload,
    errorMessage,
    errorStack,
    errorName,
    attempts: input.attempts,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  if (!store) {
    throw new Error("Dead-letter queue store is not configured");
  }
  await store.save(record);
  return record;
}

/**
 * Run a job task with retries; if retries are exhausted (or a non-retryable
 * error occurs), persist the job payload and error diagnostics to the DLQ and
 * rethrow the error.
 */
export async function withRetryAndDlq<T>(
  job: { jobId: string; agentId?: string; provider?: string; payload: unknown },
  fn: () => Promise<T>,
  options: RetryOptions & { store?: DeadLetterQueueStore } = {},
): Promise<T> {
  let attempts = 0;
  try {
    return await withRetry(fn, {
      ...options,
      onRetry: (error, attempt, delayMs) => {
        attempts = attempt;
        options.onRetry?.(error, attempt, delayMs);
      },
    });
  } catch (error) {
    attempts = Math.max(attempts, 1);
    await persistToDeadLetterQueue(
      {
        jobId: job.jobId,
        agentId: job.agentId,
        provider: job.provider,
        payload: job.payload,
        error,
        attempts,
      },
      options.store,
    );
    throw error;
  }
}

/**
 * List dead-letter queue entries for admin inspection.
 */
export async function listDeadLetterJobs(
  status?: DeadLetterJobRecord["status"],
  store: DeadLetterQueueStore | undefined = deadLetterQueueStore,
): Promise<DeadLetterJobRecord[]> {
  if (!store) throw new Error("Dead-letter queue store is not configured");
  return store.list(status);
}

export interface ReplayDeadLetterOptions {
  store?: DeadLetterQueueStore;
  /** Handler that re-executes the original job payload. */
  replay: (record: DeadLetterJobRecord) => Promise<unknown>;
  retryOptions?: RetryOptions;
}

export interface ReplayDeadLetterResult {
  id: string;
  jobId: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Replay a single DLQ entry by id. Used by POST /api/agent/dlq/retry.
 */
export async function replayDeadLetterJob(
  id: string,
  options: ReplayDeadLetterOptions,
): Promise<ReplayDeadLetterResult> {
  const store = options.store ?? deadLetterQueueStore;
  if (!store) throw new Error("Dead-letter queue store is not configured");
  const record = await store.get(id);
  if (!record) throw new Error(`Dead-letter job ${id} not found`);

  try {
    const result = await withRetry(() => options.replay(record), options.retryOptions);
    await store.markReplayed(id, "resolved");
    return { id, jobId: record.jobId, success: true, result };
  } catch (error) {
    await store.markReplayed(id, "replayed");
    const { errorMessage } = serializeError(error);
    return { id, jobId: record.jobId, success: false, error: errorMessage };
  }
}

/**
 * Replay all pending DLQ entries (or a specific set of ids). Used by
 * POST /api/agent/dlq/retry when no id is provided.
 */
export async function replayPendingDeadLetterJobs(
  options: ReplayDeadLetterOptions & { ids?: string[] },
): Promise<ReplayDeadLetterResult[]> {
  const store = options.store ?? deadLetterQueueStore;
  if (!store) throw new Error("Dead-letter queue store is not configured");
  const records = options.ids
    ? (await Promise.all(options.ids.map((id) => store.get(id)))).filter(
        (r): r is DeadLetterJobRecord => Boolean(r),
      )
    : await store.list("pending");
  const results: ReplayDeadLetterResult[] = [];
  for (const record of records) {
    results.push(await replayDeadLetterJob(record.id, options));
  }
  return results;
}

/**
 * Tracks in-flight jobs so they can be awaited during graceful shutdown.
 */
export interface ActiveTaskTracker {
  track: (task: Promise<unknown>) => Promise<unknown>;
  untrack: (task: Promise<unknown>) => void;
  awaitAll: (timeoutMs: number) => Promise<boolean>;
  size: () => number;
}

/**
 * Create an ActiveTaskTracker. Tasks passed to `track` are awaited by `awaitAll`.
 * `awaitAll` resolves to true if all tasks settled before the timeout, false otherwise.
 */
export function createActiveTaskTracker(): ActiveTaskTracker {
  const tasks = new Set<Promise<unknown>>();

  const untrack = (task: Promise<unknown>) => {
    tasks.delete(task);
  };

  return {
    track(task: Promise<unknown>) {
      tasks.add(task);
      task.then(
        () => untrack(task),
        () => untrack(task),
      );
      return task;
    },
    untrack,
    async awaitAll(timeoutMs: number): Promise<boolean> {
      if (tasks.size === 0) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      const settled = Promise.allSettled([...tasks]).then(() => true as const);
      try {
        return await Promise.race([settled, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    size() {
      return tasks.size;
    },
  };
}

export interface GracefulShutdownServer {
  close: (callback?: (err?: Error) => void) => unknown;
}

export interface GracefulShutdownDb {
  close: () => void;
}

export interface GracefulShutdownOptions {
  timeoutMs?: number;
  logger?: Pick<Console, "log" | "warn" | "error">;
  exit?: (code: number) => void;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15000;

/**
 * Flush any buffered log output. Console writes are synchronous for TTYs and
 * pipes in Node, so this is a no-op hook that can be overridden by callers.
 */
function flushLogs(logger: Pick<Console, "log" | "warn" | "error">): void {
  try {
    (logger as { flush?: () => void }).flush?.();
  } catch {
    // ignore flush errors during shutdown
  }
}

/**
 * Install SIGTERM/SIGINT handlers that gracefully drain in-flight work.
 * Idempotent: repeated calls are ignored after the first registration.
 */
export function registerGracefulShutdown(
  server: GracefulShutdownServer,
  activeTaskTracker: ActiveTaskTracker,
  db?: GracefulShutdownDb,
  options: GracefulShutdownOptions = {},
): () => void {
  const logger = options.logger ?? console;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`[shutdown] received ${signal}, draining in-flight tasks...`);

    const serverClosed = new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });

    const drained = await activeTaskTracker.awaitAll(timeoutMs);
    await serverClosed;

    if (!drained) {
      logger.warn(
        `[shutdown] timed out after ${timeoutMs}ms with ${activeTaskTracker.size()} task(s) still running`,
      );
      flushLogs(logger);
      exit(1);
      return;
    }

    if (db) {
      try {
        db.close();
      } catch (err) {
        logger.error("[shutdown] failed to close database", err);
      }
    }

    flushLogs(logger);
    logger.log("[shutdown] complete");
    exit(0);
  };

  const onSigterm = () => void shutdown("SIGTERM");
  const onSigint = () => void shutdown("SIGINT");

  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);

  return () => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
  };
}

/**
 * Run the full buyer flow: classify -> registry lookup -> select -> escrow -> poll.
 */
export async function runBuyerAgent(
  prompt: string,
  deps: BuyerAgentDeps,
): Promise<ProviderSelection> {
  const classification = await classifyTask(prompt);
  const agents = await deps.listAgents();
  const matches = findMatchingAgents(agents, classification.capabilities);
  const provider = selectProvider(matches, classification.maxPrice);
  if (!provider) {
    throw new Error(
      `No provider found for capabilities: ${classification.capabilities.join(", ")}`,
    );
  }

  const pollIntervalMs = deps.pollIntervalMs ?? 2000;
  const timeoutMs = deps.timeoutMs ?? 60000;
  const deadline = Date.now() + timeoutMs;

  let job = await deps.createEscrowJob({
    provider: provider.id,
    cost: provider.price,
    capabilities: classification.capabilities,
  });

  while (Date.now() < deadline) {
    job = await deps.getJob(job.id);
    if (job.status === "completed") {
      return ProviderSelectionSchema.parse({
        jobId: job.id,
        provider: provider.id,
        cost: job.cost,
        result: job.result,
      });
    }
    if (job.status === "failed") break;
    await sleep(pollIntervalMs);
  }

  throw new Error(`Provider ${provider.id} failed to complete job ${job.id} in time`);
}
