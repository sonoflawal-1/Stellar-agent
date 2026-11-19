import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import crypto from "crypto";
import fs from "fs";
import { fileURLToPath } from "url";
import { z, ZodError } from "zod";
import {
  Keypair,
  rpc,
  Account,
  TransactionBuilder,
  BASE_FEE,
  Operation,
  Address,
  nativeToScVal,
  Contract,
  xdr,
  scValToNative,
  StrKey,
  Networks,
  Utils,
} from "@stellar/stellar-sdk";
import { trace, context, propagation, SpanStatusCode, type Span } from "@opentelemetry/api";
import { cfg, rpcUrls, buyerKeypair, sellerKeypair, getKeypair, DEMO_MODE } from "./lib/config.js";
import {
  getAllAgents,
  getAgentsPage,
  getAllJobs,
  getJobsPage,
  invalidateAgents,
  invalidateJobs,
  identity,
  commerce,
  events,
  getFeeBps,
} from "./lib/discovery.js";
import {
  createSession,
  refreshSession,
  verifySession,
  invalidateSession,
  requireAuth,
  requireMatchingWallet,
} from "./lib/auth.js";
import {
  createMatchmakingEngine,
  type MatchmakingEngine,
  type AgentDocument,
} from "./lib/matchmaking.js";
import { SlidingWindowRateLimiter } from "./lib/rateLimiter.js";
import { IssuedChallengeStore } from "./lib/authChallenges.js";
import { parseAllowedOrigins } from "./lib/origins.js";
import {
  csrfProtection,
  issueCsrfToken,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "./lib/csrf.js";
import { WebSocketServer, type WebSocket } from "ws";
import { getReadOnlyDb } from "../../indexer/src/db.js";
import { eventHub, type SorobanEvent } from "../../indexer/src/events.js";
import { getJobEventType, matchesJobEvent } from "./lib/jobEvents.js";
import {
  createAuditStore,
  type AuditStore,
  type AuditEntry,
} from "./lib/auditStore.js";
import { validateAgentMetadata } from "./lib/agentMetadata.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ── #718: Read-only database handle ──────────────────────────────────────────
// Dashboard queries use a dedicated read-only connection so they never contend
// with the indexer's write lock. Falls back to null when the indexer database is
// not available (e.g. dashboard-only deployments).
const readOnlyDb = (() => {
  try {
    return getReadOnlyDb();
  } catch (err) {
    console.warn("[db] read-only handle unavailable:", (err as Error).message);
    return null;
  }
})();

// ── #719: Event streaming helpers ────────────────────────────────────────────
// Filtering semantics shared by the SSE and WebSocket endpoints. A subscriber
// may filter by contract id, event type, and address topic.
type EventFilter = {
  contract?: string;
  eventType?: string;
  address?: string;
};

function parseEventFilter(source: Record<string, unknown>): EventFilter {
  const pick = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  return {
    contract: pick(source.contract),
    eventType: pick(source.eventType ?? source.event_type),
    address: pick(source.address),
  };
}

function eventMatchesFilter(event: SorobanEvent, filter: EventFilter): boolean {
  if (filter.contract && event.contractId !== filter.contract) return false;
  if (filter.eventType && event.eventType !== filter.eventType) return false;
  if (filter.address) {
    const topics = Array.isArray(event.topics) ? event.topics.map(String) : [];
    if (!topics.includes(filter.address)) return false;
  }
  return true;
}

const SSE_HEARTBEAT_MS = 30_000;
const WS_HEARTBEAT_MS = 30_000;

// ── #726: OpenTelemetry distributed tracing ─────────────────────────────────
// The SDK is initialized in ./lib/tracing.js (imported for its side effects at
// process startup). Here we obtain a tracer and install HTTP middleware that
// extracts W3C traceparent headers and starts a server span per request.
const tracer = trace.getTracer("marc-dashboard", "1.0.0");

function tracingMiddleware(req: Request, res: Response, next: NextFunction) {
  // Extract incoming W3C trace context (traceparent/tracestate) from headers.
  const parentContext = propagation.extract(context.active(), req.headers);
  const span = tracer.startSpan(
    `${req.method} ${req.path}`,
    {
      kind: 1, // SpanKind.SERVER
      attributes: {
        "http.method": req.method,
        "http.target": req.originalUrl || req.url,
        "http.route": req.path,
        "http.scheme": req.protocol,
        "http.host": req.headers.host ?? "",
        "http.user_agent": req.headers["user-agent"] ?? "",
      },
    },
    parentContext,
  );

  // Make the span active for the remainder of the request lifecycle.
  context.with(trace.setSpan(parentContext, span), () => {
    (req as any).span = span;
    res.on("finish", () => {
      span.setAttribute("http.status_code", res.statusCode);
      if (res.statusCode >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      span.end();
    });
    res.on("close", () => {
      if (!span.isRecording()) return;
      span.end();
    });
    next();
  });
}

app.use(tracingMiddleware);

// ── #778: Strict Content Security Policy with per-request nonces ─────────────
// Generate a fresh cryptographic nonce for every request. The nonce is stored
// on res.locals so route handlers and the HTML-injection middleware can read it.
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString("base64");
  next();
});

// Stellar RPC, Horizon, and IPFS gateway endpoints allowed in connect-src.
const STELLAR_CONNECT_SRCS = [
  "https://soroban-testnet.stellar.org",
  "https://soroban-rpc.mainnet.stellar.org",
  "https://horizon-testnet.stellar.org",
  "https://horizon.stellar.org",
  "https://ipfs.io",
  "https://cloudflare-ipfs.com",
  "https://dweb.link",
  "https://channels.openzeppelin.com",
];

// ── #962: Security headers ───────────────────────────────────────────────────
// Helmet is applied globally so both the landing site and the /app dashboard
// receive a consistent header set (HSTS, X-Content-Type-Options, X-Frame-Options,
// Referrer-Policy, CSP, …). The CSP is tailored to public/app.js: it allows the
// Stellar Wallets Kit CDN bundle, Google Fonts, and the allow-listed RPC/Horizon/
// IPFS origins used by the dashboard's connect-src.
const CSP_CONNECT_SRCS = Array.from(
  new Set([
    ...STELLAR_CONNECT_SRCS,
    ...rpcUrls,
    ...Object.values(NETWORK_PRESETS).flatMap((preset) => [
      preset.rpcUrl,
      ...preset.rpcUrls,
      preset.horizonUrl,
    ]),
  ]),
).filter((origin) => /^https?:\/\//.test(origin));

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          // Nonce allows the inline theme-init script and any scripts we explicitly
          // tag; the function below is called by helmet per-request.
          // helmet calls this with (IncomingMessage, ServerResponse); Express augments
          // ServerResponse with .locals, so we cast to access the nonce.
          (_req, res) => `'nonce-${(res as unknown as Response).locals.cspNonce}'`,
          // Stellar Wallets Kit UMD bundle served from jsdelivr CDN.
          "https://cdn.jsdelivr.net",
          "https://unpkg.com",
        ],
        styleSrc: [
          "'self'",
          (_req, res) => `'nonce-${(res as unknown as Response).locals.cspNonce}'`,
          "https://fonts.googleapis.com",
        ],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", ...CSP_CONNECT_SRCS, "wss:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    // Keep other helmet defaults: HSTS, X-Frame-Options, etc.
    crossOriginEmbedderPolicy: false, // required for Freighter wallet extension
  }),
);

// ── #963: Bounded request body sizes ────────────────────────────────────────
// A small global JSON limit protects every route by default. Routes that need a
// larger payload (e.g. /api/build/submit, which carries a signed XDR) mount a
// dedicated parser with a larger, configurable limit before the global parser.
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT ?? "64kb";
const BUILD_SUBMIT_BODY_LIMIT = process.env.BUILD_SUBMIT_BODY_LIMIT ?? "512kb";

const buildSubmitJsonParser = express.json({ limit: BUILD_SUBMIT_BODY_LIMIT });
app.use("/api/build/submit", buildSubmitJsonParser);
app.use(express.json({ limit: JSON_BODY_LIMIT }));

// Landing page at root
const landingDir = path.join(__dirname, "..", "landing");
app.use(express.static(landingDir));

// Dashboard at /app — serve static files then inject nonce into HTML responses
// so the browser accepts the CDN script tag in index.html.
app.use("/app", express.static(path.join(__dirname, "public")));

