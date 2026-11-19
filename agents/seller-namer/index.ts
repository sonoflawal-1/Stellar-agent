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
  registerGracefulShutdown,
  createTaskQueue,
  submitDeliverable,
} from "../shared.js";

initTracing("seller-namer");

validateEnv(["PORT", "SECRET_KEY", "REGISTRY_URL", "GROQ_API_KEY"]);

const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));

const PORT = config.port;
const AGENT_ID = "seller-namer";
const OUTPUT_DIR = path.join(AGENT_DIR, "output");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "names.md");

const { app, seller, cfg } = await createSellerAgent({
  id: AGENT_ID,
  port: PORT,
  agentDir: AGENT_DIR,
});

const startTime = Date.now();
let jobsActive = 0;
let jobsCompleted = 0;
let jobsFailed = 0;

// Persistent task queue: survives restarts, bounds concurrency and retries.
const queue = createTaskQueue({
  agentId: AGENT_ID,
  agentDir: AGENT_DIR,
  concurrency: config.queueConcurrency,
  maxAttempts: config.queueMaxAttempts,
});

// Tracks in-flight /job processing so graceful shutdown can wait for them.
const activeTaskTracker = {
  get active() {
    return jobsActive;
  },
};

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

async function generate(prompt: string): Promise<string> {
  if (isMockLlm()) {
    return MOCK_DELIVERABLES.namer;
  }
  return withSpan("llm.generate", { "llm.model": GROQ_MODEL }, async () => {
    const res = await groq!.chat.completions.create({
      model: GROQ_MODEL,
      messages: [{ role: "user", content: prompt }],
    });
    return res.choices[0].message.content ?? "";
  });
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

  return withSpan(
    "http.server.job",
    {
      "http.method": "POST",
      "http.route": "/job",
      "agent.id": AGENT_ID,
      "request.id": requestId,
    },
    async () => {

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
  console.log(
    `[${AGENT_ID}] Job #${jobId}: ${
      process.env.LOG_LEVEL === "debug"
        ? task
        : `task length ${typeof task === "string" ? task.length : 0}`
    }`,
  );
  await queue.enqueue({ jobId: String(jobId), task: rawPrompt });

  const response = makeSellerResponse({ status: "accepted", jobId }, startedAt);
  console.log(`[${AGENT_ID}] [req:${requestId}] Response: ${JSON.stringify(response)}`);
  res.json(response);
    },
  );
});

// Process queued tasks with bounded concurrency; pending tasks resume on restart.
queue.process(async (task) => {
  const { jobId, task: prompt } = task;
  jobsActive++;
  try {
    console.log(`[${AGENT_ID}] Calling Groq for job #${jobId}...`);
    const names = await generate(
      `You are a creative naming expert. Generate 10 unique name suggestions for:\n\n${prompt}\n\nFormat as a numbered markdown list. Each entry: bold name + 1-2 sentences rationale.`,
    );
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, names);
    console.log(`[${AGENT_ID}] Names generated (${names.length} chars)`);

    const commerce = new CommerceClient(cfg);
    await submitDeliverable(
      { commerce, seller, jobId: BigInt(jobId), agentId: AGENT_ID },
      Buffer.from(names, "utf8"),
    );
    console.log(`[${AGENT_ID}] ✓ Job #${jobId} submitted`);
    jobsCompleted++;
  } catch (err) {
    jobsFailed++;
    console.error(`[${AGENT_ID}] Error:`, (err as Error).message);
    throw err;
  } finally {
    jobsActive--;
  }
});

const server = app.listen(PORT, () => console.log(`[${AGENT_ID}] Listening on :${PORT}`));
registerGracefulShutdown(server, activeTaskTracker, null, {
  agentId: AGENT_ID,
  onShutdown: () => queue.close(),
});
