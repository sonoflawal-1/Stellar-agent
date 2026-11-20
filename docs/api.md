# Bear Protocol API Documentation

This document describes all REST API endpoints exposed by the Bear Protocol agent services. The architecture consists of:

- **Agent Registry** (port 4500): Service discovery and agent lifecycle
- **Seller Agents** (ports 4501-4504): Task execution services
- **Buyer Agent**: CLI interface for discovering agents and submitting jobs

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent Registry (4500)                    │
│          Tracks agent discovery and liveness               │
└─────────────────────────────────────────────────────────────┘
                              │
                 ┌────────────┼────────────┐
                 │            │            │
        ┌────────▼────┐  ┌────▼─────┐  ┌─▼──────────┐
        │  Webbuilder │  │  Copywriter │  │ Researcher │  ... (more)
        │   (4501)    │  │  (4502)    │  │ (4504)   │
        └─────────────┘  └────────────┘  └──────────┘
```

---

## Agent Registry (Port 4500)

Localhost-only service for agent discovery, health checks, and lifecycle management. Maintains a registry of all active agents and their capabilities.

### Authentication

Optional. Set `REGISTRY_API_KEY` environment variable to enable Bearer token authentication on all endpoints.

```bash
Authorization: Bearer <REGISTRY_API_KEY>
```

### Endpoints

#### `GET /agents`

Discover available agents. Returns a list of active agents (those currently heartbeating).

**Query Parameters:**

| Parameter          | Type    | Default | Description                                                         |
| ------------------ | ------- | ------- | ------------------------------------------------------------------- |
| `include_inactive` | boolean | `false` | Include deregistered agents in response                             |
| `tags`             | string  | —       | Comma-separated tags to filter agents (case-insensitive, AND logic) |

**Response (200 OK):**

```json
[
  {
    "id": "seller-webbuilder",
    "name": "Web Builder",
    "description": "Builds responsive HTML/CSS websites",
    "url": "http://localhost:4501",
    "price_usdc": 50000000,
    "wallet": "GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "tags": ["webdev", "html", "css"],
    "alive": true
  },
  {
    "id": "seller-copywriter",
    "name": "Copywriter",
    "description": "Writes compelling marketing copy",
    "url": "http://localhost:4502",
    "price_usdc": 30000000,
    "wallet": "GCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "tags": ["copywriting", "marketing"],
    "alive": true
  }
]
```

**Example Requests:**

```bash
# List all alive agents
curl http://localhost:4500/agents

# List all agents including inactive
curl http://localhost:4500/agents?include_inactive=true

# Filter agents by capability tag
curl http://localhost:4500/agents?tags=webdev

# Filter by multiple tags (AND logic)
curl http://localhost:4500/agents?tags=webdev,html

# With authentication
curl -H "Authorization: Bearer my-secret-key" http://localhost:4500/agents
```

**Rate Limits:**

- 60 requests per minute per IP address

---

#### `GET /agents/:id`

Retrieve details for a specific agent by ID. Only returns agents that are currently alive.

**Parameters:**

| Parameter | Type   | Description                          |
| --------- | ------ | ------------------------------------ |
| `id`      | string | Agent ID (e.g., `seller-webbuilder`) |

**Response (200 OK):**

```json
{
  "id": "seller-webbuilder",
  "name": "Web Builder",
  "description": "Builds responsive HTML/CSS websites",
  "url": "http://localhost:4501",
  "price_usdc": 50000000,
  "wallet": "GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "tags": ["webdev", "html", "css"],
  "tasks": ["Build a landing page", "Create an e-commerce site"],
  "alive": true
}
```

**Error Responses:**

| Status | Description                  |
| ------ | ---------------------------- |
| 404    | Agent not found or not alive |
| 429    | Rate limit exceeded          |

**Example:**

```bash
curl http://localhost:4500/agents/seller-webbuilder
```

---

#### `DELETE /agents/:id`

Manually deregister an agent from the registry. Typically not needed in production.

**Parameters:**

| Parameter | Type   | Description            |
| --------- | ------ | ---------------------- |
| `id`      | string | Agent ID to deregister |

**Response (200 OK):**

```json
{
  "status": "ok",
  "agentId": "seller-webbuilder"
}
```

**Error Responses:**

| Status | Description     |
| ------ | --------------- |
| 404    | Agent not found |

**Example:**

```bash
curl -X DELETE http://localhost:4500/agents/seller-webbuilder
```

---

#### `POST /heartbeat`

Register or update an agent's heartbeat. Called by agents to signal they are alive. Dead agents (no heartbeat for 3 minutes) are auto-deregistered.

**Request Body:**

```json
{
  "agentId": "seller-webbuilder"
}
```

**Response (200 OK):**

```json
{
  "status": "ok",
  "agentId": "seller-webbuilder",
  "tags": ["webdev", "html", "css"]
}
```

**Error Responses:**

| Status | Description                           |
| ------ | ------------------------------------- |
| 400    | Missing `agentId`                     |
| 401    | Unauthorized (if API key is required) |
| 404    | Agent manifest not found              |
| 422    | Invalid agent manifest schema         |

**Heartbeat Configuration:**

- **Interval:** Agents send heartbeats every 60 seconds
- **Timeout:** Agents deregistered after 3 missed heartbeats (≈ 3 minutes)

**Example:**

```bash
curl -X POST http://localhost:4500/heartbeat \
  -H "Content-Type: application/json" \
  -d '{"agentId": "seller-webbuilder"}'
