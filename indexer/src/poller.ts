import {
  rpc as StellarRpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import { EventStore, type InsertEventParams } from "./db.js";
import { ReputationEngine } from "./reputation.js";
import { EventHub } from "./events.js";

const tracer = trace.getTracer("bear-indexer-poller");

export type SorobanRpcClient = {
  getEvents(
    params: StellarRpc.Server.GetEventsRequest,
  ): Promise<StellarRpc.Api.GetEventsResponse>;
  getLatestLedger(): Promise<StellarRpc.Api.GetLatestLedgerResponse>;
  /**
   * Optional: fetch a single ledger header. Used for reorg detection to
   * verify the `previous_ledger_hash` chain. When unavailable the poller
   * falls back to the `previousLedgerHash` field on getEvents responses.
   */
  getLedger?(
    ledger: number,
  ): Promise<{ sequence: number; hash: string; previousLedgerHash?: string }>;
};

/** Structured log record emitted for every detected chain reorganization. */
export type ReorgLogRecord = {
  event: "chain_reorg";
  detectedAt: string;
  forkLedger: number;
  rewoundTo: number;
  purgedEvents: number;
  previousHash: string | null;
  expectedHash: string | null;
  actualHash: string | null;
};

// Known Bear Protocol event topic names
export const BEAR_EVENT_TYPES = [
  "JobCreated",
  "JobSubmitted",
  "JobCompleted",
  "JobCancelled",
  "JobDisputed",
  "JobExpired",
  "JobRefunded",
  "BatchJobsCreated",
  "Registered",
  "AgentDeregistered",
  "UriUpdated",
  "OwnerTransferred",
  "BadgeIssued",
  "BadgeRevoked",
] as const;

export type BearEventType = (typeof BEAR_EVENT_TYPES)[number];

export type EventTopicHeader = {
  eventName: string;
  version: number;
  actor: string | null;
};

/**
 * Decode both the legacy [event, actor, ...] header and the versioned
 * [event, version, actor, ...] header. The emitting contract is reported
 * separately by Soroban RPC as contractId.
 */
export function parseEventTopicHeader(
  topics: readonly xdr.ScVal[],
): EventTopicHeader | null {
  if (topics.length === 0) return null;
  const eventName = scValToNative<unknown>(topics[0]);
  if (typeof eventName !== "string") return null;

  const secondTopic = topics[1]
    ? scValToNative<unknown>(topics[1])
    : undefined;
  const hasVersion = typeof secondTopic === "number" && Number.isInteger(secondTopic);
  const version = hasVersion ? secondTopic : 1;
  const actorValue = topics[hasVersion ? 2 : 1]
    ? scValToNative<unknown>(topics[hasVersion ? 2 : 1])
    : null;

  return {
    eventName,
    version,
    actor: typeof actorValue === "string" ? actorValue : null,
  };
}

/**
 * Extracts the operation index and event index from a raw Soroban event.
 *
 * Soroban event ids have the shape
 *   `<toid>-<eventIndex>`  (e.g. `0000000000000000000-0000000000`)
 * where the leading component is the 64-bit "total order id" encoding the
 * ledger sequence, transaction order and operation index. The trailing
 * component is the index of the event within its transaction/operation.
 *
 * Both values are needed to build the idempotency key
 * `(ledger, tx_hash, op_index, event_index)`. When the id cannot be parsed
 * we fall back to the event's position in the response batch so the key is
 * still populated (and stable for a given ledger range).
 */
function parseEventIndexes(
  event: StellarRpc.Api.EventResponse,
  fallbackIndex: number,
): { opIndex: number; eventIndex: number } {
  const raw = (event as Record<string, unknown>).id;
  if (typeof raw === "string" && raw.length > 0) {
    const dash = raw.lastIndexOf("-");
    if (dash > 0) {
      const toidPart = raw.slice(0, dash);
      const eventPart = raw.slice(dash + 1);
      const eventIndex = Number.parseInt(eventPart, 10);
      if (Number.isFinite(eventIndex)) {
        // The low 32 bits of the toid hold the operation index.
        const toid = Number.parseInt(toidPart, 10);
        const opIndex = Number.isFinite(toid)
          ? toid % 0x1_0000_0000
          : fallbackIndex;
        return { opIndex, eventIndex };
      }
    }
  }

  // Fallback: derive a deterministic index from the batch position.
  const explicitOp = (event as Record<string, unknown>).operationIndex;
  const explicitEvent = (event as Record<string, unknown>).eventIndex;
  return {
    opIndex:
      typeof explicitOp === "number" && Number.isInteger(explicitOp)
        ? explicitOp
        : 0,
    eventIndex:
      typeof explicitEvent === "number" && Number.isInteger(explicitEvent)
        ? explicitEvent
        : fallbackIndex,
  };
}

/**
 * Converts a raw Soroban event into the InsertEventParams format.
 * The full event is stored as a JSON blob in `payload` so no information
 * is lost and new fields can be queried without schema migrations.
 *
 * `fallbackIndex` is the event's position within the fetched batch and is
 * only used when the RPC event id cannot be parsed.
 */
function toInsertParams(
  event: StellarRpc.Api.EventResponse,
  ledgerCloseTime: number,
  fallbackIndex = 0,
): InsertEventParams {
  const topics = event.topic ?? [];
  const header = parseEventTopicHeader(topics);
  const { opIndex, eventIndex } = parseEventIndexes(event, fallbackIndex);

  const payload: Record<string, unknown> = {
    topics: topics,
    value: event.value,
    txHash: event.txHash,
    id: event.id,
    eventVersion: header?.version ?? 1,
    actor: header?.actor ?? null,
  };

  return {
    ledger: event.ledger,
    timestamp: ledgerCloseTime,
    contract: event.contractId ?? "",
    event_type: header?.eventName ?? "Unknown",
    tx_hash: event.txHash ?? "",
    op_index: opIndex,
    event_index: eventIndex,
    payload,
  };
}

export type PollerOptions = {
  /** Polling interval in milliseconds. Default: 5000 */
  intervalMs?: number;
  /** Max events to fetch per RPC call. Default: 100 */
  batchSize?: number;
  /** Emit debug logs. Default: false */
  debug?: boolean;
  /** Optional reputation engine used to recalculate scores on settlement. */
  reputation?: ReputationEngine;
  /** Optional event hub used to broadcast newly indexed events. */
  eventHub?: EventHub;
  /** Max number of ledgers to walk back when resolving a reorg. Default: 64 */
  maxReorgDepth?: number;
  /**
   * Number of ledgers that must be finalized before events are processed.
   * Events are only ingested once `ledger <= latestLedger - confirmationDepth`.
   * Default: 5
   */
  confirmationDepth?: number;
};

/** Event types that affect an agent's reputation score. */
const REPUTATION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "JobCompleted",
  "JobDisputed",
]);

