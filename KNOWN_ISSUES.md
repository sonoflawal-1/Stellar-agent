# Known Issues

## (None currently)

x402 micropayment settlement on testnet works when using Circle's canonical testnet USDC SAC (`CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`).

The OpenZeppelin facilitator at `https://channels.openzeppelin.com/x402/testnet` only accepts real USDC. Custom SAC tokens are rejected at settlement.

### Verified working config
```
USDC_TOKEN_CONTRACT=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
X402_FACILITATOR_URL=https://channels.openzeppelin.com/x402/testnet
X402_FACILITATOR_API_KEY=<your-api-key>
```
Generate a testnet key: `curl https://channels.openzeppelin.com/testnet/gen`

### Migration Path to Mainnet
When deploying to mainnet:
1. Use real USDC (Circle's mainnet SAC)
2. Update facilitator URL to `https://channels.openzeppelin.com/x402/mainnet` or run your own facilitator
3. Deploy contracts with mainnet addresses in `deployments/mainnet.json`