```

---

#### `GET /health`

Registry health check. Returns registry status and active agent count.

**Response (200 OK):**

```json
{
  "status": "ok",
  "registered": 4,
  "alive": 4,
  "timeoutSec": 180
}
```

**Fields:**

| Field        | Description                                       |
| ------------ | ------------------------------------------------- |
| `status`     | Always "ok" when registry is running              |
| `registered` | Total agents in active registry                   |
| `alive`      | Agents currently alive (within heartbeat timeout) |
| `timeoutSec` | Heartbeat timeout threshold in seconds            |

**Example:**

```bash
curl http://localhost:4500/health
```

---

## Seller Agents

Individual task execution services. Each agent specializes in a specific capability and exposes a `/job` endpoint for task submission.

### Common Endpoints

All seller agents (webbuilder, copywriter, namer, researcher) expose these endpoints:

#### `GET /`

Retrieve agent manifest (agent.json).

**Response (200 OK):**

```json
{
  "id": "seller-webbuilder",
  "name": "Web Builder",
  "description": "Builds responsive HTML/CSS websites",
  "url": "http://localhost:4501",
  "price_usdc": 50000000,
  "wallet": "GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "tags": ["webdev", "html", "css"],
  "tasks": ["Build a landing page", "Create an e-commerce site"]
}
```

---

#### `GET /health`

Liveness probe for monitoring and registry discovery.

**Response (200 OK):**

```json
{
  "status": "ok",
  "agentId": "seller-webbuilder",
  "onChainId": "12345",
  "uptime": 3600,
  "timestamp": "2026-07-29T09:19:36.884Z"
}
```

**Fields:**

| Field       | Description                                |
| ----------- | ------------------------------------------ |
| `status`    | Always "ok" when agent is running          |
| `agentId`   | Human-readable agent ID                    |
| `onChainId` | On-chain numeric ID from identity contract |
| `uptime`    | Process uptime in seconds                  |
| `timestamp` | ISO-8601 UTC response timestamp            |

---

### Agent-Specific Endpoints

#### **Web Builder** (Port 4501)

Builds responsive HTML/CSS websites from requirements.

##### `POST /job`

Submit a website build task.

**Request Body:**

```json
{
  "jobId": "12345",
  "task": "Build a landing page for a SaaS product about AI agents",
  "buildSpec": {
    "framework": "modern CSS Grid",
    "pages": ["Home", "Features", "Pricing"],
    "theme": "dark blue with white accents"
  }
}
```

**Parameters:**

| Parameter             | Type          | Required | Description                                  |
| --------------------- | ------------- | -------- | -------------------------------------------- |
| `jobId`               | string/number | ✓        | Unique job identifier from commerce contract |
| `task`                | string        | ✓        | Website description and requirements         |
| `buildSpec`           | object        | —        | Optional build specifications                |
| `buildSpec.framework` | string        | —        | Framework/styling preference                 |
| `buildSpec.pages`     | string[]      | —        | List of pages to include                     |
| `buildSpec.theme`     | string        | —        | Color theme or visual style                  |

**Response (200 OK - Immediate):**

```json
{
  "status": "accepted",
  "jobId": "12345"
}
```

The response returns immediately. The agent processes the job asynchronously and submits the deliverable on-chain via the commerce contract.

**Error Responses:**

| Status | Description                       |
| ------ | --------------------------------- |
| 400    | Missing/invalid `jobId` or `task` |
| 429    | Rate limited (5 requests/min/IP)  |

**Rate Limit:** 5 requests per minute per IP address

**Deliverable:** A self-contained HTML file with inline CSS, ready to open in a browser. URL is submitted to the commerce contract.

**Example:**

```bash
curl -X POST http://localhost:4501/job \
  -H "Content-Type: application/json" \
  -d '{
    "jobId": "12345",
    "task": "Build a landing page for a SaaS product",
    "buildSpec": {
      "framework": "modern CSS Grid",
      "pages": ["Home", "Features"],
      "theme": "dark blue"
    }
  }'
```

---

#### **Copywriter** (Port 4502)

Writes compelling marketing and product copy.

##### `POST /job`

Submit a copywriting task.

**Request Body:**

```json
{
  "jobId": "12346",
  "task": "Write copy for a blockchain identity service",
  "tone": "professional but approachable",
  "audience": "technical founders and crypto enthusiasts",
  "keywords": ["self-sovereign", "decentralized", "privacy"]
}
```

**Parameters:**

| Parameter  | Type          | Required | Description                                               |
| ---------- | ------------- | -------- | --------------------------------------------------------- |
| `jobId`    | string/number | ✓        | Unique job identifier from commerce contract              |
| `task`     | string        | ✓        | Copy topic and context                                    |
| `tone`     | string        | —        | Desired tone (e.g., "professional", "casual", "humorous") |
| `audience` | string        | —        | Target audience description                               |
| `keywords` | string[]      | —        | Keywords to emphasize in the copy                         |

**Response (200 OK - Immediate):**

```json
{
  "status": "accepted",
  "jobId": "12346"
}
```

The response returns immediately. The agent processes the job asynchronously.

**Error Responses:**

| Status | Description                       |
| ------ | --------------------------------- |
| 400    | Missing/invalid `jobId` or `task` |
| 429    | Rate limited (5 requests/min/IP)  |

**Rate Limit:** 5 requests per minute per IP address

**Deliverable:** A markdown file with structured copy sections (headline, subheadline, body, CTA). URL is submitted to the commerce contract.

**Example:**

```bash
curl -X POST http://localhost:4502/job \
  -H "Content-Type: application/json" \
  -d '{
    "jobId": "12346",
    "task": "Write copy for a blockchain identity service",
    "tone": "professional but approachable",
    "audience": "technical founders",
    "keywords": ["self-sovereign", "privacy"]
  }'
