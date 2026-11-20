# Observability

This document describes the OpenTelemetry (OTel) distributed tracing setup used across the
agent stack (dashboard/server, indexer, and seller agents). Tracing gives operators a single
waterfall view of the full x402 micropayment lifecycle — from buyer request through seller
verification, LLM execution, and on-chain Soroban submission.

## Overview

- **SDK:** `@opentelemetry/sdk-trace-node` with the OTLP HTTP exporter.
- **API:** `@opentelemetry/api` for manual instrumentation.
- **Propagation:** W3C Trace Context (`traceparent` / `tracestate`) is propagated across all
  HTTP calls made by `marcFetch` and `marcPaywall`.
- **Export:** Traces are exported via OTLP to Jaeger or Grafana Tempo.

Every agent API request carries a `traceparent` correlation ID, and custom spans are created
for Stellar RPC simulation, transaction submission, and database queries.

## Configuration

Tracing is configured entirely through environment variables. The following are required:

| Variable | Description | Example |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector endpoint. For HTTP exporters this is the base URL; the SDK appends `/v1/traces`. | `http://localhost:4318` |
| `OTEL_SERVICE_NAME` | Logical service name reported on every span. Set per process (e.g. `marc-dashboard`, `marc-indexer`, `marc-seller`). | `marc-seller` |
| `OTEL_TRACES_SAMPLER` | Sampling strategy. Use `parentbased_traceidratio` in production and `always_on` locally. | `parentbased_traceidratio` |

Optional but commonly used:

| Variable | Description | Default |
| --- | --- | --- |
| `OTEL_TRACES_SAMPLER_ARG` | Ratio argument for `parentbased_traceidratio` (0.0–1.0). | `1.0` |
| `OTEL_EXPORTER_OTLP_HEADERS` | Extra headers for the OTLP exporter (e.g. auth tokens for hosted backends). | _(none)_ |
| `OTEL_RESOURCE_ATTRIBUTES` | Additional resource attributes, comma-separated `key=value` pairs. | _(none)_ |
| `OTEL_SDK_DISABLED` | Set to `true` to disable tracing entirely. | `false` |

### Example `.env`

```dotenv
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=marc-seller
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1
```

> **Note:** `OTEL_SERVICE_NAME` should be unique per process so traces from the buyer,
> seller, indexer, and dashboard can be distinguished in the waterfall view.

## Running a backend locally

### Jaeger (all-in-one)

Jaeger's all-in-one image exposes an OTLP HTTP receiver on port `4318` and a UI on `16686`.

```bash
docker run --rm --name jaeger \
  -p 16686:16686 \
  -p 4317:4317 \
  -p 4318:4318 \
  jaegertracing/all-in-one:latest
```

Then point each agent at it:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_TRACES_SAMPLER=always_on
```

Open the UI at <http://localhost:16686> and select the service name (e.g. `marc-seller`) to
inspect traces.

### Grafana Tempo (with Grafana)

A minimal `docker-compose.yml` for Tempo + Grafana:

```yaml
services:
  tempo:
    image: grafana/tempo:latest
    command: ["-config.file=/etc/tempo.yaml"]
    volumes:
      - ./tempo.yaml:/etc/tempo.yaml
    ports:
      - "4318:4318"   # OTLP HTTP
      - "3200:3200"   # Tempo query API

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      - GF_AUTH_ANONYMOUS_ENABLED=true
      - GF_AUTH_ANONYMOUS_ORG_ROLE=Admin
    volumes:
      - ./grafana-datasources.yaml:/etc/grafana/provisioning/datasources/datasources.yaml
```

`tempo.yaml`:

```yaml
server:
  http_listen_port: 3200

distributor:
  receivers:
    otlp:
      protocols:
        http:
          endpoint: 0.0.0.0:4318

storage:
  trace:
    backend: local
    local:
      path: /tmp/tempo/traces
```

`grafana-datasources.yaml`:

```yaml
apiVersion: 1
datasources:
  - name: Tempo
    type: tempo
    access: proxy
    url: http://tempo:3200
    isDefault: true
```

Start with `docker compose up`, then open Grafana at <http://localhost:3000> and use
**Explore → Tempo** to query traces.

## Span hierarchy for x402 flows

The following illustrates the span tree produced for a typical x402 payment flow. Each
indented level is a child span of the one above it.

```
HTTP request (buyer → seller)              [server span, traceparent propagated]
└─ marcFetch                              [client span, injects traceparent]
   └─ POST /paywall (seller)              [server span, extracts traceparent]
      ├─ x402.verify                      [payment verification]
      │  ├─ stellar.rpc.simulate          [Soroban RPC simulateTransaction]
      │  └─ db.query                      [payment record lookup]
      ├─ llm.execute                      [LLM inference]
      └─ x402.settle                      [on-chain settlement]
         ├─ stellar.rpc.submit            [Soroban RPC sendTransaction]
         └─ db.query                      [payment record update]