// Nonce injection middleware: intercepts HTML responses served from /app and
// rewrites the CDN <script> and Google Fonts <link> tags to include the nonce.
// This is the standard approach for static-file CSP without a build step.
app.use("/app", (_req: Request, res: Response, next: NextFunction) => {
  const nonce = res.locals.cspNonce as string;
  const originalSend = res.send.bind(res);
  res.send = function (body: unknown) {
    if (
      typeof body === "string" &&
      res.getHeader("Content-Type")?.toString().includes("text/html")
    ) {
      // Add nonce to the wallet-kit CDN script tag
      let html = body as string;
      html = html.replace(
        /<script src="https:\/\/cdn\.jsdelivr\.net/g,
        `<script nonce="${nonce}" src="https://cdn.jsdelivr.net`,
      );
      // Add nonce to local app.js script tag
      html = html.replace(
        /<script src="app\.js"/g,
        `<script nonce="${nonce}" src="app.js"`,
      );
      // Add nonce to the inline theme-init script in <head> (#758). This must run
      // before CSS paints to avoid a flash of the wrong theme.
      html = html.replace(
        /<script(\s+id="theme-init")>/g,
        `<script nonce="${nonce}"$1>`,
      );
      // Add nonce to the inline network-init script in <head> (#761).
      html = html.replace(
        /<script(\s+id="network-init")>/g,
        `<script nonce="${nonce}"$1>`,
      );
      // Add nonce to Google Fonts link tags
      html = html.replace(
        /<link\s+(rel="preconnect"\s+href="https:\/\/fonts\.(googleapis|gstatic)\.com[^>]*)>/g,
        (_match: string, attrs: string) => `<link ${attrs} nonce="${nonce}">`,
      );
      html = html.replace(
        /<link\s+(href="https:\/\/fonts\.googleapis\.com[^>]*)>/g,
        (_match: string, attrs: string) => `<link ${attrs} nonce="${nonce}">`,
      );
      return originalSend(html);
    }
    return originalSend(body);
  };
  next();
});

// ── #761: Dynamic network presets ────────────────────────────────────────────
// Each preset bundles the RPC endpoints, network passphrase, and contract
// addresses needed to talk to a given Stellar network. The active network is
// selected per-request via the `x-bear-network` header (falling back to the
// server default) so the dashboard can switch networks on the fly.
type NetworkPreset = {
  id: "testnet" | "futurenet" | "mainnet";
  label: string;
  networkPassphrase: string;
  rpcUrl: string;
  rpcUrls: string[];
  identityContract: string;
  commerceContract: string;
  usdcToken: string;
  horizonUrl: string;
  isMainnet: boolean;
};

const NETWORK_PRESETS: Record<NetworkPreset["id"], NetworkPreset> = {
  testnet: {
    id: "testnet",
    label: "Testnet",
    networkPassphrase: Networks.TESTNET,
    rpcUrl: cfg.rpcUrl,
    rpcUrls,
    identityContract: cfg.identityContract,
    commerceContract: cfg.commerceContract,
    usdcToken: cfg.usdcToken,
    horizonUrl: "https://horizon-testnet.stellar.org",
    isMainnet: false,
  },
  futurenet: {
    id: "futurenet",
    label: "Futurenet",
    networkPassphrase: Networks.FUTURENET,
    rpcUrl: process.env.FUTURENET_RPC_URL ?? "https://rpc-futurenet.stellar.org",
    rpcUrls: [process.env.FUTURENET_RPC_URL ?? "https://rpc-futurenet.stellar.org"],
    identityContract: process.env.FUTURENET_IDENTITY_CONTRACT ?? cfg.identityContract,
    commerceContract: process.env.FUTURENET_COMMERCE_CONTRACT ?? cfg.commerceContract,
    usdcToken: process.env.FUTURENET_USDC_TOKEN ?? cfg.usdcToken,
    horizonUrl: "https://horizon-futurenet.stellar.org",
    isMainnet: false,
  },
  mainnet: {
    id: "mainnet",
    label: "Mainnet",
    networkPassphrase: Networks.PUBLIC,
    rpcUrl: process.env.MAINNET_RPC_URL ?? "https://soroban-rpc.mainnet.stellar.org",
    rpcUrls: [process.env.MAINNET_RPC_URL ?? "https://soroban-rpc.mainnet.stellar.org"],
    identityContract: process.env.MAINNET_IDENTITY_CONTRACT ?? cfg.identityContract,
    commerceContract: process.env.MAINNET_COMMERCE_CONTRACT ?? cfg.commerceContract,
    usdcToken:
      process.env.MAINNET_USDC_TOKEN ??
      "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    horizonUrl: "https://horizon.stellar.org",
    isMainnet: true,
  },
};

const DEFAULT_NETWORK_ID: NetworkPreset["id"] =
  (process.env.DEFAULT_NETWORK as NetworkPreset["id"]) ?? "testnet";

function resolveNetworkId(value: unknown): NetworkPreset["id"] {
  if (typeof value === "string" && value in NETWORK_PRESETS) {
    return value as NetworkPreset["id"];
  }
  return DEFAULT_NETWORK_ID;
}

/** Resolve the active network preset for a request from the x-bear-network header. */
function getRequestNetwork(req: Request): NetworkPreset {
  const header = req.header("x-bear-network");
  return NETWORK_PRESETS[resolveNetworkId(header)];
}

/** Public, client-safe view of a network preset. */
function publicNetworkInfo(preset: NetworkPreset) {
  return {
    id: preset.id,
    label: preset.label,
    networkPassphrase: preset.networkPassphrase,
    rpcUrl: preset.rpcUrl,
    horizonUrl: preset.horizonUrl,
    identityContract: preset.identityContract,
    commerceContract: preset.commerceContract,
    usdcToken: preset.usdcToken,
    isMainnet: preset.isMainnet,
  };
}

const server = new rpc.Server(cfg.rpcUrl, {
  allowHttp: cfg.rpcUrl.startsWith("http://"),
});

const rpcFallbackServers = rpcUrls.map(
  (url) =>
    new rpc.Server(url, {
      allowHttp: url.startsWith("http://"),
    }),
);

async function withRpcFallback<T>(operation: (server: rpc.Server) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (const candidate of rpcFallbackServers) {
    try {
      return await operation(candidate);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All Stellar RPC providers failed");
}

/** Run an RPC operation against a specific network's endpoints, with fallback. */
async function withNetworkRpc<T>(
  preset: NetworkPreset,
  operation: (server: rpc.Server) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (const url of preset.rpcUrls) {
    try {
      const candidate = new rpc.Server(url, { allowHttp: url.startsWith("http://") });
      return await operation(candidate);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All Stellar RPC providers failed");
}

const identityContract = new Contract(cfg.identityContract);
const commerceContract = new Contract(cfg.commerceContract);

// ── #736: Semantic matchmaking engine ────────────────────────────────────────
// Embeddings are generated lazily and cached in a vector index (sqlite-vec when
// available, otherwise an in-memory cosine index). When the embedding engine is
// disabled via EMBEDDINGS_ENABLED=false, the engine transparently falls back to
// lexical (token-overlap) search so the endpoint keeps working.
const matchmaking: MatchmakingEngine = createMatchmakingEngine({
  enabled: process.env.EMBEDDINGS_ENABLED !== "false",
  dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 384),
  model: process.env.EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2",
  sqlitePath: process.env.VECTOR_DB_PATH,
});

/** Build the text document that represents an agent for embedding purposes. */
function agentToDocument(agent: {
  id?: unknown;
  owner?: unknown;
  uri?: unknown;
  [key: string]: unknown;
}): AgentDocument {
  const id = String(agent.id ?? agent.owner ?? "");
  const parts: string[] = [];
  if (agent.uri) parts.push(String(agent.uri));
  for (const key of ["name", "description", "capabilities", "skills", "tags", "category"]) {
    const value = agent[key];
    if (typeof value === "string" && value.trim()) parts.push(value);
    else if (Array.isArray(value)) parts.push(value.map(String).join(" "));
  }
  return { id, text: parts.join(" \n ").trim() || id };
}

/** Index a batch of agents into the matchmaking engine. */
async function indexAgents(agents: Array<Record<string, unknown>>): Promise<void> {
  const docs = agents.map((agent) => agentToDocument(agent));
  await matchmaking.upsert(docs);
}

/** Index a single agent (called after registration). */
async function indexAgent(agent: Record<string, unknown>): Promise<void> {
  await matchmaking.upsert([agentToDocument(agent)]);
}

/** Warm the index on startup so the first match request is fast. */
async function warmMatchmakingIndex(): Promise<void> {
  try {
    const agents = (await getAllAgents()) as unknown as Array<Record<string, unknown>>;
    await indexAgents(agents);
    console.log(`[matchmaking] indexed ${agents.length} agents (mode=${matchmaking.mode})`);
  } catch (err) {
    console.warn("[matchmaking] failed to warm index:", (err as Error).message);
  }
}

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:5173",
  ...(env.ALLOWED_ORIGIN ? [env.ALLOWED_ORIGIN] : []),
  ...(env.ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
];

// ── #722: Sliding-window rate limiter for mutating API endpoints ─────────────
// Tracks request timestamps per key (IP + optional wallet) in a sliding window,
// which avoids the boundary-bursting problem of fixed-window counters. Expired
// entries are pruned periodically so memory stays bounded under many distinct
// IP probes.
const MUTATING_RATE_LIMIT = Number(process.env.MUTATING_RATE_LIMIT ?? 30);
const MUTATING_RATE_WINDOW_MS = Number(process.env.MUTATING_RATE_WINDOW_MS ?? 60_000);

const mutatingRateLimiter = new SlidingWindowRateLimiter({
  limit: MUTATING_RATE_LIMIT,
  windowMs: MUTATING_RATE_WINDOW_MS,
});

function rateLimitMutating(req: Request, res: Response, next: NextFunction) {
  const wallet = String(req.headers["x-stellar-wallet"] ?? "");
  const key = `${req.ip || "unknown"}:${wallet}`;
  const result = mutatingRateLimiter.check(key);

  res.setHeader("X-RateLimit-Limit", String(result.limit));
  res.setHeader("X-RateLimit-Remaining", String(result.remaining));

  if (!result.allowed) {
    res.setHeader("Retry-After", String(result.retryAfterSeconds));
    res.status(429).json({ error: "rate limit exceeded" });
    return;
  }
  next();
}

// ── #964: Per-wallet, per-token, and cost-weighted read rate limits ─────────
// Read endpoints (agent matching, embeddings) can be abused from many IPs, so
// in addition to the per-IP limiter above we enforce:
//   • a per-wallet bucket (x-stellar-wallet header) — 120 req/min
//   • a per-token bucket (Authorization bearer token) — 120 req/min
//   • a cost-weighted bucket for embedding-heavy routes — 60 cost units/min,
//     where each request costs `EMBEDDING_COST` units (default 5).
// All buckets are documented in docs/security.md. 429 responses always include
// a Retry-After header.
const READ_WALLET_RATE_LIMIT = Number(process.env.READ_WALLET_RATE_LIMIT ?? 120);
const READ_TOKEN_RATE_LIMIT = Number(process.env.READ_TOKEN_RATE_LIMIT ?? 120);
const READ_RATE_WINDOW_MS = Number(process.env.READ_RATE_WINDOW_MS ?? 60_000);
const EMBEDDING_COST_LIMIT = Number(process.env.EMBEDDING_COST_LIMIT ?? 60);
const EMBEDDING_COST = Number(process.env.EMBEDDING_COST ?? 5);

const readWalletRateLimiter = new SlidingWindowRateLimiter({
  limit: READ_WALLET_RATE_LIMIT,
  windowMs: READ_RATE_WINDOW_MS,
});
const readTokenRateLimiter = new SlidingWindowRateLimiter({
  limit: READ_TOKEN_RATE_LIMIT,
  windowMs: READ_RATE_WINDOW_MS,
});
const embeddingCostRateLimiter = new SlidingWindowRateLimiter({
  limit: EMBEDDING_COST_LIMIT,
  windowMs: READ_RATE_WINDOW_MS,
});

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : undefined;
}

function rejectRateLimited(res: Response, retryAfterSeconds: number): void {
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(429).json({ error: "rate limit exceeded" });
}

/**
 * Per-wallet and per-token read limiter. Requests without a wallet or token are
 * still bounded by the per-IP limiter applied separately.
 */
function rateLimitRead(req: Request, res: Response, next: NextFunction) {
  const wallet = String(req.headers["x-stellar-wallet"] ?? "").trim();
  if (wallet) {
    const result = readWalletRateLimiter.check(`wallet:${wallet}`);
    res.setHeader("X-RateLimit-Wallet-Remaining", String(result.remaining));
    if (!result.allowed) {
      rejectRateLimited(res, result.retryAfterSeconds);
      return;
    }
  }
  const token = bearerToken(req);
  if (token) {
    const result = readTokenRateLimiter.check(`token:${token}`);
    res.setHeader("X-RateLimit-Token-Remaining", String(result.remaining));
    if (!result.allowed) {
      rejectRateLimited(res, result.retryAfterSeconds);
      return;
    }
  }
  next();
}

/**
 * Cost-weighted limiter for embedding-heavy routes. Each request consumes
 * `EMBEDDING_COST` units from a per-wallet (or per-IP fallback) bucket.
 */
function rateLimitEmbeddingCost(req: Request, res: Response, next: NextFunction) {
  const wallet = String(req.headers["x-stellar-wallet"] ?? "").trim();
  const key = wallet ? `wallet:${wallet}` : `ip:${req.ip || "unknown"}`;
  const result = embeddingCostRateLimiter.check(key, EMBEDDING_COST);
  res.setHeader("X-RateLimit-Cost-Remaining", String(result.remaining));
  if (!result.allowed) {
    rejectRateLimited(res, result.retryAfterSeconds);
    return;
  }
  next();
}

function isStellarAddress(value: string): boolean {
  if (typeof value !== "string") return false;
  if (!StrKey.isValidEd25519PublicKey(value)) return false;
  try {
    new Address(value);
    return true;
  } catch {
    return false;
  }
}

const stellarAddressSchema = z
  .string()
  .min(1)
  .refine(isStellarAddress, { message: "Invalid Stellar public key" });

const numericIdParamSchema = z.object({
  id: z
    .string()
    .regex(/^[0-9]+$/, "Job ID must be a positive integer")
    .transform(BigInt),
});

const registerAgentSchema = z
  .object({
    wallet: z.enum(["buyer", "seller", "freighter"]),
    publicKey: stellarAddressSchema.optional(),
    uri: z.string().min(1).optional(),
  })
  .refine((data) => {
    if (data.wallet === "freighter" && !data.publicKey) {
      throw new Error("publicKey is required when wallet is freighter");
    }
    return true;
  });

const createJobSchema = z.object({
  wallet: stellarAddressSchema,
  provider: stellarAddressSchema.optional(),
  evaluator: stellarAddressSchema.optional(),
  budget: z.union([z.string().regex(/^[0-9]+$/), z.number().int().nonnegative()]).optional(),
  description: z.string().min(1).optional(),
});

const submitJobSchema = z.object({
  wallet: stellarAddressSchema,
  deliverable: z.string().min(1).optional(),
});

const walletOnlySchema = z.object({
  wallet: stellarAddressSchema,
});

const buildRegisterSchema = z.object({
  publicKey: stellarAddressSchema,
  uri: z.string().min(1).optional(),
});

const buildCreateJobSchema = z.object({
  publicKey: stellarAddressSchema,
  provider: stellarAddressSchema.optional(),
  evaluator: stellarAddressSchema.optional(),
  budget: z.union([z.string().regex(/^[0-9]+$/), z.number().int().nonnegative()]).optional(),
  description: z.string().min(1).optional(),
});

const buildUnsignedActionSchema = z.object({
  publicKey: stellarAddressSchema,
  jobId: z.string().regex(/^[0-9]+$/, "Job ID must be a positive integer"),
});

const submitXdrSchema = z.object({
  signedXdr: z.string().min(1),
});

const jobStatusSchema = z.enum([
  "Active",
  "Open",
  "Funded",
  "Submitted",
  "Completed",
  "Rejected",
  "Cancelled",
  "Disputed",
]);

const jobsQuerySchema = z.object({
  status: z.string().min(1).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(24),
});

const agentsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(24),
});

const agentMatchSchema = z.object({
  query: z.string().min(1, "query must be a non-empty string"),
  topK: z.coerce.number().int().positive().max(100).default(10),
});

// ── #973: Job creation fee simulation ────────────────────────────────────────
// The dashboard calls this before signing so the user sees the exact budget,
// fee, and net payout the contract will charge. The budget is validated with the
// same constraints the create_job contract enforces (positive, fits in i128).
const I128_MAX = (1n << 127n) - 1n;

const simulateFeeSchema = z.object({
  budget: z
    .union([z.string().regex(/^[0-9]+$/, "budget must be a non-negative integer"), z.number().int().nonnegative()])
    .transform((value) => (typeof value === "number" ? BigInt(value) : BigInt(value)))
    .refine((value) => value > 0n, { message: "budget must be greater than zero" })
    .refine((value) => value <= I128_MAX, { message: "budget exceeds i128 range" }),
});

function parseBudget(value: string | number | undefined, defaultValue = 10_000_000n): bigint {
  if (value === undefined || value === null) return defaultValue;
  return typeof value === "number" ? BigInt(value) : BigInt(value);
}

function respondWithValidationError(err: unknown, res: Response): boolean {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Invalid request payload", details: err.issues });
    return true;
  }
  return false;
}

function handleRouteError(err: unknown, res: Response): void {
  if (respondWithValidationError(err, res)) return;
  if (err instanceof Error && err.message === "Invalid wallet") {
    res.status(400).json({ error: "Invalid wallet" });
    return;
  }
  res.status(500).json({ error: (err as Error).message });
}

const MAX_AUDIT_ENTRIES = 500;
const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH ?? path.join(__dirname, "audit.jsonl");
const AUDIT_LOG_MAX_FILES = 3;
const AUDIT_SALT = process.env.AUDIT_SALT ?? crypto.randomBytes(32).toString("hex");

const auditQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(50),
});

function hashIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  return crypto.createHash("sha256").update(ip + AUDIT_SALT).digest("hex");
}

// ── #969: SQLite-backed audit log with retention ─────────────────────────────
// Entries are persisted to a WAL-mode SQLite database instead of rotated JSONL
// files. Existing JSONL files (including rotated .1/.2 siblings) are migrated
// into the database on startup, and a retention job prunes old rows.
const AUDIT_DB_PATH = process.env.AUDIT_DB_PATH ?? path.join(__dirname, "audit.sqlite");
const AUDIT_RETENTION_DAYS = Number(process.env.AUDIT_RETENTION_DAYS ?? 90);
const AUDIT_RETENTION_INTERVAL_MS = Number(
  process.env.AUDIT_RETENTION_INTERVAL_MS ?? 6 * 60 * 60 * 1000,
);

const auditStore: AuditStore = createAuditStore({
  dbPath: AUDIT_DB_PATH,
  retentionDays: AUDIT_RETENTION_DAYS,
});

// Migrate any legacy JSONL files (current + rotated) into SQLite, then rename
// them so the migration is not repeated on the next startup.
function migrateLegacyAuditLogs(): void {
  const files = [AUDIT_LOG_PATH];
  for (let i = 1; i < AUDIT_LOG_MAX_FILES; i++) files.push(`${AUDIT_LOG_PATH}.${i}`);
  for (const file of files.reverse()) {
    if (!fs.existsSync(file)) continue;
    try {
      const entries: AuditEntry[] = [];
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line) as AuditEntry);
        } catch {
          // Skip a partially written line.
        }
      }
      if (entries.length > 0) auditStore.insertMany(entries);
      fs.renameSync(file, `${file}.migrated`);
      console.log(`[audit] migrated ${entries.length} entries from ${path.basename(file)}`);
    } catch (err) {
      console.warn(`[audit] failed to migrate ${file}:`, (err as Error).message);
    }
  }
}

try {
  migrateLegacyAuditLogs();
} catch (err) {
  console.warn("[audit] migration failed:", (err as Error).message);
}

// Retention job: prune rows older than the configured retention window.
function runAuditRetention(): void {
  try {
    const removed = auditStore.prune();
    if (removed > 0) console.log(`[audit] retention pruned ${removed} entries`);
  } catch (err) {
    console.warn("[audit] retention job failed:", (err as Error).message);
  }
}

runAuditRetention();
const auditRetentionTimer = setInterval(runAuditRetention, AUDIT_RETENTION_INTERVAL_MS);
auditRetentionTimer.unref?.();

function auditAdminAction(req: Request, res: Response, next: NextFunction) {
  const path = req.originalUrl || req.url;
  res.on("finish", () => {
    const entry: AuditEntry = {
      at: new Date().toISOString(),
      method: req.method,
      path,
      wallet: String((req as any).walletAddress ?? req.body?.wallet ?? req.body?.publicKey ?? ""),
      statusCode: res.statusCode,
      ipHash: hashIp(req.ip),
    };
    try {
      auditStore.insert(entry);
    } catch (err) {
      console.warn("[audit] failed to persist entry:", (err as Error).message);
    }
  });
  next();
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  }),
);

app.get("/health", async (_req, res) => {
  try {
    await instrumentRpc("getLatestLedger", () => server.getLatestLedger());
    res.json({ status: "ok", rpc: "ok", timestamp: new Date().toISOString() });
  } catch (err: unknown) {
    res.status(503).json({
      status: "degraded",
      rpc: "error",
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    });
  }
});
app.get("/healthz", (_req, res) => res.send("ok"));

// --- Authentication Endpoints (SEP-0010) ---

// #728: SEP-0010 server signing key. Used to sign the challenge transaction so
// wallets can verify the home domain. Falls back to the seller keypair in demo
// mode when no dedicated SEP-0010 key is configured.
const SEP10_SERVER_KEYPAIR = process.env.SEP10_SERVER_SECRET
  ? Keypair.fromSecret(process.env.SEP10_SERVER_SECRET)
  : sellerKeypair;
const SEP10_HOME_DOMAIN = process.env.SEP10_HOME_DOMAIN ?? "localhost";
const SEP10_WEB_AUTH_DOMAIN = process.env.SEP10_WEB_AUTH_DOMAIN ?? SEP10_HOME_DOMAIN;
const SEP10_CHALLENGE_TIMEOUT_SECONDS = 300;
const challengeRateLimiter = new SlidingWindowRateLimiter({
  limit: 10,
  windowMs: 60_000,
});
const issuedChallenges = new IssuedChallengeStore({ ttlMs: 5 * 60_000 });

/**
 * GET /api/auth/challenge — Issue a SEP-0010 challenge transaction.
 * Query: { publicKey }
 * Returns the base64 challenge XDR for the wallet to sign.
 */