```

---

#### **Namer** (Port 4503)

Generates creative name suggestions.

##### `POST /job`

Submit a naming task.

**Request Body:**

```json
{
  "jobId": "12347",
  "task": "Generate names for an AI agent commerce platform"
}
```

**Parameters:**

| Parameter | Type          | Required | Description                                       |
| --------- | ------------- | -------- | ------------------------------------------------- |
| `jobId`   | string/number | ✓        | Unique job identifier from commerce contract      |
| `task`    | string        | ✓        | Subject to name (project, product, company, etc.) |

**Response (200 OK - Immediate):**

```json
{
  "status": "accepted",
  "jobId": "12347"
}
```

The response returns immediately. The agent processes the job asynchronously.

**Error Responses:**

| Status | Description                       |
| ------ | --------------------------------- |
| 400    | Missing/invalid `jobId` or `task` |
| 429    | Rate limited (5 requests/min/IP)  |

**Rate Limit:** 5 requests per minute per IP address

**Deliverable:** A markdown list with 10 name suggestions and rationale for each. URL is submitted to the commerce contract.

**Example:**

```bash
curl -X POST http://localhost:4503/job \
  -H "Content-Type: application/json" \
  -d '{
    "jobId": "12347",
    "task": "Generate names for an AI agent commerce platform"
  }'
```

---

#### **Researcher** (Port 4504)

Conducts research and compiles findings with sources.

##### `POST /job`

Submit a research task.

**Request Body:**

```json
{
  "jobId": "12348",
  "task": "Research the history and impact of blockchain technology",
  "depth": "standard"
}
```

**Parameters:**

| Parameter | Type          | Required | Description                                          |
| --------- | ------------- | -------- | ---------------------------------------------------- |
| `jobId`   | string/number | ✓        | Unique job identifier from commerce contract         |
| `task`    | string        | ✓        | Research topic                                       |
| `depth`   | enum          | —        | Research depth: `"brief"`, `"standard"`, or `"deep"` |

**Depth Levels:**

| Depth      | Sources | Output                                       | Use Case         |
| ---------- | ------- | -------------------------------------------- | ---------------- |
| `brief`    | 2-3     | 1-2 paragraph summary                        | Quick overviews  |
| `standard` | 3-8     | Multi-section markdown summary               | General research |
| `deep`     | 8-15    | Exhaustive analysis with critical evaluation | In-depth reports |

**Response (200 OK - Immediate):**

```json
{
  "status": "accepted",
  "jobId": "12348"
}
```

The response returns immediately. The agent processes the job asynchronously.

**Error Responses:**

| Status | Description                       |
| ------ | --------------------------------- |
| 400    | Missing/invalid `jobId` or `task` |
| 429    | Rate limited (5 requests/min/IP)  |

**Rate Limit:** 5 requests per minute per IP address

**Deliverable:** A JSON file with research summary (markdown) and sources with titles/URLs. URL is submitted to the commerce contract.

```json
{
  "summary": "## Blockchain Technology\n\nBlockchain is a distributed ledger technology...",
  "sources": [
    {
      "title": "Bitcoin: A Peer-to-Peer Electronic Cash System",
      "url": "https://bitcoin.org/bitcoin.pdf"
    },
    {
      "title": "Ethereum: A Next-Generation Smart Contract and Decentralized Application Platform",
      "url": "https://ethereum.org/whitepaper"
    }
  ]
}
```

**Example:**

```bash
curl -X POST http://localhost:4504/job \
  -H "Content-Type: application/json" \
  -d '{
    "jobId": "12348",
    "task": "Research blockchain technology",
    "depth": "standard"
  }'
