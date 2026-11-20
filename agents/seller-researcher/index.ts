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
  registerGracefulShutdown,
  createActiveTaskTracker,
  MOCK_DELIVERABLES,
  initTracing,
  withSpan,
  validateEnv,
  sellerResearcherEnvSchema,
  createTaskQueue,
  submitDeliverable,
} from "../shared.js";

validateEnv(sellerResearcherEnvSchema, "seller-researcher");

const config = loadAgentConfig({
  required: ["SECRET_KEY", "REGISTRY_URL", "GROQ_API_KEY"],
  port: { envVar: "SELLER_PORT", default: 4504 },
});

const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));

const PORT = config.port;
const AGENT_ID = "seller-researcher";
const OUTPUT_DIR = path.join(AGENT_DIR, "output");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "research.json");

initTracing(AGENT_ID);

const { app, seller, cfg } = await createSellerAgent({
  id: AGENT_ID,
  port: PORT,
  agentDir: AGENT_DIR,
});

const startTime = Date.now();
const activeTaskTracker = createActiveTaskTracker();
let jobsActive = 0;
let jobsCompleted = 0;
let jobsFailed = 0;

const taskQueue = createTaskQueue({
  agentId: AGENT_ID,
  agentDir: AGENT_DIR,
  concurrency: config.queueConcurrency,
  maxAttempts: config.queueMaxAttempts,
  handler: async (payload) => {
    const { jobId, task, depth } = payload as {
      jobId: string;
      task: string;
      depth: ResearchDepth;
    };
    jobsActive++;
    const releaseTask = activeTaskTracker.track(`job:${jobId}`);
    try {
      console.log(`[${AGENT_ID}] Calling Groq...`);
      const research = await generate(task, depth);
      const sourceCount = research.sources.length;
      console.log(
        `[${AGENT_ID}] Research done: ${research.summary.length} chars, ${sourceCount} sources`,
      );

      const bytes = Buffer.from(JSON.stringify(research, null, 2), "utf8");
      await withSpan(
        "stellar.commerce.submit",
        { "job.id": String(jobId), "stellar.operation": "submit" },
        () => submitDeliverable(seller, cfg, BigInt(jobId), bytes, { label: AGENT_ID }),
      );
      console.log(`[${AGENT_ID}] ✓ Job #${jobId} submitted`);
      jobsCompleted++;
    } catch (err) {
      jobsFailed++;
      console.error(`[${AGENT_ID}] Error:`, (err as Error).message);
      throw err;
    } finally {
      jobsActive--;
      releaseTask();
    }
  },
});

app.get("/health", (_req, res) => {
  res.json({
    status: "healthy",
    agent: AGENT_ID,
    version: "1.0.0",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    jobs: { active: jobsActive, completed: jobsCompleted, failed: jobsFailed },
    wallet: { address: config.secretKey ? "configured" : "not-configured" },
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

const groq = isMockLlm() ? null : new Groq({ apiKey: config.groqApiKey });
const GROQ_MODEL = config.groqModel;

interface ResearchOutput {
  summary: string;
  sources: { title: string; url: string }[];
}

type ResearchDepth = "brief" | "standard" | "deep";

export class ResearcherParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearcherParseError";
  }
}

function stripCodeFences(raw: string): string {
  return raw.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
}

/**
 * Parse and validate the raw LLM response for the seller-researcher agent.
 * Throws a controlled {@link ResearcherParseError} on malformed or invalid output.
 */
export function parseResearcherResponse(raw: unknown): ResearchOutput {
  if (typeof raw !== "string") {
    throw new ResearcherParseError("LLM response is not a string");
  }
  const cleaned = stripCodeFences(raw);
  if (cleaned.length === 0) {
    throw new ResearcherParseError("LLM response is empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new ResearcherParseError(
      `LLM response is not valid JSON: ${(err as Error).message}`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ResearcherParseError("LLM response must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.summary !== "string" || obj.summary.trim().length === 0) {
    throw new ResearcherParseError("LLM response missing valid 'summary' string");
  }

  if (!Array.isArray(obj.sources)) {
    throw new ResearcherParseError("LLM response missing 'sources' array");
  }

  const sources: { title: string; url: string }[] = [];
  for (let i = 0; i < obj.sources.length; i++) {
    const src = obj.sources[i];
    if (src === null || typeof src !== "object" || Array.isArray(src)) {
      throw new ResearcherParseError(`sources[${i}] is not an object`);
    }
    const s = src as Record<string, unknown>;
    if (typeof s.title !== "string" || s.title.trim().length === 0) {
      throw new ResearcherParseError(`sources[${i}] missing valid 'title' string`);
    }
    if (typeof s.url !== "string" || s.url.trim().length === 0) {
      throw new ResearcherParseError(`sources[${i}] missing valid 'url' string`);
    }
    sources.push({ title: s.title, url: s.url });
  }

  return { summary: obj.summary, sources };
}

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
  if (isMockLlm()) {
    return MOCK_DELIVERABLES.researcher;
  }
  const { sourceRange, detail } = DEPTH_CONFIG[depth];
  const res = await withSpan(
    "llm.groq.chat.completions",
    {
      "llm.provider": "groq",
      "llm.model": GROQ_MODEL,
      "llm.research_depth": depth,
    },
    () =>
      callLlmWithRetry(
        () =>
          groq!.chat.completions.create({
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
          }),
        3,
        AGENT_ID,
      ),
  );
  const text = res.choices[0]?.message?.content ?? "";
  return parseResearcherResponse(text);
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
  const { jobId, task, depth } = req.body;

  await withSpan(
    "http.server.job",
    {
      "http.method": "POST",
      "http.route": "/job",
      "agent.id": AGENT_ID,
      "job.id": jobId != null ? String(jobId) : undefined,
    },
    () => handleJob(req, res, requestId, startedAt),
  );
});

async function handleJob(
  req: import("express").Request,
  res: import("express").Response,
  requestId: string,
  startedAt: number,
): Promise<void> {
  const { jobId, task, depth } = req.body;

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
  const resolvedDepth: ResearchDepth = ["brief", "standard", "deep"].includes(depth)
    ? depth
    : "standard";
  console.log(
    `[${AGENT_ID}] Job #${jobId} (depth=${resolvedDepth}): ${
      process.env.LOG_LEVEL === "debug"
        ? task
        : `task length ${typeof task === "string" ? task.length : 0}`
    }`,
  );
  await taskQueue.enqueue(String(jobId), {
    jobId: String(jobId),
    task,
    depth: resolvedDepth,
  });
  const response = makeSellerResponse(
    { status: "accepted", jobId, depth: resolvedDepth },
    startedAt,
  );
  console.log(`[${AGENT_ID}] [req:${requestId}] Response: ${JSON.stringify(response)}`);
  res.json(response);
}

const server = app.listen(PORT, () => console.log(`[${AGENT_ID}] Listening on :${PORT}`));
registerGracefulShutdown(server, activeTaskTracker, () => taskQueue.close(), AGENT_ID);
