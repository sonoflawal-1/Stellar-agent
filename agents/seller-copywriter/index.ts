import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import rateLimit from "express-rate-limit";
import Groq from "groq-sdk";
import { CommerceClient } from "marc-stellar-sdk";
import { createSellerAgent, makeSellerResponse, validateEnv } from "../shared.js";

validateEnv(["PORT", "SECRET_KEY", "REGISTRY_URL", "GROQ_API_KEY"]);

const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SELLER_PORT ?? 4502);
const AGENT_ID = "seller-copywriter";
const OUTPUT_DIR = path.join(AGENT_DIR, "output");
const OUTPUT_URL = "output";
const publicUrl = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, "");

const { app, seller, cfg } = await createSellerAgent({
  id: AGENT_ID,
  port: PORT,
  agentDir: AGENT_DIR,
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

let callCount = 0;
async function generate(prompt: string): Promise<string> {
  callCount++;
  const res = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.9,
    seed: callCount + Date.now(),
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
  const {
    jobId,
    task,
    tone,
    audience,
    keywords,
    brandVoice,
  }: {
    jobId: string;
    task: string;
    tone?: string;
    audience?: string;
    keywords?: string | string[];
    brandVoice?: Record<string, unknown>;
  } = req.body;

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
  if (brandVoice !== undefined && (typeof brandVoice !== "object" || Array.isArray(brandVoice))) {
    res.status(400).json({
      success: false,
      error: "brandVoice must be an object",
      execution_time_ms: Date.now() - startedAt,
    });
    return;
  }
  console.log(
    `[${AGENT_ID}] Job #${jobId}: ${task}${brandVoice ? ` | brandVoice: ${JSON.stringify(brandVoice)}` : ""}`,
  );
  res.json(makeSellerResponse({ status: "accepted", jobId }, startedAt));

  try {
    console.log(`[${AGENT_ID}] Calling Groq...`);
    const brandContext = [
      tone ? `Tone: ${tone}` : "",
      audience ? `Target audience: ${audience}` : "",
      keywords?.length
        ? `Keywords to include: ${Array.isArray(keywords) ? keywords.join(", ") : keywords}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    const copy = await generate(
      `You are a professional copywriter. Write compelling website copy for:\n\n${task}${brandContext ? `\n\nBrand guidelines:\n${brandContext}` : ""}\n\nStructure in markdown: # Headline, ## Subheadline, ## Body, ## CTA.`,
    );
    if (copy.length < 20) {
      throw new Error(`Generated copy too short (${copy.length} chars)`);
    }

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const filename = `job-${jobId}.md`;
    fs.writeFileSync(path.join(OUTPUT_DIR, filename), copy);
    const deliverable = `${publicUrl}/${OUTPUT_URL}/${filename}`;
    console.log(`[${AGENT_ID}] Copy written (${copy.length} chars) → ${deliverable}`);

    const commerce = new CommerceClient(cfg);
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await commerce.submit(seller, BigInt(jobId), deliverable);
        console.log(`[${AGENT_ID}] ✓ Job #${jobId} submitted → ${deliverable}`);
        break;
      } catch (e: any) {
        if (attempt === 5) throw e;
        console.log(`[${AGENT_ID}] submit attempt ${attempt} failed, retrying...`);
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
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
