# Dashboard

Express server + static SPA for jobs, agents, and SEP-0010 auth.

## Setup

```bash
cd dashboard
npm ci
cp ../.env.example .env   # set JWT_SECRET, SOROBAN_RPC_URL, contract IDs
npm run dev
```

## Tests

```bash
npm test
```

Point `SOROBAN_RPC_URL` at testnet or local standalone from `docker compose`. Auth flows are covered in `lib/authChallenges.test.ts`.