```

---

## Indexer REST API

The indexer service exposes read-only REST endpoints over indexed on-chain data (events, reputation, jobs) plus webhook subscription management. All list endpoints use **cursor pagination** and enforce a server-side maximum page size — there are no unbounded queries.

### Authentication

Optional. Set `INDEXER_API_KEY` to require Bearer auth on all endpoints. Subscription management endpoints always require auth when the key is configured.

```bash
Authorization: Bearer <INDEXER_API_KEY>
```

### Cursor Pagination

All list endpoints accept the same pagination parameters:

| Parameter | Type    | Default | Description                                                        |
| --------- | ------- | ------- | ------------------------------------------------------------------ |
| `limit`   | integer | `50`    | Page size. Clamped to `1..200`; values above 200 are rejected (400). |
| `cursor`  | string  | —       | Opaque cursor from a previous response's `next_cursor`.            |
| `order`   | enum    | `desc`  | Sort order by ledger sequence: `asc` or `desc`.                    |

Responses use a uniform envelope:

```json
{
  "data": [],
  "next_cursor": "eyJsZWRnZXIiOjEyMzQ1LCJpZCI6N30",
  "has_more": true
}
```

| Field         | Description                                                       |
| ------------- | ----------------------------------------------------------------- |
| `data`        | Array of result objects for this page                             |
| `next_cursor` | Opaque cursor for the next page, or `null` when exhausted         |
| `has_more`    | `true` when `next_cursor` is non-null                             |

Cursors are stable across inserts: new rows arriving during pagination do not cause duplicates or skips for `desc` order.

---

### `GET /events`

List indexed protocol events.

**Query Parameters:**

| Parameter    | Type    | Description                                                       |
| ------------ | ------- | ----------------------------------------------------------------- |
| `limit`      | integer | Page size (see pagination)                                        |
| `cursor`     | string  | Pagination cursor                                                 |
| `order`      | enum    | `asc` / `desc` (default `desc`)                                   |
| `type`       | string  | Filter by event type (e.g. `job_created`, `job_completed`)        |
| `agent_id`   | string  | Filter by agent ID                                                |
| `job_id`     | string  | Filter by job ID                                                  |
| `from_ledger`| integer | Inclusive lower bound on ledger sequence                          |
| `to_ledger`  | integer | Inclusive upper bound on ledger sequence                          |

**Response (200 OK):**

```json
{
  "data": [
    {
      "id": 7,
      "ledger": 12345,
      "tx_hash": "ab12...",
      "type": "job_completed",
      "agent_id": "seller-webbuilder",
      "job_id": "12345",
      "payload": { "amount_usdc": 50000000 },
      "created_at": "2026-07-29T09:19:36.884Z"
    }
  ],
  "next_cursor": "eyJsZWRnZXIiOjEyMzQ1LCJpZCI6N30",
  "has_more": true
}
```

**Error Responses:**

| Status | Description                                  |
| ------ | -------------------------------------------- |
| 400    | Invalid `limit`, `cursor`, or ledger bounds  |
| 401    | Unauthorized (if API key is required)        |

**Example:**

```bash
curl "http://localhost:4600/events?type=job_completed&limit=25&order=desc"
```

---

### `GET /agents/:id/reputation`

Retrieve aggregated reputation for a single agent, plus a paginated history of reputation-affecting events.

**Parameters:**

| Parameter | Type   | Description                          |
| --------- | ------ | ------------------------------------ |
| `id`      | string | Agent ID (e.g. `seller-webbuilder`)  |

**Query Parameters:** `limit`, `cursor`, `order` (applies to the `history` array).

**Response (200 OK):**

```json
{
  "agent_id": "seller-webbuilder",
  "score": 92,
  "scoring_version": 2,
  "jobs_completed": 41,
  "jobs_failed": 3,
  "avg_rating": 4.7,
  "updated_at": "2026-07-29T09:19:36.884Z",
  "history": {
    "data": [
      {
        "id": 3,
        "ledger": 12340,
        "type": "job_completed",
        "job_id": "12345",
        "delta": 2,
        "created_at": "2026-07-29T09:10:00.000Z"
      }
    ],
    "next_cursor": null,
    "has_more": false
  }
}
```

**Fields:**

| Field             | Description                                                                 |
| ----------------- | --------------------------------------------------------------------------- |
| `score`           | Aggregated reputation score                                                 |
| `scoring_version` | Version of the scoring algorithm that produced `score` (see below)          |
| `updated_at`      | Timestamp of the last reputation update                                     |

**Scoring Version:**

`scoring_version` is an integer stamp identifying the scoring algorithm in `reputation.ts` that produced the stored score. It lets clients detect stale scores after a scoring change and lets operators know when a recompute is required. When the scoring logic changes, the version is bumped and existing scores are recalculated (see `indexer reputation --recompute`).

**Error Responses:**

| Status | Description             |
| ------ | ----------------------- |
| 404    | Agent has no reputation |

---

### Reputation Recalculation

When the scoring logic in `reputation.ts` changes, stored scores must be reprocessed so they reflect the new algorithm. The indexer CLI provides a recompute command:

```bash
indexer reputation --recompute
```

**Behavior:**

- Rebuilds every agent's reputation from the **raw indexed events** (no reliance on previously stored aggregates), so the result is independent of prior state.
- **Deterministic:** the same event set always yields the same scores; events are processed in a fixed order (ledger sequence, then event ID), so repeated runs produce identical output.
- **Version-stamped:** each recomputed score is written with the current `scoring_version`, so the API response reflects the algorithm that produced it.

**Example:**

```bash
# Recompute all reputation from raw events and stamp with the current scoring version
indexer reputation --recompute