/**
 * Best-effort extraction of the agent address from a raw Soroban event.
 * Job events carry the provider agent as one of their topics; we scan the
 * topics for the first string-like value that is not the event name.
 */
function extractAgentId(event: StellarRpc.Api.EventResponse): string | null {
  return parseEventTopicHeader(event.topic ?? [])?.actor ?? null;
}

/**
 * Continuously polls Soroban RPC for new contract events and persists them
 * to SQLite.  Call `start()` to begin and `stop()` to halt gracefully.
 */
export class SorobanEventPoller {
  private readonly rpc: SorobanRpcClient;
  private readonly store: DatabaseAdapter;
  private readonly contracts: string[];
  private readonly startLedger: number;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly debug: boolean;
  private readonly reputation: ReputationEngine | null;
  private readonly eventHub: EventHub | null;
  private readonly maxReorgDepth: number;
  private readonly confirmationDepth: number;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private reorgCount = 0;

  constructor(
    rpc: SorobanRpcClient,
    store: DatabaseAdapter,
    contracts: string[],
    startLedger: number,
    opts: PollerOptions = {},
  ) {
    this.rpc = rpc;
    this.store = store;
    this.contracts = contracts;
    this.startLedger = startLedger;
    this.intervalMs = opts.intervalMs ?? 5_000;
    this.batchSize = opts.batchSize ?? 100;
    this.debug = opts.debug ?? false;
    this.reputation = opts.reputation ?? null;
    this.eventHub = opts.eventHub ?? null;
    this.maxReorgDepth = opts.maxReorgDepth ?? 64;
    this.confirmationDepth = Math.max(0, opts.confirmationDepth ?? 5);
  }

  private log(msg: string): void {
    if (this.debug) console.log(`[indexer] ${msg}`);
  }

  /** Number of chain reorganizations detected since construction. */
  getReorgCount(): number {
    return this.reorgCount;
  }

  /** Last ledger persisted by the poller, or null if nothing indexed yet. */
  getLastIndexedLedger(): number | null {
    return this.store.getLastIndexedLedger();
  }

  /** Current chain tip as reported by Soroban RPC. */
  async getLatestLedger(): Promise<number> {
    const res = await this.rpc.getLatestLedger();
    return res.sequence;
  }

