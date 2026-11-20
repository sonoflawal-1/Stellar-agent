import { EventEmitter } from "events";

/**
 * A Soroban contract event as stored/streamed by the indexer.
 * Fields are intentionally loose to accommodate the various shapes
 * produced by the poller and db layer.
 */
export interface SorobanEvent {
  /** Monotonic event id (used for SSE Last-Event-ID resume). */
  id?: number | string;
  /** Contract id the event was emitted from. */
  contract?: string;
  contract_id?: string;
  /** Event type, e.g. "contract", "system", "diagnostic", or a topic symbol. */
  event_type?: string;
  type?: string;
  /** Ledger sequence number. */
  ledger?: number;
  ledger_sequence?: number;
  /** Transaction hash the event was emitted in. */
  tx_hash?: string;
  txHash?: string;
  /** Index of the operation within the transaction. */
  op_index?: number;
  opIndex?: number;
  /** Index of the event within the operation. */
  event_index?: number;
  eventIndex?: number;
  /** Addresses / topics associated with the event. */
  address?: string;
  addresses?: string[];
  topics?: unknown[];
  /** Raw event payload. */
  value?: unknown;
  data?: unknown;
  /** Any additional fields. */
  [key: string]: unknown;
}

/**
 * Filter used to select which events a subscriber receives.
 * All provided fields must match (logical AND). Address matching is
 * performed against the event's address, addresses, and topics.
 */
export interface EventFilter {
  contract?: string;
  event_type?: string;
  address?: string;
}

export type EventListener = (event: SorobanEvent) => void;

export interface Subscription {
  filter: EventFilter;
  listener: EventListener;
}

/** SSE frame serialized for transmission over an SSE stream. */
export interface SseFrame {
  id?: string;
  event?: string;
  data: string;
  retry?: number;
}

/** WebSocket message envelope. */
export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

const DEFAULT_EVENT_NAME = "message";

/**
 * Extract the contract id from an event, tolerating both `contract`
 * and `contract_id` field names.
 */
function getContract(event: SorobanEvent): string | undefined {
  const value = event.contract ?? event.contract_id;
  return typeof value === "string" ? value : undefined;
}

/**
 * Extract the event type from an event, tolerating both `event_type`
 * and `type` field names.
 */
function getEventType(event: SorobanEvent): string | undefined {
  const value = event.event_type ?? event.type;
  return typeof value === "string" ? value : undefined;
}

/**
 * Collect all address-like strings associated with an event: the
 * `address` field, the `addresses` array, and any string entries in
 * `topics`.
 */
function getAddresses(event: SorobanEvent): string[] {
  const result: string[] = [];

  if (typeof event.address === "string") {
    result.push(event.address);
  }

  if (Array.isArray(event.addresses)) {
    for (const addr of event.addresses) {
      if (typeof addr === "string") {
        result.push(addr);
      }
    }
  }

  if (Array.isArray(event.topics)) {
    for (const topic of event.topics) {
      if (typeof topic === "string") {
        result.push(topic);
      } else if (topic && typeof topic === "object") {
        // Topics may be wrapped, e.g. { address: "G..." } or { value: "..." }.
        const obj = topic as Record<string, unknown>;
        if (typeof obj.address === "string") {
          result.push(obj.address);
        } else if (typeof obj.value === "string") {
          result.push(obj.value);
        }
      }
    }
  }

  return result;
}

/**
 * Extract the ledger sequence from an event, tolerating both `ledger`
 * and `ledger_sequence` field names.
 */
export function getLedger(event: SorobanEvent): number | undefined {
  const value = event.ledger ?? event.ledger_sequence;
  return typeof value === "number" ? value : undefined;
}

/**
 * Extract the transaction hash from an event, tolerating both `tx_hash`
 * and `txHash` field names.
 */
export function getTxHash(event: SorobanEvent): string | undefined {
  const value = event.tx_hash ?? event.txHash;
  return typeof value === "string" ? value : undefined;
}

/**
 * Extract the operation index from an event, tolerating both `op_index`
 * and `opIndex` field names.
 */
export function getOpIndex(event: SorobanEvent): number | undefined {
  const value = event.op_index ?? event.opIndex;
  return typeof value === "number" ? value : undefined;
}

/**
 * Extract the event index from an event, tolerating both `event_index`
 * and `eventIndex` field names.
 */
export function getEventIndex(event: SorobanEvent): number | undefined {
  const value = event.event_index ?? event.eventIndex;
  return typeof value === "number" ? value : undefined;
}

/**
 * Compute the idempotency key for an event: (ledger, tx hash, op index,
 * event index). Returns `undefined` when any component is missing, in
 * which case the event cannot be deduplicated by key.
 */
export function getEventKey(
  event: SorobanEvent
): { ledger: number; txHash: string; opIndex: number; eventIndex: number } | undefined {
  const ledger = getLedger(event);
  const txHash = getTxHash(event);
  const opIndex = getOpIndex(event);
  const eventIndex = getEventIndex(event);
  if (
    ledger === undefined ||
    txHash === undefined ||
    opIndex === undefined ||
    eventIndex === undefined
  ) {
    return undefined;
  }
  return { ledger, txHash, opIndex, eventIndex };
}

/**
 * Determine whether an event matches a filter. An empty filter matches
 * everything.
 */
export function matchesFilter(event: SorobanEvent, filter: EventFilter): boolean {
  if (filter.contract !== undefined) {
    if (getContract(event) !== filter.contract) {
      return false;
    }
  }

  if (filter.event_type !== undefined) {
    if (getEventType(event) !== filter.event_type) {
      return false;
    }
  }

  if (filter.address !== undefined) {
    const addresses = getAddresses(event);
    if (!addresses.includes(filter.address)) {
      return false;
    }
  }

  return true;
}

