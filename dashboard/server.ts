import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";
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
} from "@stellar/stellar-sdk";
import { cfg, buyerKeypair, sellerKeypair, getKeypair, DEMO_MODE } from "./lib/config.js";
import {
  getAllAgents,
  getAgentsPage,
  getAllJobs,
  invalidateAgents,
  invalidateJobs,
  identity,
  commerce,
  events,
  getFeeBps,
} from "./lib/discovery.js";
import {
  generateNonce,
  verifyNonceSignature,
  createSession,
  verifySession,
  invalidateSession,
  requireAuth,
  requireMatchingWallet,
} from "./lib/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// CSP is disabled: the dashboard loads the wallet-kit bundle from a CDN and
// fonts from Google Fonts, which helmet's default script-src/style-src would block.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());

// Landing page at root
const landingDir = path.join(__dirname, "..", "landing");
app.use(express.static(landingDir));

// Dashboard at /app
app.use("/app", express.static(path.join(__dirname, "public")));

const server = new rpc.Server(cfg.rpcUrl, {
  allowHttp: cfg.rpcUrl.startsWith("http://"),
});

const identityContract = new Contract(cfg.identityContract);
const commerceContract = new Contract(cfg.commerceContract);

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:5173",
  process.env.ALLOWED_ORIGIN,
].filter(Boolean) as string[];

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

const jobsQuerySchema = z.object({
  status: z.string().min(1).optional(),
});

const agentsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(24),
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

app.get("/health", (_req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));
app.get("/healthz", (_req, res) => res.send("ok"));

// --- Authentication Endpoints ---