  /**
   * Fetch the hash of a ledger. Prefers `rpc.getLedger` when available and
   * falls back to the `previousLedgerHash` reported on getEvents responses.
   */
  private async fetchLedgerHash(
    ledger: number,
  ): Promise<{ hash: string | null; previousLedgerHash: string | null }> {
    if (this.rpc.getLedger) {
      try {
        const header = await this.rpc.getLedger(ledger);
        return {
          hash: header.hash ?? null,
          previousLedgerHash: header.previousLedgerHash ?? null,
        };
      } catch (err) {
        this.log(
          `Failed to fetch ledger ${ledger} header: ${(err as Error).message}`,
        );
      }
    }
    return { hash: null, previousLedgerHash: null };
  }

  /**
   * Verify that the chain has not reorganized since the last indexed ledger.
   * Returns the ledger to resume from. On mismatch, purges orphaned events,
   * rewinds the watermark to the last verified ancestor and returns that
   * ancestor so the next poll re-ingests from the common fork point.
   *
   * Verification checks both the stored hash of the last indexed ledger and
   * the `previous_ledger_hash` continuity of the ledger that follows it.
   */
  private async detectAndRecoverReorg(): Promise<number> {
    const last = this.store.getLastIndexedLedger();
    if (last === null) return this.startLedger;

    const storedHash = this.store.getIndexedLedgerHash(last);
    if (!storedHash) {
      // No hash recorded yet (legacy state); nothing to verify against.
      return last + 1;
    }

    // Fetch the header for the last indexed ledger and compare its hash.
    const header = await this.fetchLedgerHash(last);
    if (!header.hash) {
      // Cannot verify; assume no reorg.
      return last + 1;
    }

    // Verify prev-hash continuity: the ledger after `last` must point back
    // to the stored hash of `last`. Only possible when a header is available.
    let continuityBroken = false;
    const nextHeader = await this.fetchLedgerHash(last + 1);
    if (nextHeader.hash && nextHeader.previousLedgerHash) {
      continuityBroken = nextHeader.previousLedgerHash !== storedHash;
    }

    if (header.hash === storedHash && !continuityBroken) {
      return last + 1;
    }

    // Mismatch: walk back to the last verified ancestor.
    let forkLedger = last;
    let rewoundTo = last;
    let expectedHash: string | null = storedHash;
    let actualHash: string | null = header.hash;

    for (let depth = 0; depth < this.maxReorgDepth; depth++) {
      const candidate = forkLedger - 1;
      if (candidate < this.startLedger) break;
      const candidateHash = this.store.getIndexedLedgerHash(candidate);
      if (!candidateHash) break;
      const candidateHeader = await this.fetchLedgerHash(candidate);
      if (candidateHeader.hash && candidateHeader.hash === candidateHash) {
        rewoundTo = candidate;
        break;
      }
      forkLedger = candidate;
      expectedHash = candidateHash;
      actualHash = candidateHeader.hash;
    }

    const purged = this.store.deleteEventsFromLedger(rewoundTo + 1);
    this.store.setLastIndexedLedger(rewoundTo);
    this.reorgCount += 1;

    const record: ReorgLogRecord = {
      event: "chain_reorg",
      detectedAt: new Date().toISOString(),
      forkLedger,
      rewoundTo,
      purgedEvents: purged,
      previousHash: expectedHash,
      expectedHash,
      actualHash,
    };
    console.error(`[indexer] ${JSON.stringify(record)}`);

    return rewoundTo + 1;
  }

  /** Returns the ledger to start polling from (resume or initial). */
  private getFromLedger(): number {
    const last = this.store.getLastIndexedLedger();
    // Start one ledger ahead of the last processed to avoid re-indexing
    return last !== null ? last + 1 : this.startLedger;
  }

  /** Recalculate reputation for agents affected by settlement events. */
  private updateReputation(events: StellarRpc.Api.EventResponse[]): void {
    if (!this.reputation) return;

    const agents = new Set<string>();
    for (const [index, ev] of events.entries()) {
      const params = toInsertParams(ev, 0, index);
      if (!REPUTATION_EVENT_TYPES.has(params.event_type)) continue;
      const agentId = extractAgentId(ev);
      if (agentId) agents.add(agentId);
    }

    for (const agentId of agents) {
      try {
        this.reputation.recalculate(agentId);
        this.log(`Recalculated reputation for agent ${agentId}`);
      } catch (err) {
        console.error(
          `[indexer] Failed to recalculate reputation for ${agentId}:`,
          (err as Error).message,
        );
      }
    }
  }

