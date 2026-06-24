import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Keypair, rpc, Account, TransactionBuilder, BASE_FEE, Address, nativeToScVal, Contract, xdr, scValToNative } from "@stellar/stellar-sdk";
import { cfg, buyerKeypair, sellerKeypair, getKeypair } from "./lib/config.js";
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
app.post("/api/agents/register", async (req, res) => {
  try {
    const { wallet, uri } = req.body;
    const kp = getKeypair(wallet);
    const agentId = await identity.register(kp, uri || "ipfs://dashboard-agent");
    invalidateAgents();
    res.json({ agentId: agentId.toString() });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/jobs
app.get("/api/jobs", async (req, res) => {
  try {
    let jobs = await getAllJobs();
    const status = req.query.status as string | undefined;
    if (status) {
      jobs = jobs.filter((j) => j.status === status);
    }
    res.json(serialize(jobs));
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/jobs/create
app.post("/api/jobs/create", async (req, res) => {
  try {
    const { wallet, provider, evaluator, budget, description } = req.body;
    const kp = getKeypair(wallet);
    const providerAddr = provider || sellerKeypair.publicKey();
    const evaluatorAddr = evaluator || kp.publicKey();
    const budgetBn = BigInt(budget || 10_000_000); // default 1 MUSD
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
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/jobs/:id/submit
app.post("/api/jobs/:id/submit", async (req, res) => {
  try {
    const { wallet, deliverable } = req.body;
    const kp = getKeypair(wallet);
    const jobId = BigInt(req.params.id);
    await commerce.submit(kp, jobId, deliverable || "ipfs://dashboard-delivery");
    invalidateJobs();
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/jobs/:id/complete
app.post("/api/jobs/:id/complete", async (req, res) => {
  try {
    const { wallet } = req.body;
    const kp = getKeypair(wallet);
    const jobId = BigInt(req.params.id);
    await commerce.complete(kp, jobId);
    invalidateJobs();
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/jobs/:id/cancel
app.post("/api/jobs/:id/cancel", async (req, res) => {
  try {
    const { wallet } = req.body;
    const kp = getKeypair(wallet);
    const jobId = BigInt(req.params.id);
    await commerce.cancel(kp, jobId);
    invalidateJobs();
    res.json({ success: true });
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
app.post("/api/build/register", async (req, res) => {
  try {
    const { publicKey, uri } = req.body;
    const op = identityContract.call(
      "register",
      new Address(publicKey).toScVal(),
      nativeToScVal(uri || "ipfs://dashboard-agent", { type: "string" }),
    );
    const txXdr = await buildTxXdr(publicKey, op);
    res.json({ xdr: txXdr });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/build/createJob — build unsigned create_job tx
app.post("/api/build/createJob", async (req, res) => {
  try {
    const { publicKey, provider, evaluator, budget, description } = req.body;
    const providerAddr = provider || sellerKeypair.publicKey();
    const evaluatorAddr = evaluator || publicKey;
    const budgetBn = BigInt(budget || 10_000_000);
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
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/build/submit — build unsigned submit tx
app.post("/api/build/submit", async (req, res) => {
  try {
    const { publicKey, jobId, deliverable } = req.body;
    const op = commerceContract.call(
      "submit",
      new Address(publicKey).toScVal(),
      nativeToScVal(BigInt(jobId), { type: "u64" }),
      nativeToScVal(deliverable || "ipfs://dashboard-delivery", { type: "string" }),
    );
    const txXdr = await buildTxXdr(publicKey, op);
    res.json({ xdr: txXdr });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/build/complete — build unsigned complete tx
app.post("/api/build/complete", async (req, res) => {
  try {
    const { publicKey, jobId } = req.body;
    const op = commerceContract.call(
      "complete",
      new Address(publicKey).toScVal(),
      nativeToScVal(BigInt(jobId), { type: "u64" }),
    );
    const txXdr = await buildTxXdr(publicKey, op);
    res.json({ xdr: txXdr });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/build/cancel — build unsigned cancel tx
app.post("/api/build/cancel", async (req, res) => {
  try {
    const { publicKey, jobId } = req.body;
    const op = commerceContract.call(
      "cancel",
      new Address(publicKey).toScVal(),
      nativeToScVal(BigInt(jobId), { type: "u64" }),
    );
    const txXdr = await buildTxXdr(publicKey, op);
    res.json({ xdr: txXdr });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/submit — submit a Freighter-signed transaction
app.post("/api/submit", async (req, res) => {
  try {
    const { signedXdr } = req.body;
    const tx = TransactionBuilder.fromXDR(signedXdr, cfg.networkPassphrase);
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
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/balance/:pubkey — get XLM + MUSD balance for any public key
app.get("/api/balance/:pubkey", async (req, res) => {
  try {
    const pubkey = req.params.pubkey;
    const [xlm, musd] = await Promise.all([
      getXlmBalance(pubkey),
      getTokenBalance(pubkey),
    ]);
    res.json({ address: pubkey, xlm, musd });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Dashboard SPA fallback (anything under /app)
app.get("/app/*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = Number(process.env.DASHBOARD_PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`Bear Dashboard → http://localhost:${PORT}`);
  console.log(`  Buyer:  ${buyerKeypair.publicKey()}`);
  console.log(`  Seller: ${sellerKeypair.publicKey()}`);
});
