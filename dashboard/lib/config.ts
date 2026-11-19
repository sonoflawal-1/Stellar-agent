import "dotenv/config";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { TESTNET, type MarcConfig } from "marc-stellar-sdk";
import { z } from "zod";

export type NetworkId = "testnet" | "futurenet" | "mainnet";

export interface NetworkPreset {
  id: NetworkId;
  label: string;
  rpcUrl: string;
  networkPassphrase: string;
  identityContract: string;
  commerceContract: string;
  usdcToken: string;
  /** True when the network uses real funds (e.g. real USDC). */
  isMainnet: boolean;
}

export const NETWORKS: Record<NetworkId, NetworkPreset> = {
  testnet: {
    id: "testnet",
    label: "Testnet",
    rpcUrl: TESTNET.rpcUrl,
    networkPassphrase: TESTNET.networkPassphrase,
    identityContract: TESTNET.identityContract,
    commerceContract: TESTNET.commerceContract,
    usdcToken: TESTNET.usdcToken,
    isMainnet: false,
  },
  futurenet: {
    id: "futurenet",
    label: "Futurenet",
    rpcUrl: "https://rpc-futurenet.stellar.org",
    networkPassphrase: "Test SDF Future Network ; October 2022",
    identityContract: process.env.FUTURENET_AGENT_IDENTITY_CONTRACT ?? "",
    commerceContract: process.env.FUTURENET_AGENTIC_COMMERCE_CONTRACT ?? "",
    usdcToken: process.env.FUTURENET_USDC_TOKEN_CONTRACT ?? "",
    isMainnet: false,
  },
  mainnet: {
    id: "mainnet",
    label: "Mainnet",
    rpcUrl: "https://mainnet.sorobanrpc.com",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    identityContract: process.env.MAINNET_AGENT_IDENTITY_CONTRACT ?? "",
    commerceContract: process.env.MAINNET_AGENTIC_COMMERCE_CONTRACT ?? "",
    usdcToken:
      process.env.MAINNET_USDC_TOKEN_CONTRACT ??
      "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    isMainnet: true,
  },
};

export const DEFAULT_NETWORK_ID: NetworkId = "testnet";

export function isNetworkId(value: unknown): value is NetworkId {
  return value === "testnet" || value === "futurenet" || value === "mainnet";
}

/**
 * Resolve the active network id from an explicit value, the STELLAR_NETWORK
 * env var, or the default (testnet).
 */
export function resolveNetworkId(explicit?: string | null): NetworkId {
  if (isNetworkId(explicit)) return explicit;
  const fromEnv = process.env.STELLAR_NETWORK?.toLowerCase();
  if (isNetworkId(fromEnv)) return fromEnv;
  return DEFAULT_NETWORK_ID;
}

export function getNetworkPreset(networkId?: string | null): NetworkPreset {
  return NETWORKS[resolveNetworkId(networkId)];
}

export const activeNetwork: NetworkPreset = getNetworkPreset();

export const rpcUrls = [
  process.env.STELLAR_RPC_URL,
  ...(process.env.STELLAR_RPC_FALLBACK_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean),
  activeNetwork.rpcUrl,
  TESTNET.rpcUrl,
].filter((url, index, list) => Boolean(url) && list.indexOf(url) === index);