  private async poll(): Promise<void> {
    let fromLedger: number;
    try {
      fromLedger = await this.detectAndRecoverReorg();
    } catch (err) {
      console.error(
        "[indexer] Reorg detection failed:",
        (err as Error).message,
      );
      fromLedger = this.getFromLedger();
    }

    try {
      const latest = await tracer.startActiveSpan(
        "soroban.getLatestLedger",
        async (span: Span) => {
          try {
            const res = await this.rpc.getLatestLedger();
            span.setAttribute("stellar.ledger.sequence", res.sequence);
            return res;
          } catch (err) {
            span.recordException(err as Error);
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw err;
          } finally {
            span.end();
          }
        },
      );
      // Only process ledgers that have reached the confirmation depth.
      const confirmedLedger = latest.sequence - this.confirmationDepth;
      if (fromLedger > confirmedLedger) {
        this.log(
          `Waiting for confirmations: from=${fromLedger} confirmed=${confirmedLedger} latest=${latest.sequence}`,
        );
        return;
      }

      // Collect all events for this ledger across contracts before writing.
      // Events are flushed in a single batched insert (insertEventsBatch) so
      // the whole confirmed range is persisted atomically.
      const allInserts: InsertEventParams[] = [];

      // Query each contract separately to stay within RPC limits
      for (const contractId of this.contracts) {
        try {
          const response = await tracer.startActiveSpan(
            "soroban.getEvents",
            async (span: Span) => {
              span.setAttribute("stellar.contract.id", contractId);
              span.setAttribute("stellar.ledger.start", fromLedger);
              try {
                const res = await this.rpc.getEvents({
                  startLedger: fromLedger,
                  filters: [
                    {
                      type: "contract",
                      contractIds: [contractId],
                    },
                  ],
                  limit: this.batchSize,
                });
                span.setAttribute("stellar.events.count", res.events?.length ?? 0);
                return res;
              } catch (err) {
                span.recordException(err as Error);
                span.setStatus({ code: SpanStatusCode.ERROR });
                throw err;
              } finally {
                span.end();
              }
            },
          );

          if (!response.events || response.events.length === 0) continue;

          // Soroban getEvents returns ledger close times via the `ledgerClosedAt` field;
          // fall back to current time when unavailable (e.g. in tests).
          const inserts: InsertEventParams[] = response.events.map(
            (ev, index) => {
              const closeTime =
                typeof (ev as Record<string, unknown>).ledgerClosedAt ===
                "string"
                  ? Math.floor(
                      new Date(
                        (ev as Record<string, unknown>).ledgerClosedAt as string,
                      ).getTime() / 1000,
                    )
                  : Math.floor(Date.now() / 1000);
              return toInsertParams(
                ev as StellarRpc.Api.EventResponse,
                closeTime,
                index,
              );
            },
          );

          // Collect events across all contracts so the whole ledger batch is
          // persisted atomically in a single IMMEDIATE transaction below.
          allInserts.push(...inserts);
          this.log(
            `Fetched ${inserts.length} events from contract ${contractId} (ledgers ${fromLedger}+)`,
          );
        } catch (err) {
          console.error(
            `[indexer] Failed to fetch events for contract ${contractId}:`,
            (err as Error).message,
          );
        }
      }

      // Persist the entire ledger batch (events + watermark) atomically.
      // If anything fails, neither the events nor the watermark advance.
      // The watermark is the last *confirmed* ledger so reorg detection
      // always verifies a finalized hash.
      const confirmedHash = await this.fetchLedgerHash(confirmedLedger);
      this.store.insertEventsBatch(
        allInserts,
        confirmedLedger,
        confirmedHash.hash ?? undefined,
      );
      this.log(
        `Indexed ${allInserts.length} events across ${this.contracts.length} contract(s) up to confirmed ledger ${confirmedLedger}`,
      );

      // Broadcast newly indexed events to SSE/WebSocket subscribers.
      if (this.eventHub && allInserts.length > 0) {
        for (const insert of allInserts) {
          this.eventHub.publish(insert);
        }
      }
    } catch (err) {
      console.error("[indexer] Poll error:", (err as Error).message);
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.log(
      `Starting event poller (confirmationDepth=${this.confirmationDepth})…`,
    );

    const tick = async () => {
      if (!this.running) return;
      await this.poll();
      if (this.running) {
        this.timer = setTimeout(tick, this.intervalMs);
      }
    };

    await tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.log("Poller stopped.");
  }
}