app.get("/api/auth/challenge", async (req, res) => {
  const rate = challengeRateLimiter.check(req.ip || "unknown");
  res.setHeader("X-RateLimit-Limit", String(rate.limit));
  res.setHeader("X-RateLimit-Remaining", String(rate.remaining));
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSeconds));
    res.status(429).json({ error: "challenge rate limit exceeded" });
    return;
  }

  try {
    const publicKeySchema = z.object({
      publicKey: stellarAddressSchema,
    });
    const parsed = publicKeySchema.parse(req.query);
    try {
      await tracedRpc(
        "getAccount",
        { "rpc.method": "getAccount", "stellar.account": parsed.publicKey },
        () => withRpcFallback((rpcServer) => rpcServer.getAccount(parsed.publicKey)),
      );
    } catch {
      res.status(400).json({ error: "Unable to verify Stellar account" });
      return;
    }
    const challengeTx = Utils.buildChallengeTx(
      SEP10_SERVER_KEYPAIR,
      parsed.publicKey,
      SEP10_HOME_DOMAIN,
      SEP10_CHALLENGE_TIMEOUT_SECONDS,
      cfg.networkPassphrase,
      SEP10_WEB_AUTH_DOMAIN,
      cfg.networkPassphrase === Networks.PUBLIC ? undefined : cfg.networkPassphrase,
    );
    issuedChallenges.issue(challengeTx.hash().toString("hex"));
    res.json({
      transaction: challengeTx.toXDR(),
      network_passphrase: cfg.networkPassphrase,
    });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * POST /api/auth/token — Verify a signed SEP-0010 challenge and issue a JWT.
 * Body: { transaction }
 */
app.post("/api/auth/token", (req, res) => {
  try {
    const authSchema = z.object({
      transaction: z.string().min(1),
    });
    const parsed = authSchema.parse(req.body);

    let challengeHash: string;
    try {
      challengeHash = TransactionBuilder.fromXDR(
        parsed.transaction,
        cfg.networkPassphrase,
      )
        .hash()
        .toString("hex");
    } catch {
      res.status(401).json({ error: "Invalid or expired challenge transaction" });
      return;
    }
    if (!issuedChallenges.has(challengeHash)) {
      res.status(401).json({ error: "Invalid or expired challenge transaction" });
      return;
    }

    let clientPublicKey: string;
    try {
      clientPublicKey = Utils.verifyChallengeTx(
        parsed.transaction,
        SEP10_SERVER_KEYPAIR.publicKey(),
        cfg.networkPassphrase,
        SEP10_HOME_DOMAIN,
        SEP10_WEB_AUTH_DOMAIN,
      );
    } catch (err: unknown) {
      res.status(401).json({ error: `Invalid challenge transaction: ${(err as Error).message}` });
      return;
    }

    if (!issuedChallenges.consume(challengeHash)) {
      res.status(401).json({ error: "Invalid or expired challenge transaction" });
      return;
    }

    // Issue a 24-hour JWT session token bound to the verified client key.
    const token = createSession(clientPublicKey);
    res.json({ token, publicKey: clientPublicKey });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(400).json({ error: (err as Error).message });
  }
});

/** POST /api/auth/logout — Invalidate session token */
app.post("/api/auth/logout", (req, res) => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (token) {
      invalidateSession(token);
    }
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/auth/refresh", (req, res) => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) {
      res.status(401).json({ error: "Missing authentication token" });
      return;
    }
    const refreshed = refreshSession(token);
    if (!refreshed) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }
    res.json({ token: refreshed });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * Middleware: Require auth except in DEMO_MODE.
 * In DEMO_MODE, auth is optional to allow testing without Freighter.
 * In production, all state-changing operations require wallet authentication.
 */
function optionalAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  if (DEMO_MODE) {
    // In demo mode, auth is optional - allow demo wallets to bypass
    const wallet = req.body.wallet || req.body.publicKey;
    if (wallet === "buyer" || wallet === "seller") {
      // Demo wallet - no auth needed
      (req as any).walletAddress = getKeypair(wallet).publicKey();
      return next();
    }
  }

  // In production or for unknown wallets, require auth
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({
      error:
        "Authentication required. Use /api/auth/challenge and /api/auth/token to authenticate.",
    });
    return;
  }

  const publicKey = verifySession(token);
  if (!publicKey) {
    res.status(401).json({ error: "Invalid or expired authentication token" });
    return;
  }

  (req as any).walletAddress = publicKey;
  next();
}

function requireDashboardWallet(req: Request, res: Response, next: NextFunction) {
  const requestedWallet = req.body.publicKey || req.body.wallet;
  if (DEMO_MODE && (requestedWallet === "buyer" || requestedWallet === "seller")) {
    next();
    return;
  }
  requireMatchingWallet(req, res, next);
}

// --- Helpers ---

/** Serialize bigint values to strings for JSON, normalize Soroban enums */
function serialize(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "bigint") return obj.toString();
  if (obj instanceof Date) return obj.toISOString();
  if (obj instanceof Map)
    return Array.from(obj.entries()).map(([k, v]) => [serialize(k), serialize(v)]);
  if (obj instanceof Set) return Array.from(obj).map(serialize);
  if (Array.isArray(obj)) return obj.map(serialize);
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      // Soroban enums come back as ["VariantName"] — unwrap to string
      if (k === "status" && Array.isArray(v) && v.length === 1 && typeof v[0] === "string") {
        result[k] = v[0];
      } else {
        result[k] = serialize(v);
      }
    }
    return result;
  }
  return obj;
}