/** GET /api/auth/challenge — Request a nonce to sign for wallet verification */
app.get("/api/auth/challenge", async (req, res) => {
  try {
    const publicKeySchema = z.object({
      publicKey: stellarAddressSchema,
    });
    const parsed = publicKeySchema.parse(req.query);
    const nonce = generateNonce(parsed.publicKey);
    const account = await server.getAccount(parsed.publicKey);
    const challengeTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: cfg.networkPassphrase,
    })
      .addOperation(Operation.manageData({ name: "marc-auth", value: nonce }))
      .setTimeout(300)
      .build();
    res.json({
      nonce,
      message: `Sign this nonce to authenticate: ${nonce}`,
      xdr: challengeTx.toXDR(),
    });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * POST /api/auth/verify — Verify signed nonce and receive session token.
 * Body: { publicKey, nonce, signedXdr }
 */
app.post("/api/auth/verify", (req, res) => {
  try {
    const authSchema = z.object({
      publicKey: stellarAddressSchema,
      nonce: z.string().min(1),
      signedXdr: z.string().min(1),
    });
    const parsed = authSchema.parse(req.body);

    // Verify the signature proves wallet ownership
    if (!verifyNonceSignature(parsed.publicKey, parsed.nonce, parsed.signedXdr)) {
      res.status(401).json({ error: "Invalid signature or expired nonce" });
      return;
    }

    // Create authenticated session
    const token = createSession(parsed.publicKey);
    res.json({ token, publicKey: parsed.publicKey });
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
        "Authentication required. Use /api/auth/challenge and /api/auth/verify to authenticate.",
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
  process.env.HORIZON_URL ??
  (cfg.networkPassphrase === Networks.PUBLIC
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org");

/** Get XLM balance from Horizon */
async function getXlmBalance(pubkey: string): Promise<string> {
  try {
    const resp = await fetch(`${HORIZON_URL}/accounts/${pubkey}`);
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
async function simulateReadCall(contract: Contract, method: string): Promise<unknown> {
  const op = contract.call(method);
  const ephemeral = Keypair.random();
  const dummy = new Account(ephemeral.publicKey(), "0");
  const tx = new TransactionBuilder(dummy, {
    fee: BASE_FEE,
    networkPassphrase: cfg.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return null;
  const result = (sim as rpc.Api.SimulateTransactionSuccessResponse).result;
  if (!result) return null;
  return scValToNative(result.retval);
}

const tokenDecimalsCache = new Map<string, number>();

/** Query and cache a SAC token's `decimals()` value, defaulting to 7 on failure */
async function getTokenDecimals(tokenAddress: string): Promise<number> {
  const cached = tokenDecimalsCache.get(tokenAddress);
  if (cached !== undefined) return cached;
  try {
    const decimals = Number(await simulateReadCall(new Contract(tokenAddress), "decimals"));
    if (!Number.isFinite(decimals)) return 7;
    tokenDecimalsCache.set(tokenAddress, decimals);
    return decimals;
  } catch {
    return 7;
  }
}

/** Get MUSD (SAC) balance via Soroban simulate */
async function getTokenBalance(pubkey: string): Promise<string> {
  try {
    const contract = new Contract(cfg.usdcToken);
    const op = contract.call("balance", new Address(pubkey).toScVal());
    const ephemeral = Keypair.random();
    const dummy = new Account(ephemeral.publicKey(), "0");
    const tx = new TransactionBuilder(dummy, {
      fee: BASE_FEE,
      networkPassphrase: cfg.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) return "0";
    const result = (sim as rpc.Api.SimulateTransactionSuccessResponse).result;
    if (!result) return "0";
    const raw = scValToNative(result.retval);
    const val = BigInt(raw);
    const decimals = await getTokenDecimals(cfg.usdcToken);
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

// GET /api/stats
app.get("/api/stats", async (_req, res) => {
  try {
    const [agents, jobs, feeBps] = await Promise.all([getAllAgents(), getAllJobs(), getFeeBps()]);
    const activeJobs = jobs.filter((j) => j.status === "Funded" || j.status === "Submitted").length;
    res.json({
      totalAgents: agents.length,
      totalJobs: jobs.length,
      activeJobs,
      feeBps,
    });
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
  const hb = setInterval(() => send("ping", { t: Date.now() }), 25000);

  req.on("close", () => {
    clearInterval(hb);
    events.off("invalidate", onInvalidate);
  });
});

// GET /api/wallets
app.get("/api/wallets", async (_req, res) => {
  try {
    const buyerPub = buyerKeypair.publicKey();
    const sellerPub = sellerKeypair.publicKey();
    const [buyerXlm, sellerXlm, buyerMusd, sellerMusd] = await Promise.all([
      getXlmBalance(buyerPub),
      getXlmBalance(sellerPub),
      getTokenBalance(buyerPub),
      getTokenBalance(sellerPub),
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
      const agents = await getAllAgents();
      res.json(serialize(agents));
      return;
    }
    const parsed = agentsQuerySchema.parse(req.query);
    const agents = await getAgentsPage(parsed.page, parsed.pageSize);
    res.json({ ...agents, items: serialize(agents.items) });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/agents/register
app.post(
  "/api/agents/register",
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
    let jobs = await getAllJobs();
    if (parsed.status === "Active") {
      jobs = jobs.filter((j) => j.status === "Funded" || j.status === "Submitted");
    } else if (parsed.status) {
      jobs = jobs.filter((j) => j.status === parsed.status);
    }
    res.json(serialize(jobs));
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/jobs/create
app.post("/api/jobs/create", optionalAuthMiddleware, requireDashboardWallet, async (req, res) => {
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
});

// POST /api/jobs/:id/submit
app.post(
  "/api/jobs/:id/submit",
  optionalAuthMiddleware,
  requireDashboardWallet,
  async (req, res) => {
    try {
      const params = numericIdParamSchema.parse(req.params);
      const parsed = submitJobSchema.parse(req.body);
      const kp = getKeypair(parsed.wallet);
      await commerce.submit(kp, params.id, parsed.deliverable || "ipfs://dashboard-delivery");
      invalidateJobs();
      res.json({ success: true });
    } catch (err: unknown) {
      handleRouteError(err, res);
    }
  },
);

// POST /api/jobs/:id/complete
app.post(
  "/api/jobs/:id/complete",
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
app.put("/api/jobs/:id", optionalAuthMiddleware, requireDashboardWallet, async (req, res) => {
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

// --- Freighter wallet endpoints: build unsigned XDR ---

const pendingTxHashes = new Set<string>();

/** Build an unsigned, simulated transaction and return its XDR */
async function buildTxXdr(publicKey: string, op: xdr.Operation): Promise<string> {
  const account = await server.getAccount(publicKey);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: cfg.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();
  const prepared = await server.prepareTransaction(tx);
  const hash = prepared.hash().toString("hex");
  pendingTxHashes.add(hash);
  return prepared.toXDR();
}

// POST /api/build/register — build unsigned register agent tx
app.post(
  "/api/build/register",
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
app.post("/api/build/submit", optionalAuthMiddleware, requireDashboardWallet, async (req, res) => {
  try {
    const parsed = buildUnsignedActionSchema.parse(req.body);
    const op = commerceContract.call(
      "submit",
      new Address(parsed.publicKey).toScVal(),
      nativeToScVal(BigInt(parsed.jobId), { type: "u64" }),
      nativeToScVal(req.body.deliverable || "ipfs://dashboard-delivery", { type: "string" }),
    );
    const txXdr = await buildTxXdr(parsed.publicKey, op);
    res.json({ xdr: txXdr });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/build/complete — build unsigned complete tx
app.post(
  "/api/build/complete",
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

// POST /api/build/cancel — build unsigned cancel tx
app.post("/api/build/cancel", optionalAuthMiddleware, requireDashboardWallet, async (req, res) => {
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
app.post("/api/submit", optionalAuthMiddleware, async (req, res) => {
  try {
    const parsed = submitXdrSchema.parse(req.body);
    const tx = TransactionBuilder.fromXDR(parsed.signedXdr, cfg.networkPassphrase);
    const submitHash = tx.hash().toString("hex");
    if (!pendingTxHashes.has(submitHash)) {
      res.status(400).json({ error: "Transaction XDR was not generated by this server" });
      return;
    }
    pendingTxHashes.delete(submitHash);

    const sent = await server.sendTransaction(tx);
    if (sent.status === "ERROR") {
      throw new Error(`submit failed: ${sent.errorResult}`);
    }
    let getResp = await server.getTransaction(sent.hash);
    while (getResp.status === "NOT_FOUND") {
      await new Promise((r) => setTimeout(r, 1000));
      getResp = await server.getTransaction(sent.hash);
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
    res.json({ hash: sent.hash, returnValue: String(returnValue ?? "") });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/balance/:pubkey — get XLM + MUSD balance for any public key
app.get("/api/balance/:pubkey", async (req, res) => {
  try {
    const params = z.object({ pubkey: stellarAddressSchema }).parse(req.params);
    const [xlm, musd] = await Promise.all([
      getXlmBalance(params.pubkey),
      getTokenBalance(params.pubkey),
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
app.listen(PORT, () => {
  console.log(`Bear Dashboard → http://localhost:${PORT}`);
  console.log(`  Buyer:  ${buyerKeypair.publicKey()}`);
  console.log(`  Seller: ${sellerKeypair.publicKey()}`);
});
