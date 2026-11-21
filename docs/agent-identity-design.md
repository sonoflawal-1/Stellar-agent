# Agent Identity Contract — Design Notes

This document records design decisions made in
`contracts/agent-identity/src/lib.rs` that were raised as open issues.

---

## ID Semantics — append-only counter (closes #206)

`next_id` is a strictly-incrementing `u64` counter stored in instance storage.
When an agent deregisters, its numeric ID is **never reused**.

**Why not reuse IDs?**

- A free-list/reuse queue would add storage complexity and create
  re-entrancy edge-cases (a new agent at an old ID could be confused for
  the deregistered one by off-chain indexers).
- `u64` gives 18.4 quintillion IDs — practical exhaustion is impossible.
- Off-chain consumers (dashboards, indexers) can safely cache IDs knowing
  that a given number always refers to the same historical registration event.

**Consequence:** `next_id - 1` equals the _total number of registrations ever
made_, not the number of _currently active_ agents. For the live count, use
`registered_count()` (see below).

The docstring on `register()` spells this out explicitly:

```rust
/// # ID Semantics
///
/// Agent IDs are **append-only**. Once assigned, an ID is never reused,
/// even if the corresponding agent is later deregistered. `next_id`
/// therefore represents the total number of registrations ever performed,
/// not the current number of active agents.
```

---

## Duplicate-address guard (closes #207)

`register()` rejects a second registration from the same `owner` address by
checking `OwnerToId` persistent storage before doing any write:

```rust
if env.storage().persistent().has(&DataKey::OwnerToId(owner.clone())) {
    panic_with_error!(&env, Error::AlreadyRegistered);
}
```

The typed error `Error::AlreadyRegistered = 2` surfaces as
`Error(Contract, #2)` on the client, making it pattern-matchable without
parsing strings.

After a `deregister()` call, the `OwnerToId` slot is freed, allowing the
same address to re-register and receive a new (non-reused) ID.

---

## Registered-agent count getter (closes #208)

A `RegisteredCount` key in instance storage tracks the number of currently
active (non-deregistered) agents. It is maintained by:

- `register()` — increments with `checked_add` (panics on overflow)
- `deregister()` — decrements with `saturating_sub` (floors at 0)

The public getter:

```rust
pub fn registered_count(env: Env) -> u32 { … }
```

Returns the _live_ count, suitable for dashboard stats bars and monitoring.
This is intentionally distinct from `next_id - 1`, which is the all-time
registration total.

---

## Paginated agent enumeration (closes #209)

`list_agents(start_id: u32, limit: u32) -> Vec<Agent>` replaces the previous
O(n) one-by-one RPC pattern. It scans IDs from `start_id` up to `next_id`,
collecting up to `limit` active agents and silently skipping gaps left by
deregistered entries:

```rust
pub fn list_agents(env: Env, start_id: u32, limit: u32) -> Vec<Agent> { … }
```

**Pagination recipe** (dashboard example):

```
page 1: list_agents(start_id=1,  limit=20)
page 2: list_agents(start_id=21, limit=20)
…
```

Because IDs are append-only and gaps are skipped, callers do not need to
handle "holes" themselves. The function returns fewer than `limit` items only
when the end of the registry has been reached.
