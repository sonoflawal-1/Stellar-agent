import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Address, Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import {
  BearEvent,
  CommerceEvents,
  IdentityEvents,
  assertNever,
  decodeAgentDeregisteredEvent,
  decodeCommerceEvent,
  decodeIdentityEvent,
  decodeJobCancelledEvent,
  decodeJobCompletedEvent,
  decodeJobCreatedEvent,
  decodeJobDisputedEvent,
  decodeJobExpiredEvent,
  decodeJobRefundedEvent,
  decodeJobSubmittedEvent,
  decodeOwnerTransferredEvent,
  decodeRegisteredEvent,
  decodeUriUpdatedEvent,
} from "./index.js";

test("decodeRegisteredEvent decodes valid Registered event", () => {
  const owner = Keypair.random().publicKey();
  const mockEvent = {
    topic: [
      nativeToScVal(IdentityEvents.Registered, { type: "symbol" }),
      new Address(owner).toScVal(),
    ],
    value: nativeToScVal(123n),
  };

  const decoded = decodeRegisteredEvent(mockEvent);
  assert.equal(decoded.type, IdentityEvents.Registered);
  assert.equal(decoded.owner, owner);
  assert.equal(decoded.agentId, 123n);

  const generic = decodeIdentityEvent(mockEvent);
  assert.equal(generic.type, IdentityEvents.Registered);
});

test("decodeUriUpdatedEvent decodes valid UriUpdated event", () => {
  const owner = Keypair.random().publicKey();
  const mockEvent = {
    topic: [
      nativeToScVal(IdentityEvents.UriUpdated, { type: "symbol" }),
      new Address(owner).toScVal(),
    ],
    value: nativeToScVal(456n),
  };

  const decoded = decodeUriUpdatedEvent(mockEvent);
  assert.equal(decoded.type, IdentityEvents.UriUpdated);
  assert.equal(decoded.owner, owner);
  assert.equal(decoded.agentId, 456n);
});

test("decodeAgentDeregisteredEvent decodes valid AgentDeregistered event", () => {
  const owner = Keypair.random().publicKey();
  const mockEvent = {
    topic: [
      nativeToScVal(IdentityEvents.AgentDeregistered, { type: "symbol" }),
      new Address(owner).toScVal(),
    ],
    value: nativeToScVal(789n),
  };

  const decoded = decodeAgentDeregisteredEvent(mockEvent);
  assert.equal(decoded.type, IdentityEvents.AgentDeregistered);
  assert.equal(decoded.owner, owner);
  assert.equal(decoded.agentId, 789n);
});

test("decodeOwnerTransferredEvent decodes valid OwnerTransferred event (2 topics + array body)", () => {
  const oldOwner = Keypair.random().publicKey();
  const newOwner = Keypair.random().publicKey();
  const mockEvent = {
    topic: [
      nativeToScVal(IdentityEvents.OwnerTransferred, { type: "symbol" }),
      new Address(oldOwner).toScVal(),
    ],
    value: [newOwner, 100n],
  };

  const decoded = decodeOwnerTransferredEvent(mockEvent);
  assert.equal(decoded.type, IdentityEvents.OwnerTransferred);
  assert.equal(decoded.oldOwner, oldOwner);
  assert.equal(decoded.newOwner, newOwner);
  assert.equal(decoded.agentId, 100n);
});

test("decodeOwnerTransferredEvent decodes valid OwnerTransferred event (3 topics)", () => {
  const oldOwner = Keypair.random().publicKey();
  const newOwner = Keypair.random().publicKey();
  const mockEvent = {
    topic: [
      nativeToScVal(IdentityEvents.OwnerTransferred, { type: "symbol" }),
      new Address(oldOwner).toScVal(),
      new Address(newOwner).toScVal(),
    ],
    value: nativeToScVal(100n),
  };

  const decoded = decodeOwnerTransferredEvent(mockEvent);
  assert.equal(decoded.type, IdentityEvents.OwnerTransferred);
  assert.equal(decoded.oldOwner, oldOwner);
  assert.equal(decoded.newOwner, newOwner);
  assert.equal(decoded.agentId, 100n);
});

