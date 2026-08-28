import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import rateLimit from "express-rate-limit";
import Groq from "groq-sdk";
import { CommerceClient } from "marc-stellar-sdk";
import { retryWithBackoff, createSellerAgent } from "../shared.js";

const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.SELLER_PORT ?? 4504);
const AGENT_ID = "seller-researcher";
const OUTPUT_DIR = path.join(AGENT_DIR, "output");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "research.json");

const { app, seller, cfg } = await createSellerAgent({
  id: AGENT_ID,
  port: PORT,
  agentDir: AGENT_DIR,
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

interface ResearchOutput {
  summary: string;
  sources: { title: string; url: string }[];
}

type ResearchDepth = "brief" | "standard" | "deep";

const DEPTH_CONFIG: Record<ResearchDepth, { sourceRange: string; detail: string }> = {
  brief: { sourceRange: "2-3", detail: "Write a concise 1-2 paragraph summary." },
  standard: {
    sourceRange: "3-8",
    detail: "Write a comprehensive multi-section summary in markdown.",
  },
  deep: {
    sourceRange: "8-15",
    detail:
      "Write an exhaustive, deeply detailed analysis with sections, subsections, key findings, and critical evaluation of sources.",
  },
};

async function generate(task: string, depth: ResearchDepth = "standard"): Promise<ResearchOutput> {
  const { sourceRange, detail } = DEPTH_CONFIG[depth];
  const res = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages: [
      {
        role: "user",
        content: `You are a research analyst. Research the following topic and return ONLY valid JSON (no markdown, no code fences) with this exact schema:
{
  "summary": "research summary in markdown format",
  "sources": [
    { "title": "Source title", "url": "https://..." }
  ]
}

Research depth: ${depth}
Include ${sourceRange} real, verifiable sources. Each source must have a real URL. The summary must cite sources by their index [1], [2], etc.
${detail}`,
      },
    ],
  });
  const text = res.choices[0].message.content ?? "";
  return JSON.parse(text.replace(/```(?:json)?\s*/gi, "").trim()) as ResearchOutput;
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
  const { jobId, task, depth } = req.body;

  console.log(
    `[${AGENT_ID}] [req:${requestId}] Incoming POST /job — headers: ${JSON.stringify({
      "content-type": req.headers["content-type"],
      "user-agent": req.headers["user-agent"],
      "x-forwarded-for": req.headers["x-forwarded-for"] ?? req.socket.remoteAddress,
    })} — body: ${JSON.stringify(req.body)}`,
  );

  if (!jobId || isNaN(Number(jobId))) {
    console.warn(`[${AGENT_ID}] [req:${requestId}] Rejected: invalid jobId`);
    res.status(400).json({ error: "invalid jobId" });
    return;
  }
  if (!task) {
    console.warn(`[${AGENT_ID}] [req:${requestId}] Rejected: missing task`);
    res.status(400).json({ error: "missing task" });
    return;
  }
  const resolvedDepth: ResearchDepth = ["brief", "standard", "deep"].includes(depth)
    ? depth
    : "standard";
  console.log(`[${AGENT_ID}] Job #${jobId} (depth=${resolvedDepth}): ${task}`);
  const response = { status: "accepted", jobId, depth: resolvedDepth };
  console.log(`[${AGENT_ID}] [req:${requestId}] Response: ${JSON.stringify(response)}`);
  res.json(response);

  try {
    console.log(`[${AGENT_ID}] Calling Groq...`);
    const research = await generate(task, resolvedDepth);
    const sourceCount = research.sources.length;
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(research, null, 2));
    console.log(
      `[${AGENT_ID}] Research done: ${research.summary.length} chars, ${sourceCount} sources`,
    );

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

app.listen(PORT, () => console.log(`[${AGENT_ID}] Listening on :${PORT}`));
