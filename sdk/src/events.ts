import { Address, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  CommerceEvents,
  IdentityEvents,
  type AgentDeregisteredEvent,
  type IdentityEvent,
  type JobCancelledEvent,
  type JobCompletedEvent,
  type JobCreatedEvent,
  type JobDisputedEvent,
  type JobEvent,
  type JobExpiredEvent,
  type JobRefundedEvent,
  type JobSubmittedEvent,
  type OwnerTransferredEvent,
  type RegisteredEvent,
  type UriUpdatedEvent,
} from "./types.js";

/** Event response shape accepted by event decoders. */
export type EventPayload =
  | rpc.Api.RawEventResponse
  | {
      topic: unknown[];
      value: unknown;
      [key: string]: unknown;
    };

/**
 * Safely parse an unknown value into an `xdr.ScVal`.
 */
function parseScVal(val: unknown): xdr.ScVal {
  if (val instanceof xdr.ScVal) {
    return val;
  }
  if (
    typeof val === "object" &&
    val !== null &&
    "xdr" in val &&
    typeof (val as { xdr: unknown }).xdr === "string"
  ) {
    return xdr.ScVal.fromXDR((val as { xdr: string }).xdr, "base64");
  }
  if (typeof val === "string") {
    for (const enc of ["base64", "hex"] as const) {
      try {
        return xdr.ScVal.fromXDR(val, enc);
      } catch {
        /* try next encoding */
      }
    }
  }
  throw new Error("Unable to parse ScVal from input");
}

/**
 * Safely converts an ScVal, XDR string, or native value to a JavaScript native structure.
 */
function toNative(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (
    typeof val === "bigint" ||
    typeof val === "number" ||
    typeof val === "boolean"
  ) {
    return val;
  }
  if (val instanceof xdr.ScVal) {
    return scValToNative(val);
  }
  if (typeof val === "string") {
    // If it's a Stellar StrKey address, preserve it
    if (/^[GC][A-Z0-9]{55}$/.test(val)) {
      return val;
    }
    try {
      const parsed = parseScVal(val);
      return scValToNative(parsed);
    } catch {
      return val;
    }
  }
  if (
    typeof val === "object" &&
    val !== null &&
    "xdr" in val &&
    typeof (val as { xdr: unknown }).xdr === "string"
  ) {
    try {
      const parsed = parseScVal((val as { xdr: string }).xdr);
      return scValToNative(parsed);
    } catch {
      return val;
    }
  }
  return val;
}

/**
 * Extract an Address string from an ScVal, string, or object.
 */
function toAddress(val: unknown): string {
  if (typeof val === "string" && /^[GC][A-Z0-9]{55}$/.test(val)) {
    return val;
  }
  if (val instanceof xdr.ScVal) {
    try {
      return Address.fromScVal(val).toString();
    } catch {
      const native = scValToNative(val);
      return typeof native === "string" ? native : String(native);
    }
  }
  const native = toNative(val);
  if (typeof native === "string") return native;
  if (typeof native === "object" && native !== null && "address" in native) {
    return String((native as { address: unknown }).address);
  }
  return String(native);
}

/**
 * Extract a BigInt from an ScVal, string, or number.
 */
function toBigInt(val: unknown): bigint {
  if (typeof val === "bigint") return val;
  if (typeof val === "number") return BigInt(Math.trunc(val));
  if (typeof val === "string") {
    try {
      return BigInt(val);
    } catch {
      const native = toNative(val);
      return BigInt(native as string | number | bigint);
    }
  }
  const native = toNative(val);
  return BigInt(native as string | number | bigint);
}

/**
 * Extract the event symbol/topic name from topic[0].
 */
function getEventTopicName(event: EventPayload): string {
  if (!event || !Array.isArray(event.topic) || event.topic.length === 0) {
    throw new Error("Event has no topics");
  }
  const raw = event.topic[0];
  const native = toNative(raw);
  return String(native);
}