test("decodeJobCreatedEvent decodes valid JobCreated event", () => {
  const client = Keypair.random().publicKey();
  const mockEvent = {
    topic: [
      nativeToScVal(CommerceEvents.JobCreated, { type: "symbol" }),
      new Address(client).toScVal(),
    ],
    value: [1n, 10_000_000n],
  };

  const decoded = decodeJobCreatedEvent(mockEvent);
  assert.equal(decoded.type, CommerceEvents.JobCreated);
  assert.equal(decoded.client, client);
  assert.equal(decoded.jobId, 1n);
  assert.equal(decoded.budget, 10_000_000n);

  const generic = decodeCommerceEvent(mockEvent);
  assert.equal(generic.type, CommerceEvents.JobCreated);
});

test("decodeJobSubmittedEvent decodes valid JobSubmitted event", () => {
  const provider = Keypair.random().publicKey();
  const mockEvent = {
    topic: [
      nativeToScVal(CommerceEvents.JobSubmitted, { type: "symbol" }),
      new Address(provider).toScVal(),
    ],
    value: nativeToScVal(2n),
  };

  const decoded = decodeJobSubmittedEvent(mockEvent);
  assert.equal(decoded.type, CommerceEvents.JobSubmitted);
  assert.equal(decoded.provider, provider);
  assert.equal(decoded.jobId, 2n);
});

test("decodeJobCompletedEvent decodes valid JobCompleted event", () => {
  const evaluator = Keypair.random().publicKey();
  const mockEvent = {
    topic: [
      nativeToScVal(CommerceEvents.JobCompleted, { type: "symbol" }),
      new Address(evaluator).toScVal(),
    ],
    value: [3n, 9_900_000n, 100_000n, 1710000000n],
  };

  const decoded = decodeJobCompletedEvent(mockEvent);
  assert.equal(decoded.type, CommerceEvents.JobCompleted);
  assert.equal(decoded.evaluator, evaluator);
  assert.equal(decoded.jobId, 3n);
  assert.equal(decoded.payout, 9_900_000n);
  assert.equal(decoded.fee, 100_000n);
  assert.equal(decoded.timestamp, 1710000000n);
});

test("decodeJobCancelledEvent decodes valid JobCancelled event", () => {
  const client = Keypair.random().publicKey();
  const mockEvent = {
    topic: [
      nativeToScVal(CommerceEvents.JobCancelled, { type: "symbol" }),
      new Address(client).toScVal(),
    ],
    value: nativeToScVal(4n),
  };

  const decoded = decodeJobCancelledEvent(mockEvent);
  assert.equal(decoded.type, CommerceEvents.JobCancelled);
  assert.equal(decoded.client, client);
  assert.equal(decoded.jobId, 4n);
});

test("decodeJobDisputedEvent decodes valid JobDisputed event", () => {
  const client = Keypair.random().publicKey();
  const mockEvent = {
    topic: [
      nativeToScVal(CommerceEvents.JobDisputed, { type: "symbol" }),
      new Address(client).toScVal(),
    ],
    value: [5n, 1710000500n],
  };

  const decoded = decodeJobDisputedEvent(mockEvent);
  assert.equal(decoded.type, CommerceEvents.JobDisputed);
  assert.equal(decoded.client, client);
  assert.equal(decoded.jobId, 5n);
  assert.equal(decoded.timestamp, 1710000500n);
});

test("decodeJobRefundedEvent decodes valid JobRefunded event", () => {
  const client = Keypair.random().publicKey();
  const mockEvent = {
    topic: [
      nativeToScVal(CommerceEvents.JobRefunded, { type: "symbol" }),
      new Address(client).toScVal(),
    ],
    value: nativeToScVal(6n),
  };

  const decoded = decodeJobRefundedEvent(mockEvent);
  assert.equal(decoded.type, CommerceEvents.JobRefunded);
  assert.equal(decoded.client, client);
  assert.equal(decoded.jobId, 6n);
});

test("decodeJobExpiredEvent decodes valid JobExpired event", () => {
  const provider = Keypair.random().publicKey();
  const mockEvent = {
    topic: [
      nativeToScVal(CommerceEvents.JobExpired, { type: "symbol" }),
      new Address(provider).toScVal(),
    ],
    value: [7n, 9_900_000n, 100_000n, 1710000900n],
  };

  const decoded = decodeJobExpiredEvent(mockEvent);
  assert.equal(decoded.type, CommerceEvents.JobExpired);
  assert.equal(decoded.provider, provider);
  assert.equal(decoded.jobId, 7n);
  assert.equal(decoded.payout, 9_900_000n);
  assert.equal(decoded.fee, 100_000n);
  assert.equal(decoded.timestamp, 1710000900n);
});

