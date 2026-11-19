import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import rateLimit from "express-rate-limit";
import Groq from "groq-sdk";
import { CommerceClient } from "marc-stellar-sdk";
import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import {
  createSellerAgent,
  makeSellerResponse,
  validatePrompt,
  isMockLlm,
  MOCK_DELIVERABLES,
  callLlmWithRetry,
  registerGracefulShutdown,
} from "../shared.js";
import { sanitizeGeneratedHtml } from "./sanitize.js";

const config = loadAgentConfig({
  agentId: "seller-webbuilder",
  required: ["SECRET_KEY", "REGISTRY_URL", "GROQ_API_KEY"],
  portEnvVar: "SELLER_PORT",
  defaultPort: 4501,
});

const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = config.PORT;
const AGENT_ID = "seller-webbuilder";
const OUTPUT_DIR = path.join(AGENT_DIR, "output");
const OUTPUT_URL = "output";
const publicUrl = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, "");

const { app, seller, cfg } = await createSellerAgent({
  id: AGENT_ID,
  port: PORT,
  agentDir: AGENT_DIR,
});

const tracer = initTracing(AGENT_ID).getTracer(AGENT_ID);

app.use((req, res, next) => {
  const span = tracer.startSpan(`${req.method} ${req.path}`, {
    attributes: {
      "http.method": req.method,
      "http.route": req.path,
      "http.target": req.originalUrl,
      "http.user_agent": req.headers["user-agent"] ?? "",
      "agent.id": AGENT_ID,
    },
  });
  res.on("finish", () => {
    span.setAttribute("http.status_code", res.statusCode);
    if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  });
  next();
});

const startTime = Date.now();
let jobsActive = 0;
let jobsCompleted = 0;
let jobsFailed = 0;

// Tracks in-flight /job processing so graceful shutdown can wait for them.
const activeTasks = new Set<Promise<void>>();
const activeTaskTracker = {
  get size() {
    return activeTasks.size;
  },
  track<T>(task: Promise<T>): Promise<T> {
    const tracked = task.then(
      () => undefined,
      () => undefined,
    );
    activeTasks.add(tracked);
    void tracked.finally(() => activeTasks.delete(tracked));
    return task;
  },
  async drain(timeoutMs: number): Promise<boolean> {
    if (activeTasks.size === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const drained = Promise.all([...activeTasks]).then(() => true as const);
    const result = await Promise.race([drained, timeout]);
    if (timer) clearTimeout(timer);
    return result;
  },
};

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

const groq = isMockLlm() ? null : new Groq({ apiKey: config.GROQ_API_KEY });
const GROQ_MODEL = config.GROQ_MODEL;

async function generate(prompt: string): Promise<string> {
  if (isMockLlm()) {
    return MOCK_DELIVERABLES.webbuilder;
  }
  return tracer.startActiveSpan("llm.generate", async (span: Span) => {
    span.setAttribute("llm.model", GROQ_MODEL);
    span.setAttribute("llm.provider", "groq");
    try {
      const res = await callLlmWithRetry(
        () =>
          groq!.chat.completions.create({
            model: GROQ_MODEL,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7,
          }),
        3,
        AGENT_ID,
      );
      return res.choices[0].message.content ?? "";
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

interface BuildSpec {
  framework?: string;
  pages?: string[];
  theme?: string;
}

function buildPrompt(task: string, spec?: BuildSpec): string {
  const base = `You are a professional web developer. Build a complete, self-contained HTML/CSS website for:\n\n${task}`;
  if (!spec)
    return `${base}\n\nReturn ONLY raw HTML — no markdown, no code fences. Must have inline CSS, ready to open in a browser.`;
  const constraints: string[] = [];
  if (spec.framework) constraints.push(`Framework/style: ${spec.framework}`);
  if (spec.pages && spec.pages.length > 0)
    constraints.push(`Pages to include: ${spec.pages.join(", ")}`);
  if (spec.theme) constraints.push(`Color theme: ${spec.theme}`);
  return `${base}\n\nBuild specs:\n${constraints.join("\n")}\n\nReturn ONLY raw HTML — no markdown, no code fences. Must have inline CSS, ready to open in a browser.`;
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
  const { jobId, task, buildSpec } = req.body as {
    jobId?: string;
    task?: string;
    buildSpec?: BuildSpec;
  };

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
    `[${AGENT_ID}] Job #${jobId}: ${task}${buildSpec ? ` (buildSpec: ${JSON.stringify(buildSpec)})` : ""}`,
  );
  const response = makeSellerResponse({ status: "accepted", jobId }, startedAt);
  console.log(`[${AGENT_ID}] [req:${requestId}] Response: ${JSON.stringify(response)}`);
  res.json(response);

  jobsActive++;
  const jobWork = (async () => {
    try {
      console.log(`[${AGENT_ID}] Calling Groq...`);
      const html = await generate(buildPrompt(task, buildSpec));

      const stripped = html
        .replace(/```html\s*/gi, "")
        .replace(/```/g, "")
        .trim();
      if (stripped.length < 50 || !/<!DOCTYPE html|<html/i.test(stripped)) {
        throw new Error(
          `Generated content is not valid HTML (${stripped.length} chars, no doctype/html tag)`,
        );
      }

      // Sandbox/validate generated artifacts before delivery: strip inline
      // scripts, event handlers and external requests, and record a report.
      const { html: sanitized, report } = sanitizeGeneratedHtml(stripped, { jobId });
      if (report.stripped.length > 0 || report.flagged.length > 0) {
        console.warn(
          `[${AGENT_ID}] Job #${jobId} sanitised: ${report.stripped.length} stripped, ${report.flagged.length} flagged`,
        );
      }

      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      const filename = `job-${jobId}.html`;
      fs.writeFileSync(path.join(OUTPUT_DIR, filename), sanitized);
      fs.writeFileSync(
        path.join(OUTPUT_DIR, `job-${jobId}.content-report.json`),
        JSON.stringify(report, null, 2),
      );
      // Canonical deliverable paths.
      fs.writeFileSync(path.join(OUTPUT_DIR, "website.html"), sanitized);
      fs.writeFileSync(
        path.join(OUTPUT_DIR, "content-report.json"),
        JSON.stringify(report, null, 2),
      );
      const deliverable = `${publicUrl}/${OUTPUT_URL}/${filename}`;
      console.log(`[${AGENT_ID}] Website built (${sanitized.length} chars) → ${deliverable}`);

      const commerce = new CommerceClient(cfg);
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          await commerce.submit(seller, BigInt(jobId), deliverable);
          console.log(`[${AGENT_ID}] ✓ Job #${jobId} submitted → ${deliverable}`);
          break;
        } catch (e) {
          if (attempt === 5) throw e;
          console.log(`[${AGENT_ID}] submit attempt ${attempt} failed, retrying...`);
          await new Promise((r) => setTimeout(r, 4000));
        }
      }
      jobsCompleted++;
    } catch (err) {
      jobsFailed++;
      console.error(`[${AGENT_ID}] Error:`, (err as Error).message);
    } finally {
      jobsActive--;
    }
  })();
  activeTaskTracker.track(jobWork);
});

const server = app.listen(PORT, () => console.log(`[${AGENT_ID}] Listening on :${PORT}`));
registerGracefulShutdown(server, activeTaskTracker, null, { agentId: AGENT_ID });