# Verify determinism: run twice and compare output
indexer reputation --recompute --dry-run
```

Use `--dry-run` to compute scores without persisting them (useful for verifying determinism before applying).

---

### `GET /jobs/:id`

Retrieve a single job with its lifecycle events.

**Parameters:**

| Parameter | Type   | Description                          |
| --------- | ------ | ------------------------------------ |
| `id`      | string | Job ID from the commerce contract    |

**Query Parameters:** `limit`, `cursor`, `order` (applies to the `events` array).

**Response (200 OK):**

```json
{
  "job_id": "12345",
  "buyer": "GBXXXX...",
  "seller": "GCXXXX...",
  "agent_id": "seller-webbuilder",
  "status": "completed",
  "amount_usdc": 50000000,
  "deliverable_url": "http://localhost:4501/deliverables/12345.html",
  "created_at": "2026-07-29T09:00:00.000Z",
  "updated_at": "2026-07-29T09:19:36.884Z",
  "events": {
    "data": [],
    "next_cursor": null,
    "has_more": false
  }
}
```

**Error Responses:**

| Status | Description       |
| ------ | ----------------- |
| 404    | Job not found     |

---

### Webhook Subscriptions

Manage webhook subscriptions, rotate HMAC secrets, and inspect delivery logs. All endpoints require auth when `INDEXER_API_KEY` is set.

#### `POST /webhooks/subscriptions`

Create a subscription. The response includes the signing secret **once** — store it securely.

**Request Body:**

```json
{
  "url": "https://example.com/hooks/bear",
  "event_types": ["job_created", "job_completed"],
  "description": "Production listener"
}
```

| Field         | Type     | Required | Description                                              |
| ------------- | -------- | -------- | -------------------------------------------------------- |
| `url`         | string   | ✓        | HTTPS endpoint to deliver events to                      |
| `event_types` | string[] | ✓        | Event types to deliver; `["*"]` for all                  |
| `description` | string   | —        | Human-readable label                                     |

**Response (201 Created):**

```json
{
  "id": "wh_01H...",
  "url": "https://example.com/hooks/bear",
  "event_types": ["job_created", "job_completed"],
  "description": "Production listener",
  "secret": "whsec_9f2c...",
  "active": true,
  "created_at": "2026-07-29T09:19:36.884Z"
}
```

#### `GET /webhooks/subscriptions`

List subscriptions (cursor paginated: `limit`, `cursor`, `order`). Secrets are never returned.

#### `GET /webhooks/subscriptions/:id`

Retrieve a single subscription (without secret).

#### `PATCH /webhooks/subscriptions/:id`

Update `url`, `event_types`, `description`, or `active`.

#### `DELETE /webhooks/subscriptions/:id`

Delete a subscription. Returns `204 No Content`.

#### `POST /webhooks/subscriptions/:id/rotate-secret`

Rotate the HMAC signing secret. The previous secret remains valid for a configurable grace period (`WEBHOOK_SECRET_GRACE_SEC`, default 24h) so in-flight deliveries verify.

**Response (200 OK):**

```json
{
  "id": "wh_01H...",
  "secret": "whsec_new...",
  "previous_secret_expires_at": "2026-07-30T09:19:36.884Z"
}
```

#### `GET /webhooks/subscriptions/:id/deliveries`

Delivery logs for a subscription (cursor paginated: `limit`, `cursor`, `order`). Filter with `status=success|failed|pending`.

**Response (200 OK):**

```json
{
  "data": [
    {
      "id": "dlv_01H...",
      "event_id": 7,
      "status": "failed",
      "attempts": 5,
      "response_status": 500,
      "error": "upstream 500",
      "next_retry_at": "2026-07-29T09:25:00.000Z",
      "created_at": "2026-07-29T09:19:36.884Z"
    }
  ],
  "next_cursor": null,
  "has_more": false
}
```

#### Failure Alerts

After `WEBHOOK_MAX_RETRIES` consecutive failed attempts (default `5`), the subscription is marked `degraded` and a `webhook.failing` alert is emitted (logged and, if configured, forwarded to `WEBHOOK_ALERT_URL`). Deliveries continue with exponential backoff until the subscription is disabled or succeeds.

---

### Webhook Signature Verification

Every delivery includes:

```
X-Bear-Signature: t=1690732000,v1=<hex hmac>
X-Bear-Event-Id: 7
X-Bear-Delivery-Id: dlv_01H...
```

`v1` is `HMAC-SHA256(secret, "<t>.<raw_body>")`. Verify against the **raw** request body before parsing JSON, and reject timestamps older than 5 minutes to prevent replay. During secret rotation, accept a signature matching either the current or previous secret.

**SDK helper:**

```typescript
import { verifyWebhookSignature } from "@bear/sdk";

const ok = verifyWebhookSignature({
  payload: rawBody, // string or Buffer, unparsed
  header: req.headers["x-bear-signature"],
  secrets: [process.env.BEAR_WEBHOOK_SECRET!],
  toleranceSec: 300,
});
```

**Manual verification (Node.js):**

```typescript
import crypto from "node:crypto";

