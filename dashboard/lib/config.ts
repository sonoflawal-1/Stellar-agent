import "dotenv/config";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
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

// ---------------------------------------------------------------------------
// Security settings (headers, body limits, rate limits)
// ---------------------------------------------------------------------------

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseOriginList(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : fallback;
}

/**
 * Request body size limits (passed to express.json({ limit })).
 * A small global limit applies to every route; larger limits are only used on
 * routes that legitimately accept big payloads (e.g. /api/build/submit).
 */
export const bodyLimitDefault = process.env.BODY_LIMIT_DEFAULT ?? "100kb";
export const bodyLimitBuildSubmit = process.env.BODY_LIMIT_BUILD_SUBMIT ?? "2mb";

/**
 * Content-Security-Policy allow-lists. Defaults cover the static dashboard
 * (public/app.js) plus the configured RPC endpoints.
 */
export const cspScriptSrc = parseOriginList(process.env.CSP_SCRIPT_SRC, ["'self'"]);
export const cspImgSrc = parseOriginList(process.env.CSP_IMG_SRC, [
  "'self'",
  "data:",
  "https:",
]);
export const cspConnectSrc = parseOriginList(process.env.CSP_CONNECT_SRC, [
  "'self'",
  ...rpcUrls,
]);

/**
 * Rate-limit buckets. Each bucket is keyed independently so that a wallet
 * cannot bypass limits by rotating IPs (and vice versa).
 * - ip: per-IP request budget for read endpoints.
 * - wallet: per-wallet request budget for authenticated endpoints.
 * - token: per-token request budget for token-scoped endpoints.
 * - embeddingCost: cost weight applied to embedding-heavy routes.
 */
export const rateLimitIp = parsePositiveInt(process.env.RATE_LIMIT_IP, 120);
export const rateLimitWallet = parsePositiveInt(process.env.RATE_LIMIT_WALLET, 60);
export const rateLimitToken = parsePositiveInt(process.env.RATE_LIMIT_TOKEN, 60);
export const rateLimitEmbeddingCost = parsePositiveInt(process.env.RATE_LIMIT_EMBEDDING_COST, 5);

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

// Salt used to hash client IPs before they are written to the audit log.
// - AUDIT_SALT: explicit salt (highest priority).
// - AUDIT_SALT_FILE: path to a persisted salt file (default: data/audit-salt).
//   The file is created with 0600 permissions on first run so hashes stay
//   stable across restarts.
// - In production (NODE_ENV=production) an explicit AUDIT_SALT is required;
//   otherwise startup fails rather than silently using an ephemeral salt.
// - Outside production, if no salt can be persisted, a random per-process salt
//   is used and a warning is logged because hashes will not be comparable
//   across restarts.
export const auditSaltFile = process.env.AUDIT_SALT_FILE ?? "data/audit-salt";

export interface AuditSaltResult {
  salt: string;
  /** True when the salt is random per process and not persisted. */
  ephemeral: boolean;
}

let cachedAuditSalt: AuditSaltResult | null = null;

function readOrCreateSaltFile(filePath: string): string | null {
  try {
    const existing = readFileSync(filePath, "utf8").trim();
    if (existing) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Fall through to (re)create the file below.
    }
  }
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const generated = randomBytes(32).toString("hex");
    writeFileSync(filePath, `${generated}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(filePath, 0o600);
    return generated;
  } catch (error) {
    // Another process may have created the file concurrently; try reading it.
    try {
      const existing = readFileSync(filePath, "utf8").trim();
      if (existing) return existing;
    } catch {
      // Ignore and report failure below.
    }
    return null;
  }
}

/**
 * Resolve the audit IP-hash salt, persisting a generated salt to
 * `auditSaltFile` (0600) when no explicit salt is configured.
 */
export function resolveAuditSalt(): AuditSaltResult {
  if (cachedAuditSalt) return cachedAuditSalt;

  const explicit = process.env.AUDIT_SALT?.trim();
  if (explicit) {
    cachedAuditSalt = { salt: explicit, ephemeral: false };
    return cachedAuditSalt;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "AUDIT_SALT must be set in production so audit IP hashes are stable across restarts.",
    );
  }

  const persisted = readOrCreateSaltFile(auditSaltFile);
  if (persisted) {
    cachedAuditSalt = { salt: persisted, ephemeral: false };
    return cachedAuditSalt;
  }

  console.warn(
    `[audit] AUDIT_SALT is not set and ${auditSaltFile} could not be persisted; ` +
      "using a random per-process salt. Audit IP hashes will NOT be comparable across restarts.",
  );
  cachedAuditSalt = { salt: randomBytes(32).toString("hex"), ephemeral: true };
  return cachedAuditSalt;
}

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
