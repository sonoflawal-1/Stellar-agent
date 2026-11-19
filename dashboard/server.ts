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
import { WebSocketServer, type WebSocket } from "ws";
import { getReadOnlyDb } from "../../indexer/src/db.js";
import { eventHub, type SorobanEvent } from "../../indexer/src/events.js";
import { getJobEventType, matchesJobEvent } from "./lib/jobEvents.js";

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
        connectSrc: ["'self'", ...STELLAR_CONNECT_SRCS, "wss:"],
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
app.use(express.json());

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

type AuditEntry = {
  at: string;
  method: string;
  path: string;
  wallet?: string;
  statusCode: number;
  ipHash?: string;
};

const MAX_AUDIT_ENTRIES = 500;
const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH ?? path.join(__dirname, "audit.jsonl");
const AUDIT_LOG_MAX_BYTES = 10 * 1024 * 1024;
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

// Rotated files are AUDIT_LOG_PATH.1 (newest) … AUDIT_LOG_PATH.<MAX_FILES - 1> (oldest).
function auditLogFiles(): string[] {
  const files = [AUDIT_LOG_PATH];
  for (let i = 1; i < AUDIT_LOG_MAX_FILES; i++) files.push(`${AUDIT_LOG_PATH}.${i}`);
  return files;
}

function rotateAuditLog(): void {
  const files = auditLogFiles();
  for (let i = files.length - 1; i > 0; i--) {
    if (fs.existsSync(files[i - 1])) fs.renameSync(files[i - 1], files[i]);
  }
}

function appendAuditEntry(entry: AuditEntry): void {
  const line = JSON.stringify(entry) + "\n";
  try {
    if (
      fs.existsSync(AUDIT_LOG_PATH) &&
      fs.statSync(AUDIT_LOG_PATH).size + Buffer.byteLength(line) > AUDIT_LOG_MAX_BYTES
    ) {
      rotateAuditLog();
    }
    fs.appendFileSync(AUDIT_LOG_PATH, line);
  } catch (err) {
    console.warn("[audit] failed to persist entry:", (err as Error).message);
  }
}

/** All persisted audit entries, oldest first. */
function readAuditLog(): AuditEntry[] {
  const entries: AuditEntry[] = [];
  for (const file of auditLogFiles().reverse()) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // Skip a partially written line.
      }
    }
  }
  return entries;
}

const auditTrail: AuditEntry[] = (() => {
  try {
    return readAuditLog().slice(-MAX_AUDIT_ENTRIES);
  } catch (err) {
    console.warn("[audit] failed to load persisted entries:", (err as Error).message);
    return [];
  }
})();

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
    auditTrail.push(entry);
    if (auditTrail.length > MAX_AUDIT_ENTRIES) {
      auditTrail.splice(0, auditTrail.length - MAX_AUDIT_ENTRIES);
    }
    appendAuditEntry(entry);
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
    if (!