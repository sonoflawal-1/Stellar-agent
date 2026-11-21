import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { IdentityClient, TESTNET, type MarcConfig } from "marc-stellar-sdk";

export interface DeregisterResult {
  onChainDeregistered: boolean;
  agentId: bigint | null;
  registryNotified: boolean;
  agentNameOrId?: string;
}

/**
 * Deregisters a seller agent from the on-chain agent_identity contract
 * and sends an unregister notification to the local/remote agent registry.
 */
export async function deregister(): Promise<DeregisterResult> {
  const secretKey = process.env.SELLER_SECRET || process.env.SECRET_KEY;
  if (!secretKey) {
    console.error("[deregister] Error: SELLER_SECRET (or SECRET_KEY) environment variable is required.");
    process.exit(1);
  }

  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(secretKey.trim());
  } catch (err) {
    console.error(`[deregister] Error: Invalid Stellar secret key: ${(err as Error).message}`);
    process.exit(1);
  }

  const ownerAddress = keypair.publicKey();
  console.log(`[deregister] Initializing graceful shutdown for seller (owner: ${ownerAddress})...`);

  // Build Marc configuration
  const cfg: MarcConfig = {
    rpcUrl: process.env.STELLAR_RPC_URL ?? TESTNET.rpcUrl,
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? TESTNET.networkPassphrase,
    identityContract: process.env.AGENT_IDENTITY_CONTRACT || TESTNET.identityContract,
    commerceContract: process.env.AGENTIC_COMMERCE_CONTRACT || TESTNET.commerceContract,
    usdcToken: process.env.USDC_TOKEN_CONTRACT || TESTNET.usdcToken,
    onTx: (hash) =>
      console.log(`[tx] ${hash} → https://stellar.expert/explorer/testnet/tx/${hash}`),
  };

  const identity = new IdentityClient(cfg);

  // 1. Look up agent on-chain
  console.log(`[deregister] Querying on-chain identity contract for owner ${ownerAddress}...`);
  let onChainId: bigint | null = null;
  try {
    onChainId = await identity.agentOf(ownerAddress);
  } catch (err) {
    console.warn(`[deregister] Warning: Could not reach Soroban RPC (${(err as Error).message}).`);
  }

  let onChainDeregistered = false;
  if (onChainId === null) {
    console.log(`[deregister] No active on-chain identity registered for ${ownerAddress}.`);
  } else {
    console.log(`[deregister] Found on-chain agent #${onChainId}. Submitting deregister transaction...`);
    try {
      await identity.deregister(keypair, onChainId);
      console.log(`[deregister] Successfully deregistered agent #${onChainId} on-chain. Owner slot freed.`);
      onChainDeregistered = true;
    } catch (err) {
      console.error(`[deregister] Error deregistering agent #${onChainId} on-chain: ${(err as Error).message}`);
      throw err;
    }
  }

  // 2. Discover manifest / registry agent ID
  let registryAgentId: string | null = null;
  const manifestPath = path.join(process.cwd(), "agent.json");
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (typeof manifest.id === "string" && manifest.id.trim()) {
        registryAgentId = manifest.id.trim();
      }
    } catch (err) {
      console.warn(`[deregister] Note: Could not parse agent.json: ${(err as Error).message}`);
    }
  }

  if (!registryAgentId) {
    const cwdName = path.basename(process.cwd());
    if (cwdName.startsWith("seller-")) {
      registryAgentId = cwdName;
    }
  }

  // 3. Notify registry server if online
  let registryNotified = false;
  if (registryAgentId) {
    const registryUrl = (process.env.REGISTRY_URL ?? "http://localhost:4500").replace(/\/+$/, "");
    const registryApiKey = process.env.REGISTRY_API_KEY?.trim();

    try {
      console.log(`[deregister] Notifying registry service at ${registryUrl}/agents/${registryAgentId}...`);
      const headers: Record<string, string> = {};
      if (registryApiKey) {
        headers.authorization = `Bearer ${registryApiKey}`;
      }

      const res = await fetch(`${registryUrl}/agents/${registryAgentId}`, {
        method: "DELETE",
        headers,
      });

      if (res.ok) {
        console.log(`[deregister] Registry server confirmed unregistration of agent "${registryAgentId}".`);
        registryNotified = true;
      } else if (res.status === 404) {
        console.log(`[deregister] Registry server reported agent "${registryAgentId}" was not active.`);
      } else {
        console.warn(`[deregister] Registry server responded with HTTP status ${res.status}.`);
      }
    } catch (err) {
      console.warn(`[deregister] Registry server offline or unreachable (${(err as Error).message}). Continuing shutdown.`);
    }
  }

  console.log(`[deregister] Graceful shutdown sequence completed.`);
  return {
    onChainDeregistered,
    agentId: onChainId,
    registryNotified,
    agentNameOrId: registryAgentId ?? undefined,
  };
}

// Execute when invoked directly from CLI
const isDirectExecution =
  process.argv[1] &&
  (path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) ||
   process.argv[1].endsWith("deregister.ts") ||
   process.argv[1].endsWith("deregister.js"));

if (isDirectExecution) {
  deregister()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[deregister] Fatal shutdown failure:", err.message);
      process.exit(1);
    });
}
