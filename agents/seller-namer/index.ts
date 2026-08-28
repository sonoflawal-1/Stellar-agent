import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import rateLimit from "express-rate-limit";
import Groq from "groq-sdk";
import { CommerceClient } from "marc-stellar-sdk";
import { retryWithBackoff, createSellerAgent, makeSellerResponse, validateEnv } from "../shared.js";

validateEnv(["PORT", "SECRET_KEY", "REGISTRY_URL", "GROQ_API_KEY"]);

const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.SELLER_PORT ?? 4503);
const AGENT_ID = "seller-namer";
const OUTPUT_DIR = path.join(AGENT_DIR, "output");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "names.md");

const { app, seller, cfg } = await createSellerAgent({
  id: AGENT_ID,
  port: PORT,
  agentDir: AGENT_DIR,
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

async function generate(prompt: string): Promise<string> {
  const res = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages: [{ role: "user", content: prompt }],
  });
  return res.choices[0].message.content ?? "";
}

const limiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many requests — rate limited (5/min/IP)" },
});

app.post("/job", limiter, async (req, res) => {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  const { jobId, task } = req.body;

  console.log(
    `[${AGENT_ID}] [req:${requestId}] Incoming POST /job — headers: ${JSON.stringify({
      "content-type": req.headers["content-type"],
      "user-agent": req.headers["user-agent"],
      "x-forwarded-for": req.headers["x-forwarded-for"] ?? req.socket.remoteAddress,
    })} — body: ${JSON.stringify(req.body)}`,
  );

  if (!jobId || isNaN(Number(jobId))) {
    console.warn(`[${AGENT_ID}] [req:${requestId}] Rejected: invalid jobId`);
    res
      .status(400)
      .json({ success: false, error: "invalid jobId", execution_time_ms: Date.now() - startedAt });
    return;
  }
  if (!task) {
    console.warn(`[${AGENT_ID}] [req:${requestId}] Rejected: missing task`);
    res
      .status(400)
      .json({ success: false, error: "missing task", execution_time_ms: Date.now() - startedAt });
    return;
  }
  console.log(`[${AGENT_ID}] Job #${jobId}: ${task}`);
  const response = makeSellerResponse({ status: "accepted", jobId }, startedAt);
  console.log(`[${AGENT_ID}] [req:${requestId}] Response: ${JSON.stringify(response)}`);
  res.json(response);

  try {
    console.log(`[${AGENT_ID}] Calling Groq...`);
    const names = await generate(
      `You are a creative naming expert. Generate 10 unique name suggestions for:\n\n${task}\n\nFormat as a numbered markdown list. Each entry: bold name + 1-2 sentences rationale.`,
    );
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, names);
    console.log(`[${AGENT_ID}] Names generated (${names.length} chars)`);

    const commerce = new CommerceClient(cfg);
    await retryWithBackoff(
      () => commerce.submit(seller, BigInt(jobId), `file://${path.resolve(OUTPUT_FILE)}`),
      { maxAttempts: 5, baseDelayMs: 1000, label: AGENT_ID },
    );
    console.log(`[${AGENT_ID}] ✓ Job #${jobId} submitted`);
  } catch (err) {
    console.error(`[${AGENT_ID}] Error:`, (err as Error).message);
  }
});

const server = app.listen(PORT, () => console.log(`[${AGENT_ID}] Listening on :${PORT}`));
const shutdown = () => {
  console.log(`[${AGENT_ID}] Shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
