# Indexer

Soroban event indexer backed by PostgreSQL.

## Setup

```bash
cd indexer
npm ci
export DATABASE_URL=postgres://marc:marc_dev_password@localhost:5432/marc_indexer
npm run dev
```

## Tests

```bash
npm test
```

Mock RPC in tests uses fixtures in `src/poller.test.ts`. To add a new event type, extend `src/events.ts` and add a migration under `migrations/`.