test("decoders reject mismatched event types", () => {
  const client = Keypair.random().publicKey();
  const wrongEvent = {
    topic: [
      nativeToScVal(CommerceEvents.JobSubmitted, { type: "symbol" }),
      new Address(client).toScVal(),
    ],
    value: nativeToScVal(1n),
  };

  assert.throws(() => decodeJobCreatedEvent(wrongEvent), /Expected JobCreated/);
  assert.throws(() => decodeRegisteredEvent(wrongEvent), /Expected Registered/);
});

const EVENTS_DOC_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../docs/EVENTS.md",
);

function extractDocEventNames(): string[] {
  const doc = readFileSync(EVENTS_DOC_PATH, "utf8");
  const jsonBlocks = [...doc.matchAll(/```json\s*\n([\s\S]*?)```/g)].map(
    (match) => match[1],
  );
  assert.ok(jsonBlocks.length > 0, "docs/EVENTS.md must contain a JSON schema block");

  const names = new Set<string>();
  for (const block of jsonBlocks) {
    const schema = JSON.parse(block) as {
      $defs?: Record<string, unknown>;
    };
    if (!schema.$defs) continue;
    for (const defName of Object.keys(schema.$defs)) {
      const match = /^([A-Za-z]+)Event$/.exec(defName);
      if (match) names.add(match[1]);
    }
  }
  return [...names].sort();
}

function extractUnionEventNames(): string[] {
  const names = new Set<string>();
  for (const value of Object.values(IdentityEvents)) names.add(value);
  for (const value of Object.values(CommerceEvents)) names.add(value);
  return [...names].sort();
}

test("BearEvent union matches the contract event list in docs/EVENTS.md", () => {
  const docNames = extractDocEventNames();
  const unionNames = extractUnionEventNames();

  const missing = docNames.filter((name) => !unionNames.includes(name));
  const extra = unionNames.filter((name) => !docNames.includes(name));

  assert.deepEqual(
    missing,
    [],
    `BearEvent union is missing events documented in docs/EVENTS.md: ${missing.join(", ")}`,
  );
  assert.deepEqual(
    extra,
    [],
    `BearEvent union has events not documented in docs/EVENTS.md: ${extra.join(", ")}`,
  );
  assert.deepEqual(unionNames, docNames);
});

function describeBearEvent(event: BearEvent): string {
  switch (event.type) {
    case IdentityEvents.Registered:
      return `registered:${event.agentId}`;
    case IdentityEvents.UriUpdated:
      return `uri-updated:${event.agentId}`;
    case IdentityEvents.AgentDeregistered:
      return `deregistered:${event.agentId}`;
    case IdentityEvents.OwnerTransferred:
      return `owner-transferred:${event.agentId}`;
    case CommerceEvents.JobCreated:
      return `job-created:${event.jobId}`;
    case CommerceEvents.JobSubmitted:
      return `job-submitted:${event.jobId}`;
    case CommerceEvents.JobCompleted:
      return `job-completed:${event.jobId}`;
    case CommerceEvents.JobCancelled:
      return `job-cancelled:${event.jobId}`;
    case CommerceEvents.JobDisputed:
      return `job-disputed:${event.jobId}`;
    case CommerceEvents.JobRefunded:
      return `job-refunded:${event.jobId}`;
    case CommerceEvents.JobExpired:
      return `job-expired:${event.jobId}`;
    default:
      return assertNever(event);
  }
}

test("exhaustive switch over BearEvent compiles and handles every event", () => {
  const owner = Keypair.random().publicKey();
  const client = Keypair.random().publicKey();

  const registered = decodeRegisteredEvent({
    topic: [
      nativeToScVal(IdentityEvents.Registered, { type: "symbol" }),
      new Address(owner).toScVal(),
    ],
    value: nativeToScVal(1n),
  });
  assert.equal(describeBearEvent(registered), "registered:1");

  const jobCreated = decodeJobCreatedEvent({
    topic: [
      nativeToScVal(CommerceEvents.JobCreated, { type: "symbol" }),
      new Address(client).toScVal(),
    ],
    value: [2n, 10_000_000n],
  });
  assert.equal(describeBearEvent(jobCreated), "job-created:2");
});
