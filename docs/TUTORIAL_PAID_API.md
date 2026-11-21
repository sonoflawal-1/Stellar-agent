# Paid API with marcPaywall (Express and Hono)

End-to-end guide to monetise an HTTP API with x402 on Stellar testnet.

## Prerequisites

- Node 20+, funded testnet wallet
- `npm ci` in repo root and `sdk/`
- Testnet contracts from [README](../README.md#live-testnet-contracts)

## Express

```bash
cd sdk
npm run build
node --import tsx -e "
import express from 'express';
import { createMarcPaywallExpress } from './dist/marcPaywall.js';
const app = express();
app.use(createMarcPaywallExpress({ amount: '1000000', asset: process.env.USDC_CONTRACT }));
app.get('/api/quote', (req, res) => res.json({ quote: 'hello' }));
app.listen(3400, () => console.log('http://localhost:3400'));
"
```

Pay with `curl` and the `X-PAYMENT` header per [sdk/README.md](../sdk/README.md#x402).

## Hono

Same pattern with `createMarcPaywallHono` from `marcPaywallHono.ts` (see SDK tests for options).

## Verify on testnet

1. Set `STELLAR_NETWORK=testnet` and contract env vars from `deployments/testnet.json`.
2. Call the route without payment → expect HTTP 402 with payment requirements.
3. Submit a signed payment header → expect HTTP 200 and JSON body.

Screenshots: capture 402 response in browser Network tab and successful paid response.