const HORIZON_URL =
  env.HORIZON_URL ??
  (cfg.networkPassphrase === Networks.PUBLIC
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org");

/** Get XLM balance from Horizon (optionally for a specific network) */
async function getXlmBalance(pubkey: string, horizonUrl: string = HORIZON_URL): Promise<string> {
  try {
    const resp = await fetch(`${horizonUrl}/accounts/${pubkey}`);
    if (!resp.ok) return "0";
    const data = (await resp.json()) as {
      balances: Array<{ asset_type: string; balance: string }>;
    };
    const native = data.balances.find((b: { asset_type: string }) => b.asset_type === "native");
    return native?.balance ?? "0";
  } catch {
    return "0";
  }
}

/** Simulate a read-only contract call with no arguments and return its native value */
async function simulateReadCall(
  contract: Contract,
  method: string,
  preset: NetworkPreset = NETWORK_PRESETS[DEFAULT_NETWORK_ID],
): Promise<unknown> {
  const op = contract.call(method);
  const ephemeral = Keypair.random();
  const dummy = new Account(ephemeral.publicKey(), "0");
  const tx = new TransactionBuilder(dummy, {
    fee: BASE_FEE,
    networkPassphrase: preset.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();
  const sim = await withNetworkRpc(preset, (rpcServer) => rpcServer.simulateTransaction(tx));
  if (rpc.Api.isSimulationError(sim)) return null;
  const result = (sim as rpc.Api.SimulateTransactionSuccessResponse).result;
  if (!result) return null;
  return scValToNative(result.retval);
}

const tokenDecimalsCache = new Map<string, number>();

/** Query and cache a SAC token's `decimals()` value, defaulting to 7 on failure */
async function getTokenDecimals(
  tokenAddress: string,
  preset: NetworkPreset = NETWORK_PRESETS[DEFAULT_NETWORK_ID],
): Promise<number> {
  const cacheKey = `${preset.id}:${tokenAddress}`;
  const cached = tokenDecimalsCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const decimals = Number(
      await simulateReadCall(new Contract(tokenAddress), "decimals", preset),
    );
    if (!Number.isFinite(decimals)) return 7;
    tokenDecimalsCache.set(cacheKey, decimals);
    return decimals;
  } catch {
    return 7;
  }
}

/** Get MUSD (SAC) balance via Soroban simulate */
async function getTokenBalance(
  pubkey: string,
  preset: NetworkPreset = NETWORK_PRESETS[DEFAULT_NETWORK_ID],
): Promise<string> {
  try {
    const contract = new Contract(preset.usdcToken);
    const op = contract.call("balance", new Address(pubkey).toScVal());
    const ephemeral = Keypair.random();
    const dummy = new Account(ephemeral.publicKey(), "0");
    const tx = new TransactionBuilder(dummy, {
      fee: BASE_FEE,
      networkPassphrase: preset.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
    const sim = await withNetworkRpc(preset, (rpcServer) => rpcServer.simulateTransaction(tx));
    if (rpc.Api.isSimulationError(sim)) return "0";
    const result = (sim as rpc.Api.SimulateTransactionSuccessResponse).result;
    if (!result) return "0";
    const raw = scValToNative(result.retval);
    const val = BigInt(raw);
    const decimals = await getTokenDecimals(preset.usdcToken, preset);
    if (decimals === 0) return val.toString();
    const divisor = 10n ** BigInt(decimals);
    const whole = val / divisor;
    const frac = (val % divisor).toString().padStart(decimals, "0");
    return `${whole}.${frac}`;
  } catch {
    return "0";
  }
}

// --- API Routes ---

// GET /api/csrf-token — issue a double-submit CSRF token (#961).
// The token is returned in the body and set as a SameSite=Strict cookie. Clients
// echo it back in the X-CSRF-Token header on mutating requests.
app.get("/api/csrf-token", (req, res) => {
  const token = issueCsrfToken(req, res);
  res.json({ csrfToken: token, header: CSRF_HEADER_NAME, cookie: CSRF_COOKIE_NAME });
});

// GET /api/demo-mode — lets the frontend know whether to skip Freighter auth
app.get("/api/demo-mode", (_req, res) => {
  res.json({
    enabled: DEMO_MODE,
    ...(DEMO_MODE && {
      buyer: buyerKeypair.publicKey(),
      seller: sellerKeypair.publicKey(),
    }),
  });
});

// POST /api/network/clear-cache — clear server-side caches on network switch (#976)
// The dashboard calls this when the user confirms a network switch so stale
// data from the previous network is not served.
app.post("/api/network/clear-cache", (_req, res) => {
  try {
    statsCache = null;
    tokenDecimalsCache.clear();
    invalidateAgents();
    invalidateJobs();
    res.json({ cleared: true });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/network — active network + available presets for the switcher (#761).
// The active network is resolved from the `x-bear-network` header so the client
// can confirm which preset its requests are being served against.
app.get("/api/network", (req, res) => {
  const active = getRequestNetwork(req);
  res.json({
    active: publicNetworkInfo(active),
    defaultNetwork: DEFAULT_NETWORK_ID,
    presets: Object.values(NETWORK_PRESETS).map(publicNetworkInfo),
  });
});

let statsCache: { ts: number; payload: unknown } | null = null;
const STATS_CACHE_TTL_MS = env.STATS_CACHE_TTL_MS;

// GET /api/stats
app.get("/api/stats", async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === "true";
    if (!forceRefresh && statsCache && Date.now() - statsCache.ts < STATS_CACHE_TTL_MS) {
      res.json(statsCache.payload);
      return;
    }
    const [agents, jobs, feeBps] = await Promise.all([
      tracedDb("getAllAgents", () => getAllAgents()),
      tracedDb("getAllJobs", () => getAllJobs()),
      tracedDb("getFeeBps", () => getFeeBps()),
    ]);
    const activeJobs = jobs.filter((j) => j.status === "Funded" || j.status === "Submitted").length;
    activeEscrowJobsGauge.set(activeJobs);
    const payload = {
      totalAgents: agents.length,
      totalJobs: jobs.length,
      activeJobs,
      feeBps,
    };
    statsCache = { ts: Date.now(), payload };
    res.json(payload);
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/stats/historical — 30-day protocol analytics for the dashboard charts.
// Aggregates daily volume, job counts, active jobs and settlement times from the
// cached discovery helpers, plus top-earning agents and month-over-month deltas.
const HISTORICAL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type HistoricalJob = {
  id?: unknown;
  status?: unknown;
  budget?: unknown;
  createdAt?: unknown;
  completedAt?: unknown;
  provider?: unknown;
  seller?: unknown;
};

function toMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const asNum = Number(value);
    if (Number.isFinite(asNum) && /^[0-9]+$/.test(value)) {
      // Heuristic: treat large integers as unix seconds/ms, otherwise parse as date.
      if (asNum > 1e12) return asNum;
      if (asNum > 1e9) return asNum * 1000;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function toBigIntSafe(value: unknown): bigint {
  if (value === null || value === undefined) return 0n;
  try {
    return BigInt(value as string | number | bigint);
  } catch {
    return 0n;
  }
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

app.get("/api/stats/historical", async (_req, res) => {
  try {
    const [agents, jobs] = await Promise.all([getAllAgents(), getAllJobs()]);
    const now = Date.now();
    const windowStart = now - HISTORICAL_DAYS * DAY_MS;
    const prevWindowStart = windowStart - HISTORICAL_DAYS * DAY_MS;

    // Pre-build the ordered list of day buckets (oldest → newest).
    const buckets = new Map<
      string,
      { date: string; volume: bigint; jobCount: number; activeJobs: number; settlementSum: number; settlementCount: number }
    >();
    for (let i = HISTORICAL_DAYS - 1; i >= 0; i--) {
      const key = dayKey(now - i * DAY_MS);
      buckets.set(key, {
        date: key,
        volume: 0n,
        jobCount: 0,
        activeJobs: 0,
        settlementSum: 0,
        settlementCount: 0,
      });
    }

    const earningsByProvider = new Map<string, bigint>();
    let currentVolume = 0n;
    let currentJobs = 0;
    let currentSettlementSum = 0;
    let currentSettlementCount = 0;
    let prevVolume = 0n;
    let prevJobs = 0;
    let prevSettlementSum = 0;
    let prevSettlementCount = 0;

    for (const raw of jobs as HistoricalJob[]) {
      const createdMs = toMs(raw.createdAt);
      const completedMs = toMs(raw.completedAt);
      const status = typeof raw.status === "string" ? raw.status : "";
      const budget = toBigIntSafe(raw.budget);
      const isActive = status === "Funded" || status === "Submitted" || status === "Active";

      // Daily buckets only cover the current 30-day window.
      if (createdMs !== null && createdMs >= windowStart && createdMs <= now) {
        const bucket = buckets.get(dayKey(createdMs));
        if (bucket) {
          bucket.jobCount += 1;
          bucket.volume += budget;
          if (isActive) bucket.activeJobs += 1;
        }
      }

      // Settlement time measured from creation to completion.
      const settlementMs =
        createdMs !== null && completedMs !== null && completedMs >= createdMs
          ? completedMs - createdMs
          : null;
      if (settlementMs !== null && completedMs !== null) {
        if (completedMs >= windowStart && completedMs <= now) {
          const bucket = buckets.get(dayKey(completedMs));
          if (bucket) {
            bucket.settlementSum += settlementMs;
            bucket.settlementCount += 1;
          }
          currentSettlementSum += settlementMs;
          currentSettlementCount += 1;
        } else if (completedMs >= prevWindowStart && completedMs < windowStart) {
          prevSettlementSum += settlementMs;
          prevSettlementCount += 1;
        }
      }

      // Aggregate volume/jobs for current vs previous window (by creation date).
      if (createdMs !== null) {
        if (createdMs >= windowStart && createdMs <= now) {
          currentVolume += budget;
          currentJobs += 1;
        } else if (createdMs >= prevWindowStart && createdMs < windowStart) {
          prevVolume += budget;
          prevJobs += 1;
        }
      }

      // Top-earning agents: completed jobs credited to the provider.
      if (status === "Completed" && completedMs !== null && completedMs >= windowStart) {
        const provider = String(raw.provider ?? raw.seller ?? "");
        if (provider) {
          earningsByProvider.set(provider, (earningsByProvider.get(provider) ?? 0n) + budget);
        }
      }
    }

    const days = Array.from(buckets.values()).map((b) => ({
      date: b.date,
      volume: b.volume.toString(),
      jobCount: b.jobCount,
      activeJobs: b.activeJobs,
      avgSettlementMs: b.settlementCount > 0 ? Math.round(b.settlementSum / b.settlementCount) : 0,
    }));

    const agentById = new Map<string, unknown>();
    for (const agent of agents as Array<Record<string, unknown>>) {
      const owner = String(agent.owner ?? agent.address ?? agent.publicKey ?? "");
      if (owner) agentById.set(owner, agent.id ?? null);
    }

    const topAgents = Array.from(earningsByProvider.entries())
      .map(([owner, earnings]) => ({
        id: agentById.get(owner) ?? null,
        owner,
        earnings: earnings.toString(),
      }))
      .sort((a, b) => (BigInt(b.earnings) > BigInt(a.earnings) ? 1 : -1))
      .slice(0, 10);

    const currentAvgSettlementMs =
      currentSettlementCount > 0 ? Math.round(currentSettlementSum / currentSettlementCount) : 0;
    const prevAvgSettlementMs =
      prevSettlementCount > 0 ? Math.round(prevSettlementSum / prevSettlementCount) : 0;

    const pctDelta = (current: number, previous: number): number | null => {
      if (previous === 0) return current === 0 ? 0 : null;
      return Math.round(((current - previous) / previous) * 1000) / 10;
    };

    res.json({
      days,
      topAgents,
      totals: {
        volume: currentVolume.toString(),
        jobs: currentJobs,
        avgSettlementMs: currentAvgSettlementMs,
      },
      deltas: {
        volumePct: pctDelta(Number(currentVolume), Number(prevVolume)),
        jobsPct: pctDelta(currentJobs, prevJobs),
        avgSettlementPct: pctDelta(currentAvgSettlementMs, prevAvgSettlementMs),
      },
    });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/audit-trail", requireAuth, (_req, res) => {
  try {
    res.json(auditStore.recent(MAX_AUDIT_ENTRIES));
  } catch (err: unknown) {
    handleRouteError(err, res);
  }
});

// GET /api/admin/audit — paginated persisted audit entries, newest first
app.get("/api/admin/audit", requireAuth, (req, res) => {
  try {
    const { page, pageSize } = auditQuerySchema.parse(req.query);
    const { items, total } = auditStore.page(page, pageSize);
    res.json({ items, page, pageSize, total });
  } catch (err: unknown) {
    handleRouteError(err, res);
  }
});

// GET /api/admin/audit/export — JSONL export for compatibility with old tooling
app.get("/api/admin/audit/export", requireAuth, (_req, res) => {
  try {
    const entries = auditStore.all();
    const body = entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : "");
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit-export-${Date.now()}.jsonl"`,
    );
    res.send(body);
  } catch (err: unknown) {
    handleRouteError(err, res);
  }
});

// ── #821: GET /api/jobs/:id/events — SSE stream for a single job ─────────────
app.get("/api/jobs/:id/events", (req, res) => {
  const parsedId = numericIdParamSchema.safeParse(req.params);
  if (!parsedId.success) {
    res.status(400).json({ error: "Invalid job ID" });
    return;
  }
  const jobId = parsedId.data.id;
  const contractId = getRequestNetwork(req).commerceContract;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event: string, data: unknown, id?: string) => {
    try {
      if (id) res.write(`id: ${id}\n`);
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Client disconnect cleanup runs on the response's close event.
    }
  };
  send("hello", { message: "connected", jobId: jobId.toString() });

  const onEvent = (event: SorobanEvent) => {
    if (matchesJobEvent(event, contractId, jobId)) {
      const eventType = getJobEventType(event) ?? "event";
      send(
        eventType,
        { ...event, eventType },
        event.id === undefined ? undefined : String(event.id),
      );
    }
  };
  eventHub.on("event", onEvent);

  const heartbeat = setInterval(() => {
    send("ping", { t: Date.now() });
  }, SSE_HEARTBEAT_MS);

  res.on("close", () => {
    clearInterval(heartbeat);
    eventHub.off("event", onEvent);
  });
});

// ── #719: GET /api/events/stream — SSE stream of newly indexed events ────────
// Supports filtering by contract, event_type, and address topic. Clients may
// resume after a reconnect by sending Last-Event-ID; buffered events newer than
// that id are replayed before live streaming resumes.
app.get("/api/events/stream", (req, res) => {
  const filter = parseEventFilter({
    ...req.query,
    eventType: req.query.eventType ?? req.query.filter,
  } as Record<string, unknown>);
  const lastEventId = req.header("last-event-id") ?? (req.query.lastEventId as string | undefined);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event: string, data: unknown, id?: string) => {
    try {
      if (id) res.write(`id: ${id}\n`);
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Client disconnected mid-write; cleanup happens on 'close'.
    }
  };

  send("hello", { message: "connected", filter });

  // Replay any buffered events the client missed (Last-Event-ID resume).
  if (lastEventId) {
    for (const buffered of eventHub.getBufferedEvents(lastEventId)) {
      if (eventMatchesFilter(buffered, filter)) {
        send("event", buffered, buffered.id);
      }
    }
  }

  const onEvent = (event: SorobanEvent) => {
    if (eventMatchesFilter(event, filter)) {
      send("event", event, event.id);
    }
  };

  eventHub.on("event", onEvent);

  const heartbeat = setInterval(() => {
    send("ping", { t: Date.now(), retryAfterMs: 25_000 });
  }, SSE_HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    eventHub.off("event", onEvent);
  });
});

// ── #719: GET /api/events — read indexed events from the read-only handle ────
// Uses the dedicated read-only connection (#718) so dashboard queries never
// contend with the indexer's write lock.
app.get("/api/events", async (req, res) => {
  try {
    const filter = parseEventFilter(req.query as Record<string, unknown>);
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 1000);

    if (readOnlyDb) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filter.contract) {
        clauses.push("contract_id = ?");
        params.push(filter.contract);
      }
      if (filter.eventType) {
        clauses.push("event_type = ?");
        params.push(filter.eventType);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = readOnlyDb
        .prepare(
          `SELECT id, contract_id, event_type, topics, data, ledger, tx_hash, timestamp
           FROM events ${where} ORDER BY id DESC LIMIT ?`,
        )
        .all(...params, limit) as Array<Record<string, unknown>>;
      const items = rows
        .map((row) => ({
          id: String(row.id),
          contractId: row.contract_id,
          eventType: row.event_type,
          topics: typeof row.topics === "string" ? JSON.parse(row.topics) : row.topics,
          data: typeof row.data === "string" ? JSON.parse(row.data) : row.data,
          ledger: row.ledger,
          txHash: row.tx_hash,
          timestamp: row.timestamp,
        }))
        .filter((event) => eventMatchesFilter(event as unknown as SorobanEvent, filter));
      res.json({ items, source: "read-only" });
      return;
    }

    // Fallback: use the discovery event cache when the indexer DB is absent.
    const allEvents = (await events.getEvents()) as unknown as SorobanEvent[];
    const items = allEvents
      .filter((event) => eventMatchesFilter(event, filter))
      .slice(-limit)
      .reverse();
    res.json({ items, source: "cache" });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Server-Sent Events: simple real-time stream for dashboard clients
app.get("/api/stream", (req, res) => {
  // Headers for SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      // ignore
    }
  };

  // Emit a welcome ping
  send("hello", { message: "connected" });

  const onInvalidate = (payload: unknown) => {
    send("invalidate", payload);
  };

  events.on("invalidate", onInvalidate);

  // heartbeat
  const hb = setInterval(
    () => send("ping", { t: Date.now(), retryAfterMs: 25_000 }),
    25000,
  );

  req.on("close", () => {
    clearInterval(hb);
    events.off("invalidate", onInvalidate);
  });
});

// GET /api/wallets
app.get("/api/wallets", async (req, res) => {
  try {
    const preset = getRequestNetwork(req);
    const buyerPub = buyerKeypair.publicKey();
    const sellerPub = sellerKeypair.publicKey();
    const [buyerXlm, sellerXlm, buyerMusd, sellerMusd] = await Promise.all([
      getXlmBalance(buyerPub, preset.horizonUrl),
      getXlmBalance(sellerPub, preset.horizonUrl),
      getTokenBalance(buyerPub, preset),
      getTokenBalance(sellerPub, preset),
    ]);
    res.json({
      buyer: { address: buyerPub, xlm: buyerXlm, musd: buyerMusd },
      seller: { address: sellerPub, xlm: sellerXlm, musd: sellerMusd },
    });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/agents
app.get("/api/agents", async (req, res) => {
  try {
    if (!("page" in req.query) && !("pageSize" in req.query)) {
      const agents = await tracedDb("getAllAgents", () => getAllAgents());
      res.json(serialize(agents));
      return;
    }
    const parsed = agentsQuerySchema.parse(req.query);
    const agents = await tracedDb("getAgentsPage", () => getAgentsPage(parsed.page, parsed.pageSize));
    res.json({ ...agents, items: serialize(agents.items) });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/agents/:id — rich agent profile (#975)
// Returns the agent record, its metadata (validated against the v1 schema),
// reputation and job history from the indexer. Invalid metadata yields a
// `warning` field rather than an error so the profile still renders.
app.get("/api/agents/:id", async (req, res) => {
  try {
    const agentId = String(req.params.id);
    const agents = (await tracedDb("getAllAgents", () => getAllAgents())) as unknown as Array<
      Record<string, unknown>
    >;
    const agent = agents.find(
      (a) =>
        String(a.id ?? "") === agentId ||
        String(a.owner ?? a.address ?? a.publicKey ?? "") === agentId,
    );
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    // Metadata may be embedded on the record or fetched from its URI.
    let metadata: unknown = agent.metadata ?? null;
    if (!metadata && typeof agent.uri === "string" && agent.uri.startsWith("data:")) {
      try {
        const payload = agent.uri.slice(agent.uri.indexOf(",") + 1);
        metadata = JSON.parse(
          agent.uri.includes(";base64,")
            ? Buffer.from(payload, "base64").toString("utf8")
            : decodeURIComponent(payload),
        );
      } catch {
        metadata = null;
      }
    }

    const validation = validateAgentMetadata(metadata);

    const owner = String(agent.owner ?? agent.address ?? agent.publicKey ?? "");
    const jobs = (await tracedDb("getAllJobs", () => getAllJobs())) as unknown as Array<
      Record<string, unknown>
    >;
    const agentJobs = jobs.filter(
      (job) =>
        String(job.provider ?? job.seller ?? "") === owner ||
        String(job.client ?? job.buyer ?? "") === owner,
    );

    let completed = 0;
    let disputed = 0;
    let totalEarned = 0n;
    for (const job of agentJobs) {
      const status = typeof job.status === "string" ? job.status : "";
      if (status === "Completed") {
        completed += 1;
        if (String(job.provider ?? job.seller ?? "") === owner) {
          try {
            totalEarned += BigInt(job.budget as string | number | bigint);
          } catch {
            // ignore malformed budgets
          }
        }
      } else if (status === "Disputed") {
        disputed += 1;
      }
    }

    res.json({
      agent: serialize(agent),
      metadata,
      metadataValid: validation.valid,
      ...(validation.valid ? {} : { warning: validation.error }),
      reputation: {
        completedJobs: completed,
        disputedJobs: disputed,
        totalJobs: agentJobs.length,
        totalEarned: totalEarned.toString(),
      },
      jobs: serialize(agentJobs.slice(0, 50)),
    });
  } catch (err: unknown) {
    handleRouteError(err, res);
  }
});

// POST /api/agents/match — semantic agent discovery (#736)
// Embedding-heavy: bounded by per-wallet/per-token and cost-weighted limits (#964).
app.post("/api/agents/match", rateLimitRead, rateLimitEmbeddingCost, async (req, res) => {
  try {
    const parsed = agentMatchSchema.parse(req.body);
    const started = process.hrtime.bigint();
    const results = await matchmaking.match(parsed.query, parsed.topK);
    const latencyMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    res.json({
      query: parsed.query,
      topK: parsed.topK,
      mode: matchmaking.mode,
      latencyMs: Number(latencyMs.toFixed(2)),
      results,
    });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/agents/register
app.post(
  "/api/agents/register",
  auditAdminAction,
  optionalAuthMiddleware,
  requireDashboardWallet,
  async (req, res) => {
    try {
      const parsed = registerAgentSchema.parse(req.body);
      if (parsed.wallet === "freighter") {
        const op = identityContract.call(
          "register",
          new Address(parsed.publicKey!).toScVal(),
          nativeToScVal(parsed.uri || "ipfs://dashboard-agent", { type: "string" }),
        );
        const txXdr = await buildTxXdr(parsed.publicKey!, op);
        res.json({ xdr: txXdr });
        return;
      }
      const kp = getKeypair(parsed.wallet);
      const agentId = await identity.register(kp, parsed.uri || "ipfs://dashboard-agent");
      invalidateAgents();
      // Index the newly registered agent for semantic discovery.
      await indexAgent({
        id: agentId.toString(),
        owner: kp.publicKey(),
        uri: parsed.uri || "ipfs://dashboard-agent",
      }).catch((err) => console.warn("[matchmaking] index failed:", (err as Error).message));
      res.json({ agentId: agentId.toString() });
    } catch (err: unknown) {
      handleRouteError(err, res);
    }
  },
);

// GET /api/jobs
app.get("/api/jobs", async (req, res) => {
  try {
    const parsed = jobsQuerySchema.parse(req.query);
    const page = await tracedDb("getJobsPage", () => getJobsPage(parsed.page, parsed.limit));
    let jobs = page.items;
    if (parsed.status === "Active") {
      jobs = jobs.filter((j) => j.status === "Funded" || j.status === "Submitted");
    } else if (parsed.status) {
      jobs = jobs.filter((j) => j.status === parsed.status);
    }
    res.json({
      page: page.page,
      limit: page.pageSize,
      total: page.total,
      hasNext: page.hasNext,
      items: serialize(await Promise.all(jobs.map(async (job) => ({
        ...job,
        evaluatorProgress: await commerce.getEvaluatorProgress(job.id).catch(() => null),
      })))),
    });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/jobs/create
// #961: CSRF-protected — cookie-authenticated requests must present a valid
// double-submit token; bearer-token auth is the supported transport.
app.post(
  "/api/jobs/create",
  csrfProtection,
  auditAdminAction,
  optionalAuthMiddleware,
  requireDashboardWallet,
  async (req, res) => {
  try {
    const parsed = createJobSchema.parse(req.body);
    const { wallet, provider, evaluator, budget, description } = parsed;
    const kp = getKeypair(wallet);
    const providerAddr = provider || sellerKeypair.publicKey();
    const evaluatorAddr = evaluator || kp.publicKey();
    const budgetBn = BigInt(budget || 10_000_000); // default 1 MUSD

    const agentId = await identity.agentOf(providerAddr);
    if (agentId === null) {
      res.status(400).json({ error: `Provider ${providerAddr} is not a registered agent` });
      return;
    }

    const jobId = await commerce.createJob(
      kp,
      providerAddr,
      evaluatorAddr,
      cfg.usdcToken,
      budgetBn,
      description || "Dashboard test job",
    );
    invalidateJobs();
    res.json({ jobId: jobId.toString() });
  } catch (err: unknown) {
    handleRouteError(err, res);
  }
  },
);

// POST /api/jobs/:id/submit
app.post(
  "/api/jobs/:id/submit",
  auditAdminAction,
  optionalAuthMiddleware,
  requireDashboardWallet,
  async (req, res) => {
    try {
      const params = numericIdParamSchema.parse(req.params);
      const parsed = submitJobSchema.parse(req.body);
      const deliverable = parsed.deliverable || "ipfs://dashboard-delivery";
      const inspection = await deliverableValidator.validate(deliverable);
      if (!inspection.valid) {
        res.status(400).json({
          error: "Deliverable rejected by content inspection",
          details: inspection.errors,
        });
        return;
      }
      const kp = getKeypair(parsed.wallet);
      await commerce.submit(kp, params.id, deliverable);
      invalidateJobs();
      res.json({ success: true, warnings: inspection.warnings });
    } catch (err: unknown) {
      handleRouteError(err, res);
    }
  },
);

app.post(
  "/api/jobs/:id/approve",
  auditAdminAction,
  optionalAuthMiddleware,
  requireDashboardWallet,
  async (req, res) => {
    try {
      const params = numericIdParamSchema.parse(req.params);
      const parsed = walletOnlySchema.parse(req.body);
      const kp = getKeypair(parsed.wallet);
      const approvals = await commerce.approveJob(kp, params.id);
      invalidateJobs();
      res.json({ approvals });
    } catch (err: unknown) {
      handleRouteError(err, res);
    }
  },
);

// POST /api/jobs/:id/complete
app.post(
  "/api/jobs/:id/complete",
  auditAdminAction,
  optionalAuthMiddleware,
  requireDashboardWallet,
  async (req, res) => {
    try {
      const params = numericIdParamSchema.parse(req.params);
      const parsed = walletOnlySchema.parse(req.body);
      const kp = getKeypair(parsed.wallet);
      await commerce.complete(kp, params.id);
      invalidateJobs();
      res.json({ success: true });
    } catch (err: unknown) {
      handleRouteError(err, res);
    }
  },
);

// POST /api/jobs/:id/cancel
app.post(
  "/api/jobs/:id/cancel",
  auditAdminAction,
  optionalAuthMiddleware,
  requireDashboardWallet,
  async (req, res) => {
    try {
      const params = numericIdParamSchema.parse(req.params);
      const parsed = walletOnlySchema.parse(req.body);
      const kp = getKeypair(parsed.wallet);
      await commerce.cancel(kp, params.id);
      invalidateJobs();
      res.json({ success: true });
    } catch (err: unknown) {
      handleRouteError(err, res);
    }
  },
);

// PUT /api/jobs/:id — cancel a job; builds unsigned XDR when publicKey provided,
// or invokes directly when wallet (server keypair) is provided.
app.put("/api/jobs/:id", auditAdminAction, optionalAuthMiddleware, requireDashboardWallet, async (req, res) => {
  try {
    const { action, publicKey, wallet } = req.body;
    if (action !== "cancel") {
      res.status(400).json({ error: "unsupported action; use action: 'cancel'" });
      return;
    }
    const jobId = BigInt(req.params.id);

    if (publicKey) {
      const validPublicKey = stellarAddressSchema.parse(publicKey);
      // Freighter path: return unsigned XDR for client-side signing
      const op = commerceContract.call(
        "cancel",
        new Address(validPublicKey).toScVal(),
        nativeToScVal(jobId, { type: "u64" }),
      );
      const txXdr = await buildTxXdr(validPublicKey, op);
      res.json({ xdr: txXdr });
    } else {
      // Server-keypair path: sign and submit directly
      const kp = getKeypair(wallet);
      await commerce.cancel(kp, jobId);
      invalidateJobs();
      res.json({ success: true });
    }
  } catch (err: unknown) {
    handleRouteError(err, res);
  }
});

// #961: CSRF-protected mutating route.
app.post("/api/dispute-job", csrfProtection, optionalAuthMiddleware, requireDashboardWallet, async (req, res) => {
  try {
    const parsed = buildUnsignedActionSchema.parse(req.body);
    const op = commerceContract.call(
      "dispute",
      new Address(parsed.publicKey).toScVal(),
      nativeToScVal(BigInt(parsed.jobId), { type: "u64" }),
    );
    const txXdr = await buildTxXdr(parsed.publicKey, op);
    res.json({ xdr: txXdr });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(500).json({ error: (err as Error).message });
  }
});

// #961: CSRF-protected mutating route.
app.post("/api/claim-refund", csrfProtection, optionalAuthMiddleware, requireDashboardWallet, async (req, res) => {
  try {
    const parsed = buildUnsignedActionSchema.parse(req.body);
    const op = commerceContract.call(
      "claim_refund",
      new Address(parsed.publicKey).toScVal(),
      nativeToScVal(BigInt(parsed.jobId), { type: "u64" }),
    );
    const txXdr = await buildTxXdr(parsed.publicKey, op);
    res.json({ xdr: txXdr });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(500).json({ error: (err as Error).message });
  }
});

// --- Freighter wallet endpoints: build unsigned XDR ---

const pendingTxHashes = new Set<string>();

/** Build an unsigned, simulated transaction and return its XDR */
async function buildTxXdr(
  publicKey: string,
  op: xdr.Operation,
  preset: NetworkPreset = NETWORK_PRESETS[DEFAULT_NETWORK_ID],
): Promise<string> {
  const account = await withNetworkRpc(preset, (rpcServer) => rpcServer.getAccount(publicKey));
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: preset.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();
  const prepared = await withNetworkRpc(preset, (rpcServer) => rpcServer.prepareTransaction(tx));
  const hash = prepared.hash().toString("hex");
  pendingTxHashes.add(hash);
  return prepared.toXDR();
}

// POST /api/build/register — build unsigned register agent tx
app.post(
  "/api/build/register",
  rateLimitMutating,
  optionalAuthMiddleware,
  requireDashboardWallet,
  async (req, res) => {
    try {
      const parsed = buildRegisterSchema.parse(req.body);
      const op = identityContract.call(
        "register",
        new Address(parsed.publicKey).toScVal(),
        nativeToScVal(parsed.uri || "ipfs://dashboard-agent", { type: "string" }),
      );
      const txXdr = await buildTxXdr(parsed.publicKey, op);
      res.json({ xdr: txXdr });
    } catch (err: unknown) {
      if (respondWithValidationError(err, res)) return;
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// POST /api/build/createJob — build unsigned create_job tx
app.post(
  "/api/build/createJob",
  rateLimitMutating,
  optionalAuthMiddleware,
  requireDashboardWallet,
  async (req, res) => {
    try {
      const parsed = buildCreateJobSchema.parse(req.body);
      const providerAddr = parsed.provider || sellerKeypair.publicKey();
      const evaluatorAddr = parsed.evaluator || parsed.publicKey;
      const budgetBn = parseBudget(parsed.budget);

      const agentId = await identity.agentOf(providerAddr);
      if (agentId === null) {
        res.status(400).json({ error: `Provider ${providerAddr} is not a registered agent` });
        return;
      }

      const op = commerceContract.call(
        "create_job",
        new Address(parsed.publicKey).toScVal(),
        new Address(providerAddr).toScVal(),
        new Address(evaluatorAddr).toScVal(),
        new Address(cfg.usdcToken).toScVal(),
        nativeToScVal(budgetBn, { type: "i128" }),
        nativeToScVal(parsed.description || "Dashboard test job", { type: "string" }),
      );
      const txXdr = await buildTxXdr(parsed.publicKey, op);
      res.json({ xdr: txXdr });
    } catch (err: unknown) {
      if (respondWithValidationError(err, res)) return;
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// POST /api/build/submit — build unsigned submit tx
// #961: CSRF-protected; #963: uses the larger body limit mounted above.
app.post("/api/build/submit", csrfProtection, rateLimitMutating, optionalAuthMiddleware, requireDashboardWallet, async (req, res) => {
  try {
    const parsed = buildUnsignedActionSchema.parse(req.body);
    const deliverable = req.body.deliverable || "ipfs://dashboard-delivery";
    const inspection = await deliverableValidator.validate(deliverable);
    if (!inspection.valid) {
      res.status(400).json({
        error: "Deliverable rejected by content inspection",
        details: inspection.errors,
      });
      return;
    }
    const op = commerceContract.call(
      "submit",
      new Address(parsed.publicKey).toScVal(),
      nativeToScVal(BigInt(parsed.jobId), { type: "u64" }),
      nativeToScVal(deliverable, { type: "string" }),
    );
    const txXdr = await buildTxXdr(parsed.publicKey, op);
    res.json({ xdr: txXdr, warnings: inspection.warnings });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/build/complete — build unsigned complete tx
app.post(
  "/api/build/complete",
  rateLimitMutating,
  optionalAuthMiddleware,
  requireDashboardWallet,
  async (req, res) => {
    try {
      const parsed = buildUnsignedActionSchema.parse(req.body);
      const op = commerceContract.call(
        "complete",
        new Address(parsed.publicKey).toScVal(),
        nativeToScVal(BigInt(parsed.jobId), { type: "u64" }),
      );
      const txXdr = await buildTxXdr(parsed.publicKey, op);
      res.json({ xdr: txXdr });
    } catch (err: unknown) {
      if (respondWithValidationError(err, res)) return;
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

app.post(
  "/api/build/approve",
  rateLimitMutating,
  optionalAuthMiddleware,
  requireDashboardWallet,
  async (req, res) => {
    try {
      const parsed = buildUnsignedActionSchema.parse(req.body);
      const op = commerceContract.call(
        "approve_job",
        new Address(parsed.publicKey).toScVal(),
        nativeToScVal(BigInt(parsed.jobId), { type: "u64" }),
      );
      const txXdr = await buildTxXdr(parsed.publicKey, op);
      res.json({ xdr: txXdr });
    } catch (err: unknown) {
      if (respondWithValidationError(err, res)) return;
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// POST /api/build/cancel — build unsigned cancel tx
app.post("/api/build/cancel", rateLimitMutating, optionalAuthMiddleware, requireDashboardWallet, async (req, res) => {
  try {
    const parsed = buildUnsignedActionSchema.parse(req.body);
    const op = commerceContract.call(
      "cancel",
      new Address(parsed.publicKey).toScVal(),
      nativeToScVal(BigInt(parsed.jobId), { type: "u64" }),
    );
    const txXdr = await buildTxXdr(parsed.publicKey, op);
    res.json({ xdr: txXdr });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/submit — submit a Freighter-signed transaction
app.post("/api/submit", rateLimitMutating, optionalAuthMiddleware, async (req, res) => {
  try {
    const preset = getRequestNetwork(req);
    const parsed = submitXdrSchema.parse(req.body);
    const tx = TransactionBuilder.fromXDR(parsed.signedXdr, preset.networkPassphrase);
    const submitHash = tx.hash().toString("hex");
    if (!pendingTxHashes.has(submitHash)) {
      res.status(400).json({ error: "Transaction XDR was not generated by this server" });
      return;
    }
    pendingTxHashes.delete(submitHash);

    const sent = await withNetworkRpc(preset, (rpcServer) => rpcServer.sendTransaction(tx));
    if (sent.status === "ERROR") {
      throw new Error(`submit failed: ${sent.errorResult}`);
    }
    let getResp = await withNetworkRpc(preset, (rpcServer) => rpcServer.getTransaction(sent.hash));
    while (getResp.status === "NOT_FOUND") {
      await new Promise((r) => setTimeout(r, 1000));
      getResp = await withNetworkRpc(preset, (rpcServer) => rpcServer.getTransaction(sent.hash));
    }
    if (getResp.status !== "SUCCESS") {
      throw new Error(`tx failed: ${getResp.status}`);
    }
    // Decode return value if present
    let returnValue: unknown = null;
    if (getResp.returnValue) {
      try {
        returnValue = scValToNative(getResp.returnValue);
      } catch {
        // non-decodable return value, ignore
      }
    }
    invalidateAgents();
    invalidateJobs();
    stellarEventsIngestedTotal.inc({ contract: cfg.commerceContract, type: "transaction" });
    res.json({ hash: sent.hash, returnValue: String(returnValue ?? "") });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(500).json({ error: (err as Error).message });
  }
});

// --- #738: Revenue analytics & transaction accounting export ---

const revenueReportQuerySchema = z.object({
  wallet: stellarAddressSchema,
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  format: z.enum(["csv", "json"]).default("json"),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(1000).default(100),
});

type RevenueRow = {
  timestamp: number;
  transactionHash: string;
  ledger: number;
  jobId: string;
  role: "provider" | "client";
  token: string;
  grossAmount: string;
  feeAmount: string;
  netAmount: string;
};

type RevenueAggregate = {
  period: string;
  grossAmount: string;
  feeAmount: string;
  netAmount: string;
  count: number;
};

/** Escape a single CSV field per RFC 4180 (quote if it contains , " \r or \n). */
function csvEscape(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Serialize rows to RFC 4180 CSV with CRLF line endings. */
function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** Format a Unix timestamp (seconds) as an ISO-8601 UTC date-time string. */
function formatTimestamp(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function dayKey(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function monthKey(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 7);
}

function aggregateRevenue(rows: RevenueRow[], keyFn: (ts: number) => string): RevenueAggregate[] {
  const buckets = new Map<string, { gross: bigint; fee: bigint; net: bigint; count: number }>();
  for (const row of rows) {
    const key = keyFn(row.timestamp);
    const bucket = buckets.get(key) ?? { gross: 0n, fee: 0n, net: 0n, count: 0 };
    bucket.gross += BigInt(row.grossAmount);
    bucket.fee += BigInt(row.feeAmount);
    bucket.net += BigInt(row.netAmount);
    bucket.count += 1;
    buckets.set(key, bucket);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([period, b]) => ({
      period,
      grossAmount: b.gross.toString(),
      feeAmount: b.fee.toString(),
      netAmount: b.net.toString(),
      count: b.count,
    }));
}

/**
 * Extract accounting rows from a JobCompleted event payload. The event data is
 * expected to carry the job id, provider, client, token, gross budget and fee.
 * Amounts are normalized to raw token units (strings) so gross - fee = net
 * reconciles exactly with on-chain transfers.
 */
function extractRevenueRow(
  event: any,
  wallet: string,
): RevenueRow | null {
  const data = event?.data ?? event?.value ?? event ?? {};
  const jobId = data.jobId ?? data.job_id ?? event?.jobId ?? event?.job_id;
  const provider = data.provider ?? event?.provider;
  const client = data.client ?? data.buyer ?? event?.client ?? event?.buyer;
  const token = data.token ?? event?.token ?? cfg.usdcToken;
  const grossRaw = data.budget ?? data.grossAmount ?? data.gross_amount ?? event?.budget;
  const feeRaw = data.fee ?? data.feeAmount ?? data.fee_amount ?? 0;

  if (jobId === undefined || jobId === null) return null;
  if (grossRaw === undefined || grossRaw === null) return null;

  let role: "provider" | "client" | null = null;
  if (provider === wallet) role = "provider";
  else if (client === wallet) role = "client";
  if (!role) return null;

  const gross = BigInt(grossRaw);
  const fee = BigInt(feeRaw);
  const net = gross - fee;

  const ledger = Number(event?.ledger ?? event?.ledgerSequence ?? 0);
  const txHash = String(event?.txHash ?? event?.transactionHash ?? event?.tx_hash ?? "");
  const ts = Number(event?.timestamp ?? event?.closedAt ?? event?.ledgerClosedAt ?? 0);
  const timestamp = Number.isFinite(ts) && ts > 0 ? ts : Math.floor(Date.now() / 1000);

  return {
    timestamp,
    transactionHash: txHash,
    ledger,
    jobId: String(jobId),
    role,
    token: String(token),
    grossAmount: gross.toString(),
    feeAmount: fee.toString(),
    netAmount: net.toString(),
  };
}

// GET /api/reports/revenue — export revenue ledger as CSV or JSON
app.get("/api/reports/revenue", async (req, res) => {
  try {
    const parsed = revenueReportQuerySchema.parse(req.query);
    if (parsed.from !== undefined && parsed.to !== undefined && parsed.from > parsed.to) {
      res.status(400).json({ error: "'from' must be less than or equal to 'to'" });
      return;
    }

    const allEvents = await events.getEvents();
    const rows: RevenueRow[] = [];
    for (const ev of allEvents as any[]) {
      const name = ev?.type ?? ev?.name ?? ev?.topic?.[0];
      if (name !== "JobCompleted" && name !== "job_completed") continue;
      const row = extractRevenueRow(ev, parsed.wallet);
      if (!row) continue;
      if (parsed.from !== undefined && row.timestamp < parsed.from) continue;
      if (parsed.to !== undefined && row.timestamp > parsed.to) continue;
      rows.push(row);
    }

    rows.sort((a, b) => a.timestamp - b.timestamp);

    const daily = aggregateRevenue(rows, dayKey);
    const monthly = aggregateRevenue(rows, monthKey);

    const totalGross = rows.reduce((acc, r) => acc + BigInt(r.grossAmount), 0n);
    const totalFee = rows.reduce((acc, r) => acc + BigInt(r.feeAmount), 0n);
    const totalNet = rows.reduce((acc, r) => acc + BigInt(r.netAmount), 0n);

    const total = rows.length;
    const offset = (parsed.page - 1) * parsed.pageSize;
    const pageRows = rows.slice(offset, offset + parsed.pageSize);

    const headers = [
      "Timestamp",
      "TransactionHash",
      "Ledger",
      "JobId",
      "Role",
      "Token",
      "GrossAmount",
      "FeeAmount",
      "NetAmount",
    ];

    const filename = `revenue-report-${parsed.wallet.slice(0, 8)}-${Date.now()}`;

    if (parsed.format === "csv") {
      const csvRows = pageRows.map((r) => [
        formatTimestamp(r.timestamp),
        r.transactionHash,
        r.ledger,
        r.jobId,
        r.role,
        r.token,
        r.grossAmount,
        r.feeAmount,
        r.netAmount,
      ]);
      const csv = toCsv(headers, csvRows);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}.csv"`);
      res.send(csv);
      return;
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}.json"`);
    res.json({
      wallet: parsed.wallet,
      from: parsed.from ?? null,
      to: parsed.to ?? null,
      pagination: {
        page: parsed.page,
        pageSize: parsed.pageSize,
        total,
        hasNext: offset + parsed.pageSize < total,
      },
      totals: {
        grossAmount: totalGross.toString(),
        feeAmount: totalFee.toString(),
        netAmount: totalNet.toString(),
        count: total,
      },
      daily,
      monthly,
      rows: pageRows.map((r) => ({
        Timestamp: formatTimestamp(r.timestamp),
        TransactionHash: r.transactionHash,
        Ledger: r.ledger,
        JobId: r.jobId,
        Role: r.role,
        Token: r.token,
        GrossAmount: r.grossAmount,
        FeeAmount: r.feeAmount,
        NetAmount: r.netAmount,
      })),
    });
  } catch (err: unknown) {
    handleRouteError(err, res);
  }
});

// GET /api/balance/:pubkey — get XLM + MUSD balance for any public key
app.get("/api/balance/:pubkey", async (req, res) => {
  try {
    const preset = getRequestNetwork(req);
    const params = z.object({ pubkey: stellarAddressSchema }).parse(req.params);
    const [xlm, musd] = await Promise.all([
      getXlmBalance(params.pubkey, preset.horizonUrl),
      getTokenBalance(params.pubkey, preset),
    ]);
    res.json({ address: params.pubkey, xlm, musd });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(500).json({ error: (err as Error).message });
  }
});

// Dashboard SPA fallback (anything under /app)
app.get("/app/*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  // #963: Oversized bodies are rejected by express.json with a 413 status.
  if (
    err &&
    typeof err === "object" &&
    ((err as { type?: string }).type === "entity.too.large" ||
      (err as { status?: number }).status === 413)
  ) {
    return res.status(413).json({ error: "Request body too large" });
  }
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "Malformed JSON payload" });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ error: "Invalid request payload", details: err.issues });
  }
  console.error("Unhandled server error:", err);
  res.status(500).json({ error: "Internal server error" });
}

app.use(errorHandler);

const PORT = Number(process.env.PORT ?? process.env.DASHBOARD_PORT ?? 3000);
const httpServer = app.listen(PORT, () => {
  console.log(`Bear Dashboard → http://localhost:${PORT}`);
  console.log(`  Buyer:  ${buyerKeypair.publicKey()}`);
  console.log(`  Seller: ${sellerKeypair.publicKey()}`);
  void warmMatchmakingIndex();
});

// ── #719: WebSocket endpoint /events — bi-directional subscription management ─
// Clients send { action: "subscribe", contract?, eventType?, address? } to set
// their filter and { action: "unsubscribe" } to clear it. Newly indexed events
// matching the active filter are pushed as { type: "event", event }. A heartbeat
// ping is sent every 30 seconds to keep intermediaries from closing the socket.
const wss = new WebSocketServer({ server: httpServer, path: "/events" });

wss.on("connection", (socket: WebSocket) => {
  let filter: EventFilter = {};

  const sendJson = (payload: unknown) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  };

  const onEvent = (event: SorobanEvent) => {
    if (eventMatchesFilter(event, filter)) {
      sendJson({ type: "event", event });
    }
  };

  eventHub.on("event", onEvent);

  const heartbeat = setInterval(() => {
    sendJson({ type: "ping", t: Date.now() });
  }, WS_HEARTBEAT_MS);

  socket.on("message", (raw) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      sendJson({ type: "error", error: "invalid JSON" });
      return;
    }
    const action = message.action ?? message.type;
    if (action === "subscribe") {
      filter = parseEventFilter(message);
      sendJson({ type: "subscribed", filter });
    } else if (action === "unsubscribe") {
      filter = {};
      sendJson({ type: "unsubscribed" });
    } else if (action === "ping") {
      sendJson({ type: "pong", t: Date.now() });
    } else {
      sendJson({ type: "error", error: `unknown action: ${String(action)}` });
    }
  });

  socket.on("close", () => {
    clearInterval(heartbeat);
    eventHub.off("event", onEvent);
  });

  socket.on("error", () => {
    clearInterval(heartbeat);
    eventHub.off("event", onEvent);
  });

  sendJson({ type: "hello", message: "connected" });
});

export { app, matchmaking, httpServer, wss, readOnlyDb, auditStore };
export {
  readWalletRateLimiter,
  readTokenRateLimiter,
  embeddingCostRateLimiter,
  mutatingRateLimiter,
};
