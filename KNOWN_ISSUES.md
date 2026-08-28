# Known Issues

## x402 Micropayment Settlement on Testnet

**Status:** Documented workaround available — use Circle's canonical testnet USDC SAC.

### Root Cause

The OpenZeppelin facilitator at `https://channels.openzeppelin.com/x402/testnet` only settles
**real USDC** (Circle's canonical Stellar Asset Contract). Custom SAC tokens such as the
previously-used MUSD (`CCWHIM2BEG5OEDNLQ5DBQE2KY5TZMVN627HQ6NLUJHWP5GQDBO5SXLBS`) are
rejected at settlement with `"Payment verification failed"`.

Additionally, the older facilitator endpoints are unreachable:

- `facilitator.stellar-x402.org` — unreachable
- `facilitator.x402.org` — unreachable

### Resolution

Switch to Circle's canonical testnet USDC SAC and the OpenZeppelin hosted testnet facilitator:

```env
USDC_TOKEN_CONTRACT=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
X402_FACILITATOR_URL=https://channels.openzeppelin.com/x402/testnet
X402_FACILITATOR_API_KEY=<your-api-key>
```

Generate a free testnet API key:

```bash
curl https://channels.openzeppelin.com/testnet/gen
```

Wire the key into `demo/.env` (copy from `demo/.env.example`). The `marcPaywall` and `marcFetch`
SDK functions already default to the correct facilitator URL — you only need to supply the API key.

### Protocol Flow

The full x402 protocol works end-to-end on testnet:

1. Client calls seller endpoint → receives HTTP 402 with payment requirements
2. `marcFetch` builds and signs a Stellar payment transaction
3. Client retries with `X-Payment` header containing the signed transaction
4. `marcPaywall` verifies payment via the facilitator and grants access

Settlement only fails when a non-USDC token is used or the API key is missing.

### Mainnet Migration Path

When deploying to mainnet:

1. Use real USDC (Circle's mainnet SAC on Stellar)
2. Update the facilitator URL to `https://channels.openzeppelin.com/x402/mainnet`
   or self-host the [x402 facilitator](https://github.com/x402/x402)
3. Update contract addresses in `deployments/mainnet.json`
4. Update `STELLAR_RPC_URL` to `https://soroban-rpc.mainnet.stellar.org`
5. Update `STELLAR_NETWORK_PASSPHRASE` to `Public Global Stellar Network ; September 2015`

See [`docs/MAINNET_MIGRATION.md`](./docs/MAINNET_MIGRATION.md) for the full migration and
security audit checklist.