// ===========================================================================
// Agent Identity Event Decoders (#544)
// ===========================================================================

/**
 * Decode a `Registered` contract event emitted by `agent_identity`.
 *
 * @param event - The raw event response from Soroban RPC or mock event payload.
 * @returns Decoded `RegisteredEvent` with typed `owner` and `agentId`.
 */
export function decodeRegisteredEvent(event: EventPayload): RegisteredEvent {
  const topicName = getEventTopicName(event);
  if (topicName !== IdentityEvents.Registered) {
    throw new Error(
      `Expected ${IdentityEvents.Registered} event, got ${topicName}`,
    );
  }

  const owner = toAddress(event.topic[1]);
  const body = toNative(event.value);

  let agentId: bigint;
  if (Array.isArray(body)) {
    agentId = toBigInt(body[0]);
  } else if (typeof body === "object" && body !== null) {
    const obj = body as Record<string, unknown>;
    agentId = toBigInt(obj.agent_id ?? obj.agentId ?? obj.id);
  } else {
    agentId = toBigInt(body);
  }

  return {
    type: IdentityEvents.Registered,
    owner,
    agentId,
  };
}

/**
 * Decode a `UriUpdated` contract event emitted by `agent_identity`.
 *
 * @param event - The raw event response from Soroban RPC or mock event payload.
 * @returns Decoded `UriUpdatedEvent` with typed `owner` and `agentId`.
 */
export function decodeUriUpdatedEvent(event: EventPayload): UriUpdatedEvent {
  const topicName = getEventTopicName(event);
  if (topicName !== IdentityEvents.UriUpdated) {
    throw new Error(
      `Expected ${IdentityEvents.UriUpdated} event, got ${topicName}`,
    );
  }

  const owner = toAddress(event.topic[1]);
  const body = toNative(event.value);

  let agentId: bigint;
  if (Array.isArray(body)) {
    agentId = toBigInt(body[0]);
  } else if (typeof body === "object" && body !== null) {
    const obj = body as Record<string, unknown>;
    agentId = toBigInt(obj.agent_id ?? obj.agentId ?? obj.id);
  } else {
    agentId = toBigInt(body);
  }

  return {
    type: IdentityEvents.UriUpdated,
    owner,
    agentId,
  };
}

/**
 * Decode an `AgentDeregistered` contract event emitted by `agent_identity`.
 *
 * @param event - The raw event response from Soroban RPC or mock event payload.
 * @returns Decoded `AgentDeregisteredEvent` with typed `owner` and `agentId`.
 */
export function decodeAgentDeregisteredEvent(
  event: EventPayload,
): AgentDeregisteredEvent {
  const topicName = getEventTopicName(event);
  if (topicName !== IdentityEvents.AgentDeregistered) {
    throw new Error(
      `Expected ${IdentityEvents.AgentDeregistered} event, got ${topicName}`,
    );
  }

  const owner = toAddress(event.topic[1]);
  const body = toNative(event.value);

  let agentId: bigint;
  if (Array.isArray(body)) {
    agentId = toBigInt(body[0]);
  } else if (typeof body === "object" && body !== null) {
    const obj = body as Record<string, unknown>;
    agentId = toBigInt(obj.agent_id ?? obj.agentId ?? obj.id);
  } else {
    agentId = toBigInt(body);
  }

  return {
    type: IdentityEvents.AgentDeregistered,
    owner,
    agentId,
  };
}

/**
 * Decode an `OwnerTransferred` contract event emitted by `agent_identity`.
 *
 * @param event - The raw event response from Soroban RPC or mock event payload.
 * @returns Decoded `OwnerTransferredEvent` with typed `oldOwner`, `newOwner`, and `agentId`.
 */
