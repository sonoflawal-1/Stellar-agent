import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import rateLimit from "express-rate-limit";
import Groq from "groq-sdk";
import { CommerceClient } from "marc-stellar-sdk";
import { createSellerAgent } from "../shared.js";

const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SELLER_PORT ?? 4501);
const AGENT_ID = "seller-webbuilder";
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

async function generate(prompt: string): Promise<string> {
  const res = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
  });
  return res.choices[0].message.content ?? "";
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
  console.log(
    `[${AGENT_ID}] Job #${jobId}: ${task}${buildSpec ? ` (buildSpec: ${JSON.stringify(buildSpec)})` : ""}`,
  );
  const response = { status: "accepted", jobId };
  console.log(`[${AGENT_ID}] [req:${requestId}] Response: ${JSON.stringify(response)}`);
  res.json(response);

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

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const filename = `job-${jobId}.html`;
    fs.writeFileSync(path.join(OUTPUT_DIR, filename), stripped);
    const deliverable = `${publicUrl}/${OUTPUT_URL}/${filename}`;
    console.log(`[${AGENT_ID}] Website built (${stripped.length} chars) → ${deliverable}`);

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
  } catch (err) {
    console.error(`[${AGENT_ID}] Error:`, (err as Error).message);
  }
});

app.listen(PORT, () => console.log(`[${AGENT_ID}] Listening on :${PORT}`));