export interface RpcHealthResult {
  url: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface RpcHealthReport {
  ok: boolean;
  checkedAt: string;
  results: RpcHealthResult[];
}

const RPC_HEALTH_TIMEOUT_MS = 5_000;

async function probeRpc(url: string): Promise<RpcHealthResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth", params: [] }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return { url, ok: false, latencyMs, error: `HTTP ${response.status}` };
    }
    const payload = (await response.json().catch(() => null)) as
      | { result?: { status?: string }; error?: { message?: string } }
      | null;
    if (payload?.error) {
      return { url, ok: false, latencyMs, error: payload.error.message ?? "RPC error" };
    }
    const status = payload?.result?.status;
    const ok = status === undefined || status === "healthy";
    return { url, ok, latencyMs, error: ok ? undefined : `status: ${status}` };
  } catch (error) {
    return {
      url,
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probes every configured RPC node (primary first, then fallbacks) and reports
 * availability so the dashboard can surface offline/degraded states.
 */
export async function checkRpcHealth(): Promise<RpcHealthReport> {
  const results = await Promise.all(rpcUrls.map((url) => probeRpc(url)));
  return {
    ok: results.some((result) => result.ok),
    checkedAt: new Date().toISOString(),
    results,
  };
}

export const cfg: MarcConfig = {
  rpcUrl: rpcUrls[0],
  networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? activeNetwork.networkPassphrase,
  identityContract: process.env.AGENT_IDENTITY_CONTRACT || activeNetwork.identityContract,
  commerceContract: process.env.AGENTIC_COMMERCE_CONTRACT || activeNetwork.commerceContract,
  usdcToken: process.env.USDC_TOKEN_CONTRACT || activeNetwork.usdcToken,
};

/**
 * Build a MarcConfig for a specific network, honoring env-var overrides.
 */
export function getConfigForNetwork(networkId?: string | null): MarcConfig {
  const preset = getNetworkPreset(networkId);
  return {
    rpcUrl: process.env.STELLAR_RPC_URL || preset.rpcUrl,
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? preset.networkPassphrase,
    identityContract: process.env.AGENT_IDENTITY_CONTRACT || preset.identityContract,
    commerceContract: process.env.AGENTIC_COMMERCE_CONTRACT || preset.commerceContract,
    usdcToken: process.env.USDC_TOKEN_CONTRACT || preset.usdcToken,
  };
}

export const DEMO_MODE = process.env.DEMO_MODE === "true";

// Embedding model (Xenova/all-MiniLM-L6-v2) tuning for /api/agents/match.
// - EMBEDDINGS_ENABLED: enable semantic agent matching (default: true).
// - EMBEDDING_CACHE_MAX: maximum number of cached agent embeddings keyed by
//   metadata hash; bounds memory of the vector search (default: 1000).
// - EMBEDDING_LOAD_TIMEOUT_MS: max time to wait for the lazy model load before
//   reporting the model as unavailable (default: 30000).
export const embeddingsEnabled = process.env.EMBEDDINGS_ENABLED !== "false";
export const embeddingCacheMax = Math.max(
  0,
  Number(process.env.EMBEDDING_CACHE_MAX ?? 1000) || 0,
);
export const embeddingLoadTimeoutMs = Math.max(
  1,
  Number(process.env.EMBEDDING_LOAD_TIMEOUT_MS ?? 30_000) || 30_000,
);

// Readiness (/readyz) dependency check timeout in milliseconds. Each check
// (RPC, indexer DB, embedding model) is bounded by this budget (default: 5000).
export const readyzTimeoutMs = Math.max(
  1,
  Number(process.env.READYZ_TIMEOUT_MS ?? 5_000) || 5_000,
);

// Audit log storage (SQLite, WAL mode) with retention and JSONL migration.
// - AUDIT_DB_PATH: path to the SQLite database file (default: data/audit.sqlite).
// - AUDIT_RETENTION_DAYS: entries older than this many days are pruned by the
//   retention job (default: 30). Set to 0 to disable pruning.
// - AUDIT_LEGACY_JSONL_DIR: directory containing legacy JSONL audit files that
//   are imported on startup (default: data/audit). Imported files are renamed
//   with a `.migrated` suffix so migration runs only once.
export const auditDbPath = process.env.AUDIT_DB_PATH ?? "data/audit.sqlite";
export const auditRetentionDays = Math.max(
  0,
  Number(process.env.AUDIT_RETENTION_DAYS ?? 30) || 0,
);
export const auditLegacyJsonlDir = process.env.AUDIT_LEGACY_JSONL_DIR ?? "data/audit";

// SEP-0010 (Stellar Web Authentication) configuration.
// The server signing keypair signs challenge transactions; wallets verify the
// home_domain and server signature before prompting the user to sign.
export const homeDomain = process.env.DASHBOARD_HOME_DOMAIN ?? "localhost";

export const serverSigningKeypair = Keypair.fromSecret(
  process.env.DASHBOARD_SIGNING_SECRET || DEMO_BUYER_SECRET,
);

// Secret used to sign/verify dashboard session JWTs (24h expiration).
export const jwtSecret = process.env.DASHBOARD_JWT_SECRET || "demo-dashboard-jwt-secret";

// Challenge transaction validity window (seconds) and JWT lifetime (seconds).
export const challengeTimeoutSeconds = Number(process.env.DASHBOARD_CHALLENGE_TIMEOUT ?? 300);
export const jwtExpiresInSeconds = Number(process.env.DASHBOARD_JWT_EXPIRES_IN ?? 24 * 60 * 60);

// In DEMO_MODE, use fixed test keypairs so no secrets are required.
// These are well-known Stellar testnet keys safe for local demos only.
const DEMO_BUYER_SECRET = "SDKXSHMO3BR6P7BRH6KNZ7RWHKK4PDACKTUTIHM7J56T55RHT53QHFBX";
const DEMO_SELLER_SECRET = "SDY6VEDUDJ6JD77NU7KQCQGNP3KCXN57RPUGDDYQBNGAWD2VE5P4RAVF";

export const buyerKeypair = DEMO_MODE
  ? Keypair.fromSecret(DEMO_BUYER_SECRET)
  : Keypair.fromSecret(env.BUYER_SECRET ?? env.SECRET_KEY ?? "");

export const sellerKeypair = DEMO_MODE
  ? Keypair.fromSecret(DEMO_SELLER_SECRET)
  : Keypair.fromSecret(env.SELLER_SECRET ?? env.SECRET_KEY ?? "");

export function getKeypair(wallet: string): Keypair {
  if (wallet === "buyer") return buyerKeypair;
  if (wallet === "seller") return sellerKeypair;
  throw new Error("Invalid wallet");
}
