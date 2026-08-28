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

```json
{
  "error": "Human-readable error message"
}
```

### Common Status Codes

| Code | Meaning                                |
| ---- | -------------------------------------- |
| 200  | Request succeeded                      |
| 400  | Bad request (validation error)         |
| 401  | Unauthorized (authentication required) |
| 404  | Resource not found                     |
| 422  | Unprocessable entity (malformed data)  |
| 429  | Too many requests (rate limited)       |
| 500  | Internal server error                  |

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

### Buyer Agent

```bash
BUYER_SECRET=SBXXXXXXXX...         # Buyer keypair secret
STELLAR_RPC_URL=https://...        # Stellar RPC endpoint
STELLAR_NETWORK_PASSPHRASE=...     # Network passphrase
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
  "error": "service unavailable"
}
```

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
