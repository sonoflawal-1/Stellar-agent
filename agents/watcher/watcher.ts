// agents/watcher/watcher.ts
import { EventEmitter } from "events";
import { Keypair } from "@stellar/stellar-sdk";
import { CommerceClient } from "../commerce/client";
import { Keeper } from "./keeper";

/**
 * Minimal interface for the indexer query surface used by the watcher.
 * Implemented by indexer/src/db.ts EventStore or the indexer query API.
 */
export interface IndexerQuery {
  /**
   * Returns Funded jobs whose deadline (created_at + timeout) has elapsed
   * relative to the provided timestamp (seconds since epoch).
   */
  findExpiredFundedJobs(nowSeconds: number): Promise<ExpiredJobRecord[]>;
}

export interface ExpiredJobRecord {
  jobId: string;
  client: string;
  provider: string;
  amount: string;
  createdAt: number;
  timeout: number;
  status: string;
}

export interface WatcherConfig {
  pollIntervalMs: number;
  keeper: Keeper;
  commerce: CommerceClient;
  indexer: IndexerQuery;
  logger?: WatcherLogger;
}

export interface WatcherLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const defaultLogger: WatcherLogger = {
  info: (msg, meta) => console.log(JSON.stringify({ level: "info", msg, ...meta })),
  warn: (msg, meta) => console.warn(JSON.stringify({ level: "warn", msg, ...meta })),
  error: (msg, meta) => console.error(JSON.stringify({ level: "error", msg, ...meta })),
};

export interface RefundResult {
  jobId: string;
  client: string;
  amount: string;
  txHash: string;
  action: "cancel" | "expire";
}

/**
 * JobExpirationWatcher polls the indexer for expired Funded jobs, re-verifies
 * on-chain status, and triggers automated refunds via the Keeper.
 */
export class JobExpirationWatcher extends EventEmitter {
  private readonly pollIntervalMs: number;
  private readonly keeper: Keeper;
  private readonly commerce: CommerceClient;
  private readonly indexer: IndexerQuery;
  private readonly logger: WatcherLogger;

  /** Jobs currently being processed (in-flight guard). */
  private readonly inFlight = new Set<string>();
  /** Per-job locks to serialize processing of the same job. */
  private readonly locks = new Map<string, Promise<void>>();

  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(config: WatcherConfig) {
    super();
    this.pollIntervalMs = config.pollIntervalMs;
    this.keeper = config.keeper;
    this.commerce = config.commerce;
    this.indexer = config.indexer;
    this.logger = config.logger ?? defaultLogger;
  }

  /** Start the polling loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info("watcher.started", { pollIntervalMs: this.pollIntervalMs });
    this.scheduleNext(0);
  }

  /** Stop the polling loop and wait for in-flight work to settle. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await Promise.allSettled(Array.from(this.locks.values()));
    this.logger.info("watcher.stopped");
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNext(this.pollIntervalMs));
    }, delayMs);
  }

  /** Run a single polling iteration. Exposed for testing. */
  async tick(): Promise<RefundResult[]> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    let expired: ExpiredJobRecord[];
    try {
      expired = await this.indexer.findExpiredFundedJobs(nowSeconds);
    } catch (err) {
      this.logger.error("watcher.indexer_error", { error: String(err) });
      return [];
    }

    const results: RefundResult[] = [];
    await Promise.all(
      expired.map(async (job) => {
        const result = await this.processJob(job);
        if (result) results.push(result);
      }),
    );
    return results;
  }

  /**
   * Process a single expired job with duplicate-submission guards.
   * Returns the refund result if a refund was submitted, otherwise null.
   */
  async processJob(job: ExpiredJobRecord): Promise<RefundResult | null> {
    const jobId = job.jobId;

    // In-flight guard: skip if already being processed.
    if (this.inFlight.has(jobId)) {
      this.logger.warn("watcher.skip_in_flight", { jobId });
      return null;
    }

    // Per-job lock: chain onto any existing lock for this job.
    const previous = this.locks.get(jobId);
    if (previous) {
      this.logger.warn("watcher.skip_locked", { jobId });
      return null;
    }

    this.inFlight.add(jobId);
    let resolveLock!: () => void;
    const lock = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });
    this.locks.set(jobId, lock);

    try {
      return await this.doProcess(job);
    } finally {
      this.inFlight.delete(jobId);
      this.locks.delete(jobId);
      resolveLock();
    }
  }

  private async doProcess(job: ExpiredJobRecord): Promise<RefundResult | null> {
    const jobId = job.jobId;

    // Re-verify on-chain status.
    let onChain;
    try {
      onChain = await this.commerce.getJob(jobId);
    } catch (err) {
      this.logger.error("watcher.get_job_error", { jobId, error: String(err) });
      return null;
    }

    if (!onChain || onChain.status !== "Funded") {
      this.logger.info("watcher.skip_not_funded", {
        jobId,
        status: onChain?.status ?? "missing",
      });
      return null;
    }

    // Determine action: cancel if provider never submitted, expire otherwise.
    const action: "cancel" | "expire" =
      onChain.providerSubmitted || onChain.status === "Submitted" ? "expire" : "cancel";

    try {
      const txHash = await this.keeper.refundJob({
        jobId,
        client: job.client,
        action,
      });

      const result: RefundResult = {
        jobId,
        client: job.client,
        amount: job.amount,
        txHash,
        action,
      };

      this.logger.info("watcher.refunded", {
        jobId,
        client: job.client,
        amount: job.amount,
        action,
        txHash,
      });
      this.emit("refunded", result);
      return result;
    } catch (err) {
      this.logger.error("watcher.refund_error", { jobId, error: String(err) });
      return null;
    }
  }
}

export function createWatcherFromEnv(
  commerce: CommerceClient,
  indexer: IndexerQuery,
  keeperSecret: string,
): JobExpirationWatcher {
  const pollIntervalMs = Number(process.env.WATCHER_POLL_INTERVAL_MS ?? "60000");
  const keeper = new Keeper({
    keeperKeypair: Keypair.fromSecret(keeperSecret),
    commerce,
  });
  return new JobExpirationWatcher({
    pollIntervalMs,
    keeper,
    commerce,
    indexer,
  });
}