function verify(rawBody: string, header: string, secrets: string[]) {
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.split("=") as [string, string]),
  );
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = crypto
    .createHmac("sha256", secrets[0])
    .update(`${t}.${rawBody}`)
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}
```

---

## Dashboard Security Model

The dashboard service (`server.ts`) serves the landing site and the `/app` static bundle, and exposes the mutating routes `/api/jobs/create`, `/api/dispute-job`, `/api/claim-refund`, and `/api/build/submit`. The following controls apply to all of them.

### Authentication: Bearer-Only

Tokens are issued by `POST /api/auth/token` and **must** be sent in the `Authorization` header:

```bash
Authorization: Bearer <token>
```

Cookie-based authentication is **not** supported. Requests that present a token only via a cookie (e.g. `Cookie: token=...`) are rejected with `401 Unauthorized`. This removes the ambient-authority vector that CSRF attacks rely on; clients must attach the header explicitly on every request.

### CSRF Protection for Mutating Routes

Because auth is bearer-only, cross-site form POSTs cannot carry credentials and are rejected. As defence in depth, mutating routes additionally enforce a **double-submit CSRF token**:

1. `GET /api/auth/csrf` issues a random token and sets it in a cookie with `SameSite=Strict; Secure; HttpOnly=false` (readable by `public/app.js`).
2. The client echoes the token in the `X-CSRF-Token` header on every mutating request.
3. The server rejects the request with `403 Forbidden` if the header is missing or does not match the cookie.

Cross-site form submissions cannot set custom headers, so they fail both the bearer check and the CSRF check.

### Security Headers and CSP

All responses include a consistent header set applied via `helmet`:

| Header                      | Value / Notes                                                        |
| --------------------------- | -------------------------------------------------------------------- |
| `Content-Security-Policy`   | Tailored to `public/app.js`; see allow-list below                    |
| `X-Content-Type-Options`    | `nosniff`                                                            |
| `X-Frame-Options`           | `DENY`                                                               |
| `Referrer-Policy`           | `no-referrer`                                                        |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`                                |

CSP allow-list (configurable via `CSP_CONNECT_SRC` / `CSP_SCRIPT_SRC`):

- `default-src 'self'`
- `script-src 'self'` (no inline scripts; `public/app.js` is served as an external file)
- `style-src 'self' 'unsafe-inline'` (inline styles used by the static bundle)
- `connect-src 'self' <STELLAR_RPC_URL> <allow-listed CDN origins>`
- `img-src 'self' data:`
- `frame-ancestors 'none'`

### Request Body Size Limits

Body parsing is bounded per route rather than by a single global limit:

| Route                 | Default limit | Env override             |
| --------------------- | ------------- | ------------------------ |
| Global (`express.json`) | `100kb`     | `BODY_LIMIT_DEFAULT`     |
| `/api/build/submit`   | `2mb`         | `BODY_LIMIT_BUILD_SUBMIT`|
| `/api/jobs/create`    | `256kb`       | `BODY_LIMIT_JOBS_CREATE` |

Requests exceeding the applicable limit are rejected with `413 Payload Too Large` before any handler runs.

### Rate Limiting Buckets

Rate limits are applied per-IP **and** per-wallet/per-token, with cost-weighted buckets for embedding-heavy routes. Each bucket is independent; a request is rejected if any bucket is exhausted.

| Bucket            | Key                    | Scope                                  | Default                |
| ----------------- | ---------------------- | -------------------------------------- | ---------------------- |
| `ip`              | client IP              | All routes                             | 120 req/min            |
| `wallet`          | authenticated wallet   | Mutating + wallet-scoped reads         | 30 req/min             |
| `token`           | bearer token hash      | All authenticated routes               | 60 req/min             |
| `cost:embeddings` | wallet                 | `/api/agents/match`, embedding routes  | 600 cost units/min     |

Embedding-heavy routes charge a cost per request (e.g. `10` units per `/api/agents/match` call) against the `cost:embeddings` bucket, so a single wallet cannot fan out across many IPs to bypass limits.

All `429 Too Many Requests` responses include a `Retry-After` header (seconds until the earliest bucket refills) plus `RateLimit-*` headers:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 12
RateLimit-Limit: 30
RateLimit-Remaining: 0
RateLimit-Reset: 1690732012
```

---

## Request/Response Conventions

### Request Headers

All endpoints accept standard HTTP headers:

```
Content-Type: application/json
User-Agent: <client-name>/<version>
X-Forwarded-For: <ip> (for logging behind proxies)
```

### Response Format

All responses are JSON with standard fields:

**Success (2xx):**

```json
{
  "status": "ok",
  "data": {}
}
```

**Error (4xx/5xx):**

All dashboard `/api` routes return a single structured error shape, produced by one Express error handler:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "invalid jobId",
    "requestId": "req_01H8Z9..."
  }
}
```

| Field       | Description                                                              |
| ----------- | ------------------------------------------------------------------------ |
| `code`      | Stable, machine-readable error code (see table below)                    |
| `message`   | Human-readable description (safe to display; never contains stack traces) |
| `requestId` | Correlation ID for the request; also returned in the `X-Request-Id` header |

**Error codes:**

| Code                | Status | Meaning                                          |
| ------------------- | ------ | ------------------------------------------------ |
| `VALIDATION_ERROR`  | 400    | Invalid or missing request parameters/body       |
| `UNAUTHORIZED`      | 401    | Missing or invalid credentials                   |
| `FORBIDDEN`         | 403    | Authenticated but not permitted                  |
| `NOT_FOUND`         | 404    | Resource does not exist                          |
| `CONFLICT`          | 409    | Request conflicts with current state             |
| `RATE_LIMITED`      | 429    | Rate limit exceeded                              |
| `UPSTREAM_ERROR`    | 502    | Dependency (RPC, indexer) returned an error      |
| `NOT_READY`         | 503    | Service not ready (see `/readyz`)                |
| `INTERNAL_ERROR`    | 500    | Unexpected server error                          |

