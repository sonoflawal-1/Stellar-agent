import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import rateLimit from "express-rate-limit";
import Groq from "groq-sdk";
import { CommerceClient } from "marc-stellar-sdk";
import {
  createSellerAgent,
  makeSellerResponse,
  validatePrompt,
  isMockLlm,
  MOCK_DELIVERABLES,
  callLlmWithRetry,
  registerGracefulShutdown,
  validateEnv,
} from "../shared.js";
import {
  initTracing,
  startServerSpan,
  withSpan,
  setSpanAttributes,
  recordSpanError,
  shutdownTracing,
} from "../tracing.js";

const config = loadAgentConfig();

validateEnv("seller-copywriter");

await initTracing("seller-copywriter");

const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = config.SELLER_PORT;
const AGENT_ID = "seller-copywriter";
const OUTPUT_DIR = path.join(AGENT_DIR, "output");
const OUTPUT_URL = "output";
const publicUrl = (config.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, "");

const { app, seller, cfg } = await createSellerAgent({
  id: AGENT_ID,
  port: PORT,
  agentDir: AGENT_DIR,
});

const groq = isMockLlm() ? null : new Groq({ apiKey: config.GROQ_API_KEY });
const GROQ_MODEL = config.GROQ_MODEL ?? "llama-3.3-70b-versatile";

const startTime = Date.now();
let jobsActive = 0;
let jobsCompleted = 0;
let jobsFailed = 0;

app.get("/health", (_req, res) => {
  res.json({
    status: "healthy",
    agent: AGENT_ID,
    version: "1.0.0",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    jobs: { active: jobsActive, completed: jobsCompleted, failed: jobsFailed },
    wallet: { address: config.SECRET_KEY ? "configured" : "not-configured" },
  });
});

app.get("/metrics", (_req, res) => {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(
    [
      `# HELP bear_jobs_active Number of currently active jobs`,
      `# TYPE bear_jobs_active gauge`,
      `bear_jobs_active ${jobsActive}`,
      `# HELP bear_jobs_completed_total Total completed jobs`,
      `# TYPE bear_jobs_completed_total counter`,
      `bear_jobs_completed_total ${jobsCompleted}`,
      `# HELP bear_jobs_failed_total Total failed jobs`,
      `# TYPE bear_jobs_failed_total counter`,
      `bear_jobs_failed_total ${jobsFailed}`,
      `# HELP bear_uptime_seconds Agent uptime in seconds`,
      `# TYPE bear_uptime_seconds gauge`,
      `bear_uptime_seconds ${uptime}`,
    ].join("\n") + "\n",
  );
});

let callCount = 0;
async function generate(prompt: string): Promise<string> {
  if (isMockLlm()) {
    return MOCK_DELIVERABLES.copywriter;
  }
  return withSpan(
    "llm.generate",
    {
      "llm.provider": "groq",
      "llm.model": GROQ_MODEL,
      "llm.prompt_length": prompt.length,
    },
    async (span) => {
      callCount++;
      const res = await callLlmWithRetry(
        () =>
          groq!.chat.completions.create({
            model: GROQ_MODEL,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.9,
            seed: callCount + Date.now(),
          }),
        3,
        AGENT_ID,
      );
      const content = res.choices[0].message.content ?? "";
      setSpanAttributes(span, { "llm.response_length": content.length });
      return content;
    },
  );
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
  const span = startServerSpan(req, "POST /job", {
    "agent.id": AGENT_ID,
    "agent.request_id": requestId,
  });
  res.on("finish", () => {
    setSpanAttributes(span, { "http.status_code": res.statusCode });
    span.end();
  });
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
    })} — body: ${
      process.env.LOG_LEVEL === "debug"
        ? JSON.stringify(req.body)
        : JSON.stringify({
            jobId,
            taskLength: typeof task === "string" ? task.length : 0,
            fields: Object.keys(req.body ?? {}).filter((k) => k !== "jobId" && k !== "task"),
          })
    }`,
  );

  if (!jobId || isNaN(Number(jobId))) {
    console.warn(`[${AGENT_ID}] [req:${requestId}] Rejected: invalid jobId`);
    res
      .status(400)
      .json({ success: false, error: "invalid jobId", execution_time_ms: Date.now() - startedAt });
    return;
  }
  const rawPrompt =
    typeof task === "string"
      ? task
      : typeof (req.body as Record<string, unknown>).prompt === "string"
        ? ((req.body as Record<string, unknown>).prompt as string)
        : task;
  const promptValidation = validatePrompt(rawPrompt);
  if (!promptValidation.valid) {
    console.warn(`[${AGENT_ID}] [req:${requestId}] Rejected: ${promptValidation.error}`);
    res.status(400).json({
      success: false,
      error: promptValidation.error,
      execution_time_ms: Date.now() - startedAt,
    });
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

  const taskKey = `job-${jobId}-${requestId}`;
  activeTaskTracker.track(taskKey);
  jobsActive++;
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
    await withSpan(
      "stellar.commerce.submit",
      { "stellar.job_id": String(jobId), "stellar.deliverable": deliverable },
      async () => {
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
      },
    );
    jobsCompleted++;
  } catch (err) {
    jobsFailed++;
    recordSpanError(span, err as Error);
    console.error(`[${AGENT_ID}] Error:`, (err as Error).message);
  } finally {
    jobsActive--;
    activeTaskTracker.untrack(taskKey);
  }
});

const server = app.listen(PORT, () => console.log(`[${AGENT_ID}] Listening on :${PORT}`));

registerGracefulShutdown(server, activeTaskTracker, undefined);
