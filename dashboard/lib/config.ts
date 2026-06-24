import "dotenv/config";
import { Keypair } from "@stellar/stellar-sdk";
import { TESTNET, type MarcConfig } from "marc-stellar-sdk";

export const cfg: MarcConfig = {
  rpcUrl: process.env.STELLAR_RPC_URL ?? TESTNET.rpcUrl,
  networkPassphrase:
    process.env.STELLAR_NETWORK_PASSPHRASE ?? TESTNET.networkPassphrase,
  identityContract:
    process.env.AGENT_IDENTITY_CONTRACT || TESTNET.identityContract,
  commerceContract:
    process.env.AGENTIC_COMMERCE_CONTRACT || TESTNET.commerceContract,
  usdcToken: process.env.USDC_TOKEN_CONTRACT || TESTNET.usdcToken,
};

export const DEMO_MODE = process.env.DEMO_MODE === "true";

// In DEMO_MODE, use fixed test keypairs so no secrets are required.
// These are well-known Stellar testnet keys safe for local demos only.
const DEMO_BUYER_SECRET  = "SCZANGBA5RLBRQ3OYQRRBQ5U6MBMHXGZIQN4VJFEQD2C7T3VNJUYMUUZ";
const DEMO_SELLER_SECRET = "SCXDQCDQZTNQXDEHYB4XJRTMHRDGFXQ3GGXFZ7MFGPB4MFKWQ4VBNK3";

export const buyerKeypair = DEMO_MODE
  ? Keypair.fromSecret(DEMO_BUYER_SECRET)
  : Keypair.fromSecret(process.env.BUYER_SECRET!);

export const sellerKeypair = DEMO_MODE
  ? Keypair.fromSecret(DEMO_SELLER_SECRET)
  : Keypair.fromSecret(process.env.SELLER_SECRET!);

export function getKeypair(wallet: string): Keypair {
  if (wallet === "buyer") return buyerKeypair;
  if (wallet === "seller") return sellerKeypair;
  throw new Error(`Unknown wallet: ${wallet}`);
}