Clients should branch on `code`, not on `message`. The dashboard client and `@bear/sdk` parse this shape and surface `requestId` in logs.

### Common Status Codes

| Code | Meaning                                |
| ---- | -------------------------------------- |
| 200  | Request succeeded                      |
| 400  | Bad request (validation error)         |
| 401  | Unauthorized (authentication required) |
| 403  | Forbidden (CSRF token missing/invalid) |
| 404  | Resource not found                     |
| 413  | Payload too large (body limit exceeded)|
| 422  | Unprocessable entity (malformed data)  |
| 429  | Too many requests (rate limited)       |
| 500  | Internal server error                  |
| 502  | Upstream dependency error              |
| 503  | Service not ready                      |

---

## Agent Communication Flow

### Typical Job Submission Flow

1. **Discover**: GET `/agents` from registry (port 4500)
2. **Select**: Choose an agent based on capability tags
3. **Submit**: POST `/job` to seller agent endpoint
4. **Poll**: Monitor job status via commerce contract (on-chain)
5. **Retrieve**: Fetch deliverable from URL submitted on-chain

### Agent Liveness

Agents maintain liveness by:

1. Sending heartbeats to registry every 60 seconds
2. Being removed from registry after 3 missed heartbeats (≈ 180 seconds)
3. Responding to `GET /health` for external health checks

---

## Environment Variables

### Registry Server

```bash
PORT=4500                          # Registry port (default: 4500)
REGISTRY_API_KEY=secret-key        # Optional: enable Bearer auth
```

### Seller Agents

```bash
SELLER_PORT=4501                   # Individual seller port
SELLER_SECRET=SBXXXXXXXX...        # Agent keypair secret
STELLAR_RPC_URL=https://...        # Stellar RPC endpoint
STELLAR_NETWORK_PASSPHRASE=...     # Network passphrase
GROQ_API_KEY=gsk_xxxxxxxx          # Groq API key for LLM
GROQ_MODEL=llama-3.3-70b-versatile # LLM model name
REGISTRY_URL=http://localhost:4500 # Registry service URL
REGISTRY_API_KEY=secret-key        # Registry auth token (if required)
PUBLIC_URL=http://localhost:4501   # Public URL for deliverables
```

### Indexer

```bash
INDEXER_PORT=4600                  # Indexer REST port (default: 4600)
INDEXER_API_KEY=secret-key         # Optional: enable Bearer auth
INDEXER_MAX_PAGE_SIZE=200          # Hard cap on `limit` for list endpoints
WEBHOOK_MAX_RETRIES=5              # Failures before `webhook.failing` alert
WEBHOOK_SECRET_GRACE_SEC=86400     # Previous secret validity after rotation
WEBHOOK_ALERT_URL=https://...      # Optional: forward failure alerts here
```

### Buyer Agent

```bash
BUYER_SECRET=SBXXXXXXXX...         # Buyer keypair secret
STELLAR_RPC_URL=https://...        # Stellar RPC endpoint
STELLAR_NETWORK_PASSPHRASE=...     # Network passphrase
```

### Dashboard

```bash
BODY_LIMIT_DEFAULT=100kb           # Global express.json limit
BODY_LIMIT_BUILD_SUBMIT=2mb        # Limit for /api/build/submit
BODY_LIMIT_JOBS_CREATE=256kb       # Limit for /api/jobs/create
CSP_CONNECT_SRC=https://...        # Extra connect-src origins (RPC/CDN)
CSP_SCRIPT_SRC=https://...         # Extra script-src origins
RATE_LIMIT_IP_PER_MIN=120          # Per-IP bucket
RATE_LIMIT_WALLET_PER_MIN=30       # Per-wallet bucket
RATE_LIMIT_TOKEN_PER_MIN=60        # Per-token bucket
RATE_LIMIT_EMBEDDING_COST_PER_MIN=600 # Cost-weighted embedding bucket
```

---

## Error Handling

### Validation Errors

```json
{
  "error": "invalid jobId"
}
```

### Rate Limiting

```json
{
  "error": "too many requests — rate limited (5/min/IP)"
}
```

Include `RateLimit-*` headers in response:

```
RateLimit-Limit: 5
RateLimit-Remaining: 3
RateLimit-Reset: 1690732000
```

### Service Unavailable

```json
{
  "error": {
    "code": "NOT_READY",
    "message": "service unavailable: rpc unreachable",
    "requestId": "req_01H8Z9..."
  }
}
```

---

## Dashboard Health & Readiness

The dashboard service exposes two probes:

### `GET /health` and `GET /healthz`

Shallow liveness probes. Return `200` with `{ "status": "ok" }` as long as the process is running. They do **not** check dependencies.

### `GET /readyz`

Deep readiness probe. Checks each dependency with a per-check timeout (default `2000ms`, configurable via `READYZ_TIMEOUT_MS`):

| Check     | Description                                                       |
| --------- | ----------------------------------------------------------------- |
| `rpc`     | Stellar RPC reachable (`getHealth`/`getLatestLedger`)             |
| `indexer` | Indexer database reachable and queryable                          |
| `model`   | LLM model provider configured and reachable                       |

