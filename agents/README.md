# Agents

Node workers: registry, buyer TUI, and seller agents.

## Run locally

```bash
docker compose up registry seller-webbuilder
# or: npm run dev in agents/registry after root npm ci
```

## Tests

```bash
npm test --workspace agents/registry
```

Set contract IDs from `deployments/testnet.json` or `.env.docker` after local `init`.