/**
 * Normalize a filter, dropping undefined/empty values.
 */
export function normalizeFilter(filter?: EventFilter | null): EventFilter {
  const normalized: EventFilter = {};
  if (!filter) {
    return normalized;
  }
  if (typeof filter.contract === "string" && filter.contract.length > 0) {
    normalized.contract = filter.contract;
  }
  if (typeof filter.event_type === "string" && filter.event_type.length > 0) {
    normalized.event_type = filter.event_type;
  }
  if (typeof filter.address === "string" && filter.address.length > 0) {
    normalized.address = filter.address;
  }
  return normalized;
}

/**
 * EventHub is a lightweight pub/sub broker for Soroban events.
 *
 * Subscribers register a filter and a listener; `publish` fans out each
 * event to every subscriber whose filter matches. Subscriptions are
 * tracked so they can be cleanly removed (avoiding listener leaks).
 */
export class EventHub {
  private readonly emitter: EventEmitter;
  private readonly subscriptions: Set<Subscription>;
  private readonly maxListeners: number;
  /** Keys of events already published, used to drop duplicate ingestion. */
  private readonly seenKeys: Set<string>;

  constructor(maxListeners = 0) {
    this.emitter = new EventEmitter();
    this.subscriptions = new Set();
    this.maxListeners = maxListeners;
    this.seenKeys = new Set();
    // 0 means unlimited; useful for many concurrent SSE subscribers.
    this.emitter.setMaxListeners(maxListeners);
  }

  /**
   * Subscribe to events matching `filter`. Returns an unsubscribe
   * function that removes the subscription.
   */
  subscribe(filter: EventFilter | undefined, listener: EventListener): () => void {
    const subscription: Subscription = {
      filter: normalizeFilter(filter),
      listener,
    };

    this.subscriptions.add(subscription);

    const wrapped: EventListener = (event: SorobanEvent) => {
      if (matchesFilter(event, subscription.filter)) {
        listener(event);
      }
    };

    // Store the wrapped listener on the subscription for removal.
    (subscription as Subscription & { wrapped?: EventListener }).wrapped = wrapped;
    this.emitter.on("event", wrapped);

    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      this.subscriptions.delete(subscription);
      this.emitter.removeListener("event", wrapped);
    };
  }

  /**
   * Publish an event to all matching subscribers. Returns the number of
   * subscribers that received the event.
   *
   * Events carrying a complete idempotency key (ledger, tx hash, op
   * index, event index) are deduplicated: re-publishing the same event
   * is a no-op and returns 0.
   */
  publish(event: SorobanEvent): number {
    const key = getEventKey(event);
    if (key) {
      const serialized = `${key.ledger}:${key.txHash}:${key.opIndex}:${key.eventIndex}`;
      if (this.seenKeys.has(serialized)) {
        return 0;
      }
      this.seenKeys.add(serialized);
    }

    let delivered = 0;
    for (const subscription of this.subscriptions) {
      if (matchesFilter(event, subscription.filter)) {
        delivered += 1;
      }
    }
    this.emitter.emit("event", event);
    return delivered;
  }

  /** Number of active subscriptions. */
  get subscriberCount(): number {
    return this.subscriptions.size;
  }

  /** Remove all subscriptions. */
  clear(): void {
    for (const subscription of this.subscriptions) {
      const wrapped = (subscription as Subscription & { wrapped?: EventListener }).wrapped;
      if (wrapped) {
        this.emitter.removeListener("event", wrapped);
      }
    }
    this.subscriptions.clear();
    this.seenKeys.clear();
    this.emitter.removeAllListeners("event");
  }
}

/**
 * Serialize an event into an SSE frame. The frame id is derived from the
 * event id (when present) so clients can resume via Last-Event-ID.
 */
export function serializeSse(event: SorobanEvent, eventName?: string): SseFrame {
  const id =
    event.id !== undefined && event.id !== null ? String(event.id) : undefined;
  const name = eventName ?? getEventType(event) ?? DEFAULT_EVENT_NAME;
  return {
    id,
    event: name,
    data: JSON.stringify(event),
  };
}

/**
 * Format an SSE frame into the wire format expected by EventSource.
 */
export function formatSseFrame(frame: SseFrame): string {
  let out = "";
  if (frame.id !== undefined) {
    out += `id: ${frame.id}\n`;
  }
  if (frame.event !== undefined) {
    out += `event: ${frame.event}\n`;
  }
  if (frame.retry !== undefined) {
    out += `retry: ${frame.retry}\n`;
  }
  // Data may contain newlines; each line must be prefixed with "data: ".
  const lines = frame.data.split("\n");
  for (const line of lines) {
    out += `data: ${line}\n`;
  }
  out += "\n";
  return out;
}

/**
 * Serialize an event into a WebSocket message envelope.
 */
export function serializeWs(event: SorobanEvent, type = "event"): WsMessage {
  return {
    type,
    id: event.id,
    event,
  };
}

/**
 * Serialize a heartbeat ping for SSE (as a comment line) or WebSocket.
 */
export function sseHeartbeat(): string {
  return `: ping ${Date.now()}\n\n`;
}

export function wsHeartbeat(): WsMessage {
  return { type: "ping", timestamp: Date.now() };
}

/**
 * Singleton hub shared by the poller and HTTP/WebSocket servers.
 */
export const eventHub = new EventHub();

export default eventHub;
</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>