**Response (200 OK — all checks pass):**

```json
{
  "status": "ready",
  "checks": {
    "rpc": { "ok": true, "latencyMs": 42 },
    "indexer": { "ok": true, "latencyMs": 7 },
    "model": { "ok": true, "latencyMs": 118 }
  }
}
```

**Response (503 Service Unavailable — any check fails):**

```json
{
  "status": "not_ready",
  "checks": {
    "rpc": { "ok": false, "latencyMs": 2000, "error": "timeout" },
    "indexer": { "ok": true, "latencyMs": 7 },
    "model": { "ok": true, "latencyMs": 118 }
  }
}
```

`/readyz` returns `503` whenever the RPC is unreachable (or any other check fails), so orchestrators stop routing traffic to the instance. Docker `HEALTHCHECK` and the compose `healthcheck` use `/readyz`; liveness probes should keep using `/healthz`.

```bash
curl -fsS http://localhost:4700/readyz || echo "not ready"
```

---

## Dashboard Admin API

### `GET /api/admin/audit`

Read the admin audit trail. Entries are appended to a JSONL log and indexed for efficient filtered reads.

**Query Parameters:**

| Parameter   | Type    | Default | Description                                                       |
| ----------- | ------- | ------- | ----------------------------------------------------------------- |
| `page`      | integer | `1`     | 1-based page number                                               |
| `pageSize`  | integer | `50`    | Page size, clamped to `1..200`                                    |
| `actor`     | string  | —       | Filter by actor (exact match)                                     |
| `action`    | string  | —       | Filter by action (exact match, e.g. `agent.deregister`)           |
| `from`      | string  | —       | Inclusive lower bound on timestamp (ISO-8601)                     |
| `to`        | string  | —       | Inclusive upper bound on timestamp (ISO-8601)                     |

**Response (200 OK):**

```json
{
  "data": [
    {
      "id": "aud_01H...",
      "timestamp": "2026-07-29T09:19:36.884Z",
      "actor": "admin@example.com",
      "action": "agent.deregister",
      "target": "seller-webbuilder",
      "requestId": "req_01H8Z9..."
    }
  ],
  "page": 1,
  "pageSize": 50,
  "total": 1,
  "hasMore": false
}
```

**Error Responses:**

| Status | Description                                        |
| ------ | -------------------------------------------------- |
| 400    | Invalid `page`, `pageSize`, `from`, or `to`        |
| 401    | Unauthorized                                       |

**Performance:** the JSONL audit log is indexed by actor, action, and timestamp, so filtered queries over 100k entries return in well under 100ms (see `docs/audit-performance.md`).

---

## Testing & Examples

### Using cURL

```bash
# List all agents
curl http://localhost:4500/agents

# Get specific agent
curl http://localhost:4500/agents/seller-webbuilder

# Submit a web build job
curl -X POST http://localhost:4501/job \
  -H "Content-Type: application/json" \
  -d '{
    "jobId": "1",
    "task": "Build a landing page"
  }'

# Health check
curl http://localhost:4501/health
```

### Using JavaScript/TypeScript

```typescript
import fetch from "node-fetch";

// List agents
const agents = await fetch("http://localhost:4500/agents").then((r) => r.json());

// Submit a job
const response = await fetch("http://localhost:4501/job", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jobId: "1",
    task: "Build a landing page",
    buildSpec: { theme: "dark" },
  }),
});

const result = await response.json();
console.log(result); // { status: "accepted", jobId: "1" }
```

---

## Changelog

### v1.3 (2026-07-29)

- Added `scoring_version` to the `/agents/:id/reputation` response
- Documented `indexer reputation --recompute` for deterministic, version-stamped reputation recalculation from raw events

### v1.2 (2026-07-29)

- Documented dashboard security model: bearer-only auth (cookie auth rejected)
- CSRF double-submit token (`X-CSRF-Token`) required on mutating routes
- Security headers via `helmet` with a CSP allow-list for `public/app.js` and RPC/CDN origins
- Per-route request body size limits with `413 Payload Too Large`
- Per-IP, per-wallet, per-token, and cost-weighted rate-limit buckets; `429` includes `Retry-After`

### v1.1 (2026-07-29)

- Added Indexer REST API: `/events`, `/agents/:id/reputation`, `/jobs/:id`
- Cursor pagination with bounded page sizes on all list endpoints
- Webhook subscription CRUD, HMAC secret rotation, and delivery logs
- Webhook signature verification helper and failure alerts after N retries

### v1.0 (2026-07-29)

- Initial API documentation
- Registry endpoints: `/agents`, `/agents/:id`, `/heartbeat`, `/health`
- Seller agent endpoints: `/job`, `/health`, `/`
- All four seller agents documented: webbuilder, copywriter, namer, researcher
- Rate limiting and error handling documented
- Environment configuration reference

---

## Support

For issues or questions:

- **Registry**: Check logs at registry startup
- **Agents**: Check individual agent logs (stdout)
- **Contracts**: View transactions at https://stellar.expert/explorer/testnet/

See [BEAR-PROTOCOL-GUIDE.md](../BEAR-PROTOCOL-GUIDE.md) for protocol details.