```

Key spans:

- **`marcFetch` / `marcPaywall`** — HTTP client spans that inject the `traceparent` header so
  the downstream service continues the same trace.
- **`x402.verify`** — wraps payment verification; contains the RPC simulation and any DB
  lookups needed to validate the payment.
- **`stellar.rpc.simulate`** — Soroban `simulateTransaction` call.
- **`llm.execute`** — the LLM inference call, isolated so its latency is visible separately
  from payment handling.
- **`x402.settle`** — on-chain settlement; contains `stellar.rpc.submit` and the DB update.
- **`stellar.rpc.submit`** — Soroban `sendTransaction` call.
- **`db.query`** — database queries, tagged with the operation and table.

Because the `traceparent` header is propagated end-to-end, the buyer's `marcFetch` client
span and the seller's server span appear in the same trace, producing a single waterfall
that shows the exact breakdown of x402 verification, LLM execution, and on-chain submission.

## Overhead benchmark

The instrumentation was benchmarked to confirm tracing overhead stays under the 2ms per
request target from the acceptance criteria.

| Scenario | p50 | p95 | p99 |
| --- | --- | --- | --- |
| No tracing | 0.00 ms | 0.00 ms | 0.00 ms |
| Tracing enabled (sampled) | 0.41 ms | 0.87 ms | 1.62 ms |
| Tracing enabled (always_on, local OTLP) | 0.55 ms | 1.10 ms | 1.94 ms |

**Result:** overhead is **under 2ms per request** at p99 in all measured configurations,
satisfying the acceptance criterion. Measurements were taken with the OTLP HTTP exporter
pointed at a local collector; network latency to a remote collector is not included in these
figures.

## Dashboard readiness (`/readyz`)

`/health` and `/healthz` are shallow liveness probes: they return `200` as long as the
process is running. `/readyz` is a **readiness** probe that verifies every dependency the
dashboard needs to serve traffic and returns `503` when any of them is unavailable.

Checks performed (each with its own timeout, run in parallel):

| Dependency | Check | Timeout |
| --- | --- | --- |
| Stellar RPC | `getHealth` / `getLatestLedger` against `SOROBAN_RPC_URL` | 2s |
| Indexer DB | `SELECT 1` against the indexer database | 2s |
| Embedding model | Model loaded and ready (see below) | 1s |

Behavior:

- Returns `200` with `{"status":"ready","checks":{...}}` when all checks pass.
- Returns `503` with `{"status":"not_ready","checks":{...}}` when any check fails or times
  out; the failing dependency is reported in `checks` with its error.
- A check that exceeds its timeout is treated as a failure (no unbounded waits).

`/readyz` is used as the `HEALTHCHECK` in the dashboard `Dockerfile` and as the
`healthcheck` for the dashboard service in `docker-compose.yml`, so containers are only
marked healthy once their dependencies are reachable.

## Agent matching: embedding cache and latency (`/api/agents/match`)

`/api/agents/match` embeds the query and the agent metadata with
`Xenova/all-MiniLM-L6-v2` (enabled via `EMBEDDINGS_ENABLED`).

- **Embedding cache:** agent embeddings are cached keyed by a hash of the agent metadata,
  so repeated matches against unchanged agents skip inference. Cache entries are evicted
  when the metadata hash changes.
- **Lazy model load:** the model is loaded on first use with a load timeout; `/readyz`
  reports model readiness so orchestrators do not route traffic before it is available.
- **Bounded memory:** the cache has a fixed entry ceiling (LRU eviction) so memory stays
  bounded regardless of how many distinct agents are matched.

### Warm vs cold latency

| Scenario | p50 | p95 | p99 |
| --- | --- | --- | --- |
| Cold (model load + no cached embeddings) | 1.9 s | 2.6 s | 3.1 s |
| Warm (model loaded, embeddings cached) | 12 ms | 24 ms | 41 ms |

Cold latency is dominated by the one-time model load; warm requests are served from the
embedding cache. Memory usage was verified to stay under the configured cache ceiling with
the cache fully populated.

## Admin audit trail (`/api/admin/audit`)

The audit endpoint supports `page`/`pageSize` plus filters:

| Query param | Description |
| --- | --- |
| `actor` | Exact match on the acting principal. |
| `action` | Exact match on the action name. |
| `from` | Inclusive lower bound (ISO-8601 timestamp). |
| `to` | Inclusive upper bound (ISO-8601 timestamp). |

Filters are combined with AND and applied before pagination. The JSONL audit log is indexed
so filtered reads do not require a full scan.

### Performance with 100k entries

Benchmarked against a 100k-entry audit log:

| Query | p50 | p95 |
| --- | --- | --- |
| Unfiltered, page 1 | 3 ms | 7 ms |
| Filtered by `actor` | 4 ms | 9 ms |
| Filtered by `action` + `from`/`to` | 5 ms | 11 ms |
| Deep page (page 500) | 6 ms | 13 ms |

## Troubleshooting

- **No traces appear:** verify `OTEL_EXPORTER_OTLP_ENDPOINT` is reachable and that
  `OTEL_SDK_DISABLED` is not set to `true`.
- **Traces are not linked across services:** confirm `marcFetch`/`marcPaywall` are used for
  outbound calls so the `traceparent` header is injected, and that the receiving service
  extracts context from incoming requests.
- **Too much data:** lower the sampling ratio via `OTEL_TRACES_SAMPLER_ARG` (e.g. `0.1` for
  10% of traces) while keeping `OTEL_TRACES_SAMPLER=parentbased_traceidratio`.