export function decodeOwnerTransferredEvent(
  event: EventPayload,
): OwnerTransferredEvent {
  const topicName = getEventTopicName(event);
  if (topicName !== IdentityEvents.OwnerTransferred) {
    throw new Error(
      `Expected ${IdentityEvents.OwnerTransferred} event, got ${topicName}`,
    );
  }

  const oldOwner = toAddress(event.topic[1]);
  const body = toNative(event.value);

  let newOwner: string;
  let agentId: bigint;

  if (event.topic.length >= 3) {
    newOwner = toAddress(event.topic[2]);
    if (Array.isArray(body)) {
      agentId = toBigInt(body[0]);
    } else if (typeof body === "object" && body !== null) {
      const obj = body as Record<string, unknown>;
      agentId = toBigInt(obj.agent_id ?? obj.agentId ?? obj.id);
    } else {
      agentId = toBigInt(body);
    }
  } else if (Array.isArray(body)) {
    newOwner = toAddress(body[0]);
    agentId = toBigInt(body[1]);
  } else if (typeof body === "object" && body !== null) {
    const obj = body as Record<string, unknown>;
    newOwner = toAddress(obj.new_owner ?? obj.newOwner);
    agentId = toBigInt(obj.agent_id ?? obj.agentId ?? obj.id);
  } else {
    throw new Error("Unable to parse OwnerTransferred data body");
  }

  return {
    type: IdentityEvents.OwnerTransferred,
    oldOwner,
    newOwner,
    agentId,
  };
}

/**
 * Decode any `agent_identity` contract event dynamically.
 */
export function decodeIdentityEvent(event: EventPayload): IdentityEvent {
  const topicName = getEventTopicName(event);
  switch (topicName) {
    case IdentityEvents.Registered:
      return decodeRegisteredEvent(event);
    case IdentityEvents.UriUpdated:
      return decodeUriUpdatedEvent(event);
    case IdentityEvents.AgentDeregistered:
      return decodeAgentDeregisteredEvent(event);
    case IdentityEvents.OwnerTransferred:
      return decodeOwnerTransferredEvent(event);
    default:
      throw new Error(`Unknown identity event type: ${topicName}`);
  }
}

// ===========================================================================
// Agentic Commerce Event Decoders (#545)
// ===========================================================================

/**
 * Decode a `JobCreated` contract event emitted by `agentic_commerce`.
 *
 * @param event - The raw event response from Soroban RPC or mock event payload.
 * @returns Decoded `JobCreatedEvent`.
 */
export function decodeJobCreatedEvent(event: EventPayload): JobCreatedEvent {
  const topicName = getEventTopicName(event);
  if (topicName !== CommerceEvents.JobCreated) {
    throw new Error(
      `Expected ${CommerceEvents.JobCreated} event, got ${topicName}`,
    );
  }

  const client = toAddress(event.topic[1]);
  const body = toNative(event.value);

  let jobId: bigint;
  let budget: bigint;

  if (Array.isArray(body)) {
    jobId = toBigInt(body[0]);
    budget = toBigInt(body[1]);
  } else if (typeof body === "object" && body !== null) {
    const obj = body as Record<string, unknown>;
    jobId = toBigInt(obj.job_id ?? obj.jobId ?? obj.id);
    budget = toBigInt(obj.budget);
  } else {
    throw new Error("Unable to parse JobCreated data body");
  }

  return {
    type: CommerceEvents.JobCreated,
    client,
    jobId,
    budget,
  };
}

/**
 * Decode a `JobSubmitted` contract event emitted by `agentic_commerce`.
 *
 * @param event - The raw event response from Soroban RPC or mock event payload.
 * @returns Decoded `JobSubmittedEvent`.
 */
export function decodeJobSubmittedEvent(event: EventPayload): JobSubmittedEvent {
  const topicName = getEventTopicName(event);
  if (topicName !== CommerceEvents.JobSubmitted) {
    throw new Error(
      `Expected ${CommerceEvents.JobSubmitted} event, got ${topicName}`,
    );
  }

  const provider = toAddress(event.topic[1]);
  const body = toNative(event.value);

  let jobId: bigint;
  if (Array.isArray(body)) {
    jobId = toBigInt(body[0]);
  } else if (typeof body === "object" && body !== null) {
    const obj = body as Record<string, unknown>;
    jobId = toBigInt(obj.job_id ?? obj.jobId ?? obj.id);
  } else {
    jobId = toBigInt(body);
  }

  return {
    type: CommerceEvents.JobSubmitted,
    provider,
    jobId,
  };
}

