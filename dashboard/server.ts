import express, { type Request, type Response, type NextFunction } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { z, ZodError } from "zod";
import { Keypair, rpc, Account, TransactionBuilder, BASE_FEE, Address, nativeToScVal, Contract, xdr, scValToNative } from "@stellar/stellar-sdk";
import { cfg, buyerKeypair, sellerKeypair, getKeypair, DEMO_MODE } from "./lib/config.js";
import {
  getAllAgents,
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
app.use(express.json());

// Landing page at root
const landingDir = path.join(__dirname, "..", "landing");
app.use(express.static(landingDir));

// Dashboard at /app
app.use("/app", express.static(path.join(__dirname, "public")));

const server = new rpc.Server(cfg.rpcUrl, {
  allowHttp: cfg.rpcUrl.startsWith("http://"),
});

const allowedOrigins = new Set(
  (process.env.DASHBOARD_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

function isStellarAddress(value: string): boolean {
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
  id: z.string().regex(/^[0-9]+$/, "Job ID must be a positive integer").transform(BigInt),
});

const registerAgentSchema = z.object({
  wallet: stellarAddressSchema,
  uri: z.string().min(1).optional(),
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

function corsOriginHandler(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  if (!origin) return next();
  if (!allowedOrigins.has(origin)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return next();
}

app.use(corsOriginHandler);
app.options("*", (_req, res) => res.sendStatus(204));

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/healthz", (_req, res) => res.send("ok"));

// --- Authentication Endpoints ---

/** GET /api/auth/challenge — Request a nonce to sign for wallet verification */
app.get("/api/auth/challenge", (req, res) => {
  try {
    const publicKeySchema = z.object({
      publicKey: stellarAddressSchema,
    });
    const parsed = publicKeySchema.parse(req.query);
    const nonce = generateNonce(parsed.publicKey);
    res.json({
      nonce,
      message: `Sign this nonce to authenticate: ${nonce}`,
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
    res.status(401).json({ error: "Authentication required. Use /api/auth/challenge and /api/auth/verify to authenticate." });
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

// --- Helpers ---

/** Serialize bigint values to strings for JSON, normalize Soroban enums */
function serialize(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "bigint") return obj.toString();
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

/** Get XLM balance from Horizon */
async function getXlmBalance(pubkey: string): Promise<string> {
  try {
    const horizonUrl = "https://horizon-testnet.stellar.org";
    const resp = await fetch(`${horizonUrl}/accounts/${pubkey}`);
    if (!resp.ok) return "0";
    const data = await resp.json() as { balances: Array<{ asset_type: string; balance: string }> };
    const native = data.balances.find((b: { asset_type: string }) => b.asset_type === "native");
    return native?.balance ?? "0";
  } catch {
    return "0";
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
    // i128 comes back as bigint — format with 7 decimals
    const val = BigInt(raw);
    const whole = val / 10_000_000n;
    const frac = (val % 10_000_000n).toString().padStart(7, "0");
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
    const [agents, jobs, feeBps] = await Promise.all([
      getAllAgents(),
      getAllJobs(),
      getFeeBps(),
    ]);
    const activeJobs = jobs.filter(
      (j) => j.status === "Funded" || j.status === "Submitted",
    ).length;
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
app.get("/api/agents", async (_req, res) => {
  try {
    const agents = await getAllAgents();
    res.json(serialize(agents));
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/agents/register
app.post("/api/agents/register", optionalAuthMiddleware, async (req, res) => {
  try {
    const parsed = registerAgentSchema.parse(req.body);
    const kp = getKeypair(parsed.wallet);
    const agentId = await identity.register(kp, parsed.uri || "ipfs://dashboard-agent");
    invalidateAgents();
    res.json({ agentId: agentId.toString() });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/jobs
app.get("/api/jobs", async (req, res) => {
  try {
    const parsed = jobsQuerySchema.parse(req.query);
    let jobs = await getAllJobs();
    if (parsed.status) {
      jobs = jobs.filter((j) => j.status === parsed.status);
    }
    res.json(serialize(jobs));
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/jobs/create
app.post("/api/jobs/create", optionalAuthMiddleware, async (req, res) => {
  try {
    const { wallet, provider, evaluator, budget, description } = req.body;
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
    if (respondWithValidationError(err, res)) return;
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/jobs/:id/submit
app.post("/api/jobs/:id/submit", optionalAuthMiddleware, async (req, res) => {
  try {
    const params = numericIdParamSchema.parse(req.params);
    const parsed = submitJobSchema.parse(req.body);
    const kp = getKeypair(parsed.wallet);
    await commerce.submit(kp, params.id, parsed.deliverable || "ipfs://dashboard-delivery");
    invalidateJobs();
    res.json({ success: true });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/jobs/:id/complete
app.post("/api/jobs/:id/complete", optionalAuthMiddleware, async (req, res) => {
  try {
    const params = numericIdParamSchema.parse(req.params);
    const parsed = walletOnlySchema.parse(req.body);
    const kp = getKeypair(parsed.wallet);
    await commerce.complete(kp, params.id);
    invalidateJobs();
    res.json({ success: true });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/jobs/:id/cancel
app.post("/api/jobs/:id/cancel", optionalAuthMiddleware, async (req, res) => {
  try {
    const params = numericIdParamSchema.parse(req.params);
    const parsed = walletOnlySchema.parse(req.body);
    const kp = getKeypair(parsed.wallet);
    await commerce.cancel(kp, params.id);
    invalidateJobs();
    res.json({ success: true });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/jobs/:id — cancel a job; builds unsigned XDR when publicKey provided,
// or invokes directly when wallet (server keypair) is provided.
app.put("/api/jobs/:id", optionalAuthMiddleware, async (req, res) => {
  try {
    const { action, publicKey, wallet } = req.body;
    if (action !== "cancel") {
      res.status(400).json({ error: "unsupported action; use action: 'cancel'" });
      return;
    }
    const jobId = BigInt(req.params.id);

    if (publicKey) {
      // Freighter path: return unsigned XDR for client-side signing
      const op = commerceContract.call(
        "cancel",
        new Address(publicKey).toScVal(),
        nativeToScVal(jobId, { type: "u64" }),
      );
      const txXdr = await buildTxXdr(publicKey, op);
      res.json({ xdr: txXdr });
    } else {
      // Server-keypair path: sign and submit directly
      const kp = getKeypair(wallet);
      await commerce.cancel(kp, jobId);
      invalidateJobs();
      res.json({ success: true });
    }
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// --- Freighter wallet endpoints: build unsigned XDR ---

const identityContract = new Contract(cfg.identityContract);
const commerceContract = new Contract(cfg.commerceContract);

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
  return prepared.toXDR();
}

// POST /api/build/register — build unsigned register agent tx
app.post("/api/build/register", optionalAuthMiddleware, async (req, res) => {
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
});

// POST /api/build/createJob — build unsigned create_job tx
app.post("/api/build/createJob", optionalAuthMiddleware, async (req, res) => {
  try {
    const { publicKey, provider, evaluator, budget, description } = req.body;
    const providerAddr = provider || sellerKeypair.publicKey();
    const evaluatorAddr = evaluator || publicKey;
    const budgetBn = BigInt(budget || 10_000_000);

    const agentId = await identity.agentOf(providerAddr);
    if (agentId === null) {
      res.status(400).json({ error: `Provider ${providerAddr} is not a registered agent` });
      return;
    }

    const op = commerceContract.call(
      "create_job",
      new Address(publicKey).toScVal(),
      new Address(providerAddr).toScVal(),
      new Address(evaluatorAddr).toScVal(),
      new Address(cfg.usdcToken).toScVal(),
      nativeToScVal(budgetBn, { type: "i128" }),
      nativeToScVal(description || "Dashboard test job", { type: "string" }),
    );
    const txXdr = await buildTxXdr(publicKey, op);
    res.json({ xdr: txXdr });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/build/submit — build unsigned submit tx
app.post("/api/build/submit", optionalAuthMiddleware, async (req, res) => {
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
app.post("/api/build/complete", optionalAuthMiddleware, async (req, res) => {
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
});

// POST /api/build/cancel — build unsigned cancel tx
app.post("/api/build/cancel", optionalAuthMiddleware, async (req, res) => {
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

const PORT = Number(process.env.DASHBOARD_PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`Bear Dashboard → http://localhost:${PORT}`);
  console.log(`  Buyer:  ${buyerKeypair.publicKey()}`);
  console.log(`  Seller: ${sellerKeypair.publicKey()}`);
});
