# Soroban event registry

This document is the versioned event registry for `agent-identity` and
`agentic-commerce`. New event layouts must use a new version and must not
reinterpret a historical version.

## Topic header

Soroban reserves topic 0 for the event symbol and reports the emitting
contract separately as `contractId`. Version 2 events use the following
header:

```text
contractId (RPC envelope), EventName, Version (u32), ActorAddress
```

The corresponding Soroban `topic` array is
`[EventName, Version, ActorAddress]`; event-specific data is stored in the
event value. Version 1 events predate versioned headers and use
`[EventName, ActorAddress, ...]`. Consumers MUST treat those as version 1.
Additional topic fields from a historical v1 event remain part of its v1
definition; v2 events keep only the actor in the header.

All addresses are Stellar StrKey strings in the JSON representation below.
`u32` and `u64` values are non-negative integers, `i128` values are signed
integers in token base units, `BytesN<32>` values are 32-byte hex strings,
and Soroban symbols are strings. The `version` is a topic, not part of the
event data object.

## Event JSON Schemas

The following definitions are Draft 2020-12 JSON Schemas for each event's
decoded `value` object. The event name and version are identified by the
topic header above. Every event data object rejects undeclared fields.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://marcprotocol.com/schemas/stellar-events-v2.json",
  "$defs": {
    "Initialized": {
      "type": "object",
      "required": ["treasury"],
      "properties": {"treasury": {"$ref": "#/$defs/Address"}},
      "additionalProperties": false
    },
    "JobCreated": {
      "type": "object",
      "required": ["job_id", "budget"],
      "properties": {"job_id": {"$ref": "#/$defs/U64"}, "budget": {"$ref": "#/$defs/I128"}},
      "additionalProperties": false
    },
    "BatchJobsCreated": {
      "type": "object",
      "required": ["job_ids"],
      "properties": {"job_ids": {"type": "array", "items": {"$ref": "#/$defs/U64"}}},
      "additionalProperties": false
    },
    "JobSubmitted": {
      "type": "object",
      "required": ["job_id", "deliverable_hash"],
      "properties": {"job_id": {"$ref": "#/$defs/U64"}, "deliverable_hash": {"$ref": "#/$defs/Hash32"}},
      "additionalProperties": false
    },
    "JobCompleted": {
      "type": "object",
      "required": ["job_id", "provider", "payout", "fee", "timestamp"],
      "properties": {
        "job_id": {"$ref": "#/$defs/U64"}, "provider": {"$ref": "#/$defs/Address"},
        "payout": {"$ref": "#/$defs/I128"}, "fee": {"$ref": "#/$defs/I128"},
        "timestamp": {"$ref": "#/$defs/U64"}
      },
      "additionalProperties": false
    },
    "JobExpired": {
      "type": "object",
      "required": ["job_id", "payout", "fee", "timestamp"],
      "properties": {
        "job_id": {"$ref": "#/$defs/U64"}, "payout": {"$ref": "#/$defs/I128"},
        "fee": {"$ref": "#/$defs/I128"}, "timestamp": {"$ref": "#/$defs/U64"}
      },
      "additionalProperties": false
    },
    "JobRefunded": {
      "type": "object",
      "required": ["job_id"],
      "properties": {"job_id": {"$ref": "#/$defs/U64"}},
      "additionalProperties": false
    },
    "JobCancelled": {
      "type": "object",
      "required": ["job_id"],
      "properties": {"job_id": {"$ref": "#/$defs/U64"}},
      "additionalProperties": false
    },
    "SlaPenaltyApplied": {
      "type": "object",
      "required": ["job_id", "overdue_hours", "penalty_bps", "penalty"],
      "properties": {
        "job_id": {"$ref": "#/$defs/U64"}, "overdue_hours": {"$ref": "#/$defs/U64"},
        "penalty_bps": {"$ref": "#/$defs/U32"}, "penalty": {"$ref": "#/$defs/I128"}
      },
      "additionalProperties": false
    },
    "JobDisputed": {
      "type": "object",
      "required": ["job_id", "timestamp"],
      "properties": {"job_id": {"$ref": "#/$defs/U64"}, "timestamp": {"$ref": "#/$defs/U64"}},
      "additionalProperties": false
    },
    "Paused": {
      "type": "object",
      "required": ["timestamp"],
      "properties": {"timestamp": {"$ref": "#/$defs/U64"}},
      "additionalProperties": false
    },
    "Unpaused": {
      "type": "object",
      "required": ["timestamp"],
      "properties": {"timestamp": {"$ref": "#/$defs/U64"}},
      "additionalProperties": false
    },
    "TokenWhitelisted": {
      "type": "object",
      "required": ["token", "decimals"],
      "properties": {"token": {"$ref": "#/$defs/Address"}, "decimals": {"$ref": "#/$defs/U32"}},
      "additionalProperties": false
    },
    "TokenRemoved": {
      "type": "object",
      "required": ["token"],
      "properties": {"token": {"$ref": "#/$defs/Address"}},
      "additionalProperties": false
    },
    "ReInitialized": {
      "type": "object",
      "required": ["new_admin", "new_treasury"],
      "properties": {
        "new_admin": {"$ref": "#/$defs/Address"}, "new_treasury": {"$ref": "#/$defs/Address"}
      },
      "additionalProperties": false
    },
    "MilestoneJobCreated": {
      "type": "object",
      "required": ["job_id", "budget", "milestone_count"],
      "properties": {
        "job_id": {"$ref": "#/$defs/U64"}, "budget": {"$ref": "#/$defs/I128"},
        "milestone_count": {"$ref": "#/$defs/U32"}
      },
      "additionalProperties": false
    },
    "MilestoneSubmitted": {
      "type": "object",
      "required": ["job_id", "milestone_index"],
      "properties": {"job_id": {"$ref": "#/$defs/U64"}, "milestone_index": {"$ref": "#/$defs/U32"}},
      "additionalProperties": false
    },
    "MilestoneApproved": {
      "type": "object",
      "required": ["job_id", "milestone_index", "payout", "fee"],
      "properties": {
        "job_id": {"$ref": "#/$defs/U64"}, "milestone_index": {"$ref": "#/$defs/U32"},
        "payout": {"$ref": "#/$defs/I128"}, "fee": {"$ref": "#/$defs/I128"}
      },
      "additionalProperties": false
    },
    "MilestonesPartialCancelled": {
      "type": "object",
      "required": ["job_id", "refund"],
      "properties": {"job_id": {"$ref": "#/$defs/U64"}, "refund": {"$ref": "#/$defs/I128"}},
      "additionalProperties": false
    },
    "SwapFunded": {
      "type": "object",
      "required": ["job_id", "input_token", "target_token", "input_spent", "refund", "budget"],
      "properties": {
        "job_id": {"$ref": "#/$defs/U64"}, "input_token": {"$ref": "#/$defs/Address"},
        "target_token": {"$ref": "#/$defs/Address"}, "input_spent": {"$ref": "#/$defs/I128"},
        "refund": {"$ref": "#/$defs/I128"}, "budget": {"$ref": "#/$defs/I128"}
      },
      "additionalProperties": false
    },
    "ChannelOpened": {
      "type": "object",
      "required": ["channel_id", "provider", "deposit"],
      "properties": {
        "channel_id": {"$ref": "#/$defs/U64"}, "provider": {"$ref": "#/$defs/Address"},
        "deposit": {"$ref": "#/$defs/I128"}
      },
      "additionalProperties": false
    },
    "ChannelClosing": {
      "type": "object",
      "required": ["channel_id", "amount", "challenge_until"],
      "properties": {
        "channel_id": {"$ref": "#/$defs/U64"}, "amount": {"$ref": "#/$defs/I128"},
        "challenge_until": {"$ref": "#/$defs/U64"}
      },
      "additionalProperties": false
    },
    "ChannelSettled": {
      "type": "object",
      "required": ["channel_id", "amount", "refund"],
      "properties": {
        "channel_id": {"$ref": "#/$defs/U64"}, "amount": {"$ref": "#/$defs/I128"},
        "refund": {"$ref": "#/$defs/I128"}
      },
      "additionalProperties": false
    },
    "JobApproved": {
      "type": "object",
      "required": ["job_id", "approvals", "threshold"],
      "properties": {
        "job_id": {"$ref": "#/$defs/U64"}, "approvals": {"$ref": "#/$defs/U32"},
        "threshold": {"$ref": "#/$defs/U32"}
      },
      "additionalProperties": false
    },
    "Registered": {
      "type": "object",
      "required": ["agent_id"],
      "properties": {"agent_id": {"$ref": "#/$defs/U64"}},
      "additionalProperties": false
    },
    "UriUpdated": {
      "type": "object",
      "required": ["agent_id"],
      "properties": {"agent_id": {"$ref": "#/$defs/U64"}},
      "additionalProperties": false
    },
    "AgentDeregistered": {
      "type": "object",
      "required": ["agent_id"],
      "properties": {"agent_id": {"$ref": "#/$defs/U64"}},
      "additionalProperties": false
    },
    "OwnerTransferred": {
      "type": "object",
      "required": ["new_owner", "agent_id"],
      "properties": {
        "new_owner": {"$ref": "#/$defs/Address"}, "agent_id": {"$ref": "#/$defs/U64"}
      },
      "additionalProperties": false
    },
    "DelegateGranted": {
      "type": "object",
      "required": ["agent_id", "delegate", "valid_until", "permissions"],
      "properties": {
        "agent_id": {"$ref": "#/$defs/U64"}, "delegate": {"$ref": "#/$defs/Address"},
        "valid_until": {"$ref": "#/$defs/U64"}, "permissions": {"$ref": "#/$defs/U32"}
      },
      "additionalProperties": false
    },
    "DelegateRevoked": {
      "type": "object",
      "required": ["agent_id", "delegate"],
      "properties": {"agent_id": {"$ref": "#/$defs/U64"}, "delegate": {"$ref": "#/$defs/Address"}},
      "additionalProperties": false
    },
    "BadgeIssued": {
      "type": "object",
      "required": ["agent_id", "tag", "score", "expires_at"],
      "properties": {
        "agent_id": {"$ref": "#/$defs/U64"}, "tag": {"type": "string"},
        "score": {"$ref": "#/$defs/U32"}, "expires_at": {"$ref": "#/$defs/U64"}
      },
      "additionalProperties": false
    },
    "BadgeRevoked": {
      "type": "object",
      "required": ["agent_id", "tag"],
      "properties": {"agent_id": {"$ref": "#/$defs/U64"}, "tag": {"type": "string"}},
      "additionalProperties": false
    },
    "Address": {"type": "string", "pattern": "^[GCA][A-Z2-7]{55}$"},
    "Hash32": {"type": "string", "pattern": "^[0-9a-fA-F]{64}$"},
    "U32": {"type": "integer", "minimum": 0, "maximum": 4294967295},
    "U64": {"type": "integer", "minimum": 0},
    "I128": {"type": "integer"}
  }
}
```

## Compatibility rules

- Indexers must use `contractId` as the contract identity and decode the event
  name from topic 0.
- A numeric topic 1 denotes a versioned event; topic 1 is the version and topic
  2 is the actor.
- A non-numeric topic 1 is a legacy actor and the event is version 1.
- Unknown versions must be retained as raw events; do not discard an event
  solely because its schema version is newer than the indexer.
- When changing the data shape, define a new versioned event schema rather
  than silently changing the meaning of an existing version.

## Reorg-safe processing

Stellar finality is fast, but RPC nodes can lag or serve different views of
the ledger chain. The indexer therefore never processes an event from the
latest ledger; it only processes events once they are buried under a
confirmation depth.

### Confirmation depth

The indexer processes events only after `CONFIRMATION_DEPTH` ledgers have
been closed on top of the ledger that emitted them. An event in ledger `L`
becomes eligible for processing once the latest observed ledger is at least
`L + CONFIRMATION_DEPTH`. Events in more recent ledgers are held back until
they reach that depth.

`CONFIRMATION_DEPTH` is a non-negative integer configuration value:

- `0` processes events from the latest ledger immediately. This is only
  appropriate for local development and offers no rollback protection.
- Larger values increase safety at the cost of latency. The default is
  chosen to comfortably exceed the depth of a typical RPC node lag.
- The value is read from the indexer configuration (for example the
  `CONFIRMATION_DEPTH` environment variable) and must be documented wherever
  the indexer is deployed.

### Ledger hash continuity

Before processing events from a ledger, the indexer verifies that the ledger
chain is continuous. Each ledger record carries its own hash and the hash of
its parent ledger. The indexer stores the hash of the last processed ledger
and checks that the parent hash of the next ledger matches it. A mismatch
means the node is serving a different view of the chain than the one the
indexer previously observed.

### Detected rollback

When a hash-continuity check fails, the indexer treats it as a rollback:

1. It rewinds its cursor to the last ledger whose hash is still part of the
   canonical chain, discarding any progress made on the abandoned branch.
2. It purges events that were emitted on the orphaned ledgers so they are
   not left in the index.
3. It resumes processing from the rewound cursor, re-applying events from the
   canonical chain once they again reach `CONFIRMATION_DEPTH`.

Because events are only processed after `CONFIRMATION_DEPTH` ledgers, a
rollback shallower than that depth is detected before any of its events are
processed, and a deeper rollback is corrected by the rewind and purge above.
=======
