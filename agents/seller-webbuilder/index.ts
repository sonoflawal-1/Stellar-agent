import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import rateLimit from "express-rate-limit";
import Groq from "groq-sdk";
import { Keypair } from "@stellar/stellar-sdk";
import { IdentityClient, CommerceClient, TESTNET, type MarcConfig } from "marc-stellar-sdk";
import { retryWithBackoff } from "../shared.js";

const cfg: MarcConfig = {
  rpcUrl: process.env.STELLAR_RPC_URL ?? TESTNET.rpcUrl,
  networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? TESTNET.networkPassphrase,
  identityContract: process.env.AGENT_IDENTITY_CONTRACT || TESTNET.identityContract,
  commerceContract: process.env.AGENTIC_COMMERCE_CONTRACT || TESTNET.commerceContract,
  usdcToken: process.env.USDC_TOKEN_CONTRACT || TESTNET.usdcToken,
  onTx: (hash) => console.log(`[tx] ${hash} → https://stellar.expert/explorer/testnet/tx/${hash}`),
};

const seller = Keypair.fromSecret(process.env.SELLER_SECRET!);
const port = Number(process.env.SELLER_PORT ?? 4501);
const publicUrl = (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, "");
const AGENT_ID = "seller-webbuilder";
const OUTPUT_DIR = "output";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function generate(prompt: string): Promise<string> {
  const res = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
  });
  return res.choices[0].message.content ?? "";
}

const identity = new IdentityClient(cfg);
let agentId: bigint | null = null;
try {
  await retryWithBackoff(
    async () => { agentId = await identity.agentOf(seller.publicKey()); },
    { maxAttempts: 6, baseDelayMs: 2000, label: AGENT_ID },
  );
} catch (err) {
  console.error(`[${AGENT_ID}] Fatal: identity RPC unreachable —`, (err as Error).message);
  process.exit(1);
}
if (!agentId) {
  await retryWithBackoff(
    async () => { agentId = await identity.register(seller, `ipfs://${AGENT_ID}.json`); },
    { maxAttempts: 4, baseDelayMs: 2000, label: AGENT_ID },
  );
  console.log(`[${AGENT_ID}] Registered as agent #${agentId}`);
} else {
  console.log(`[${AGENT_ID}] Already agent #${agentId}`);
}

const registryUrl = (process.env.REGISTRY_URL ?? "http://localhost:4500").replace(/\/+$/, "");

async function heartbeat() {
  try {
    const res = await fetch(`${registryUrl}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: AGENT_ID }),
    });
    if (!res.ok) {
      console.warn(`[${AGENT_ID}] Heartbeat failed (${res.status})`);
    }
  } catch {
    console.warn(`[${AGENT_ID}] Registry unreachable at ${registryUrl}`);
  }
}

setInterval(heartbeat, 60_000);
heartbeat();

const limiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many requests — rate limited (5/min/IP)" },
});

const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.json(JSON.parse(fs.readFileSync("agent.json", "utf8"))));

app.use(`/${OUTPUT_DIR}`, express.static(OUTPUT_DIR));

app.post("/job", limiter, async (req, res) => {
  const { jobId, task } = req.body;
  if (!jobId || !task) {
    res.status(400).json({ error: "missing jobId or task" });
    return;
  }
  console.log(`[${AGENT_ID}] Job #${jobId}: ${task}`);
  res.json({ status: "accepted", jobId });

  try {
    console.log(`[${AGENT_ID}] Calling Groq...`);
    const html = await generate(
      `You are a professional web developer. Build a complete, self-contained HTML/CSS website for:\n\n${task}\n\nReturn ONLY raw HTML — no markdown, no code fences. Must have inline CSS, ready to open in a browser.`
    );

    const stripped = html.replace(/```html\s*/gi, "").replace(/```/g, "").trim();
    if (stripped.length < 50 || !/<!DOCTYPE html|<html/i.test(stripped)) {
      throw new Error(`Generated content is not valid HTML (${stripped.length} chars, no doctype/html tag)`);
    }

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const filename = `job-${jobId}.html`;
    fs.writeFileSync(path.join(OUTPUT_DIR, filename), stripped);
    const deliverable = `${publicUrl}/${OUTPUT_DIR}/${filename}`;
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

app.listen(port, () => console.log(`[${AGENT_ID}] Listening on :${port}`));