/**
 * Decode a `JobCompleted` contract event emitted by `agentic_commerce`.
 *
 * @param event - The raw event response from Soroban RPC or mock event payload.
 * @returns Decoded `JobCompletedEvent`.
 */
export function decodeJobCompletedEvent(event: EventPayload): JobCompletedEvent {
  const topicName = getEventTopicName(event);
  if (topicName !== CommerceEvents.JobCompleted) {
    throw new Error(
      `Expected ${CommerceEvents.JobCompleted} event, got ${topicName}`,
    );
  }

  const evaluator = toAddress(event.topic[1]);
  const body = toNative(event.value);

  let jobId: bigint;
  let payout: bigint;
  let fee: bigint;
  let timestamp: bigint;

  if (Array.isArray(body)) {
    // If the struct includes [job_id, provider, payout, fee, timestamp] (5 items)
    if (body.length >= 5) {
      jobId = toBigInt(body[0]);
      payout = toBigInt(body[2]);
      fee = toBigInt(body[3]);
      timestamp = toBigInt(body[4]);
    } else {
      jobId = toBigInt(body[0]);
      payout = toBigInt(body[1]);
      fee = toBigInt(body[2]);
      timestamp = toBigInt(body[3]);
    }
  } else if (typeof body === "object" && body !== null) {
    const obj = body as Record<string, unknown>;
    jobId = toBigInt(obj.job_id ?? obj.jobId ?? obj.id);
    payout = toBigInt(obj.payout);
    fee = toBigInt(obj.fee);
    timestamp = toBigInt(obj.timestamp);
  } else {
    throw new Error("Unable to parse JobCompleted data body");
  }

  return {
    type: CommerceEvents.JobCompleted,
    evaluator,
    jobId,
    payout,
    fee,
    timestamp,
  };
}

/**
 * Decode a `JobCancelled` contract event emitted by `agentic_commerce`.
 *
 * @param event - The raw event response from Soroban RPC or mock event payload.
 * @returns Decoded `JobCancelledEvent`.
 */
export function decodeJobCancelledEvent(event: EventPayload): JobCancelledEvent {
  const topicName = getEventTopicName(event);
  if (topicName !== CommerceEvents.JobCancelled) {
    throw new Error(
      `Expected ${CommerceEvents.JobCancelled} event, got ${topicName}`,
    );
  }

  const client = toAddress(event.topic[1]);
  const body = toNative(event.value);

  let jobId: bigint;
  if (Array.isArray(body)) {
    jobId = toBigInt(body[0]);
  } else if (typeof body === "object" && body !== null) {
    const obj = body as Record<string, unknown>;
    jobId = toBigInt(obj.job_id ?? obj.jobId ?? obj.id);
  } else {
    jobId = toBigInt(body);
  }

  return {
    type: CommerceEvents.JobCancelled,
    client,
    jobId,
  };
}

/**
 * Decode a `JobDisputed` contract event emitted by `agentic_commerce`.
 *
 * @param event - The raw event response from Soroban RPC or mock event payload.
 * @returns Decoded `JobDisputedEvent`.
 */
export function decodeJobDisputedEvent(event: EventPayload): JobDisputedEvent {
  const topicName = getEventTopicName(event);
  if (topicName !== CommerceEvents.JobDisputed) {
    throw new Error(
      `Expected ${CommerceEvents.JobDisputed} event, got ${topicName}`,
    );
  }

  const client = toAddress(event.topic[1]);
  const body = toNative(event.value);

  let jobId: bigint;
  let timestamp: bigint;

  if (Array.isArray(body)) {
    jobId = toBigInt(body[0]);
    timestamp = toBigInt(body[1]);
  } else if (typeof body === "object" && body !== null) {
    const obj = body as Record<string, unknown>;
    jobId = toBigInt(obj.job_id ?? obj.jobId ?? obj.id);
    timestamp = toBigInt(obj.timestamp);
  } else {
    throw new Error("Unable to parse JobDisputed data body");
  }

  return {
    type: CommerceEvents.JobDisputed,
    client,
    jobId,
    timestamp,
  };
}

/**
 * Decode a `JobRefunded` contract event emitted by `agentic_commerce`.
 *
 * @param event - The raw event response from Soroban RPC or mock event payload.
 * @returns Decoded `JobRefundedEvent`.
 */
export function decodeJobRefundedEvent(event: EventPayload): JobRefundedEvent {
  const topicName = getEventTopicName(event);
  if (topicName !== CommerceEvents.JobRefunded) {
    throw new Error(
      `Expected ${CommerceEvents.JobRefunded} event, got ${topicName}`,
    );
  }

  const client = toAddress(event.topic[1]);
  const body = toNative(event.value);

  let jobId: bigint;
  if (Array.isArray(body)) {
    jobId = toBigInt(body[0]);
  } else if (typeof body === "object" && body !== null) {
    const obj = body as Record<string, unknown>;
    jobId = toBigInt(obj.job_id ?? obj.jobId ?? obj.id);
  } else {
    jobId = toBigInt(body);
  }

  return {
    type: CommerceEvents.JobRefunded,
    client,
    jobId,
  };
}

/**
 * Decode a `JobExpired` contract event emitted by `agentic_commerce`.
 *
 * @param event - The raw event response from Soroban RPC or mock event payload.
 * @returns Decoded `JobExpiredEvent`.
 */
export function decodeJobExpiredEvent(event: EventPayload): JobExpiredEvent {
  const topicName = getEventTopicName(event);
  if (topicName !== CommerceEvents.JobExpired) {
    throw new Error(
      `Expected ${CommerceEvents.JobExpired} event, got ${topicName}`,
    );
  }

  const provider = toAddress(event.topic[1]);
  const body = toNative(event.value);

  let jobId: bigint;
  let payout: bigint;
  let fee: bigint;
  let timestamp: bigint;

  if (Array.isArray(body)) {
    jobId = toBigInt(body[0]);
    payout = toBigInt(body[1]);
    fee = toBigInt(body[2]);
    timestamp = toBigInt(body[3]);
  } else if (typeof body === "object" && body !== null) {
    const obj = body as Record<string, unknown>;
    jobId = toBigInt(obj.job_id ?? obj.jobId ?? obj.id);
    payout = toBigInt(obj.payout);
    fee = toBigInt(obj.fee);
    timestamp = toBigInt(obj.timestamp);
  } else {
    throw new Error("Unable to parse JobExpired data body");
  }

  return {
    type: CommerceEvents.JobExpired,
    provider,
    jobId,
    payout,
    fee,
    timestamp,
  };
}

/**
 * Decode any `agentic_commerce` contract event dynamically based on topic[0].
 */
export function decodeCommerceEvent(event: EventPayload): JobEvent {
  const topicName = getEventTopicName(event);
  switch (topicName) {
    case CommerceEvents.JobCreated:
      return decodeJobCreatedEvent(event);
    case CommerceEvents.JobSubmitted:
      return decodeJobSubmittedEvent(event);
    case CommerceEvents.JobCompleted:
      return decodeJobCompletedEvent(event);
    case CommerceEvents.JobCancelled:
      return decodeJobCancelledEvent(event);
    case CommerceEvents.JobDisputed:
      return decodeJobDisputedEvent(event);
    case CommerceEvents.JobRefunded:
      return decodeJobRefundedEvent(event);
    case CommerceEvents.JobExpired:
      return decodeJobExpiredEvent(event);
    default:
      throw new Error(`Unknown commerce event type: ${topicName}`);
  }
}
