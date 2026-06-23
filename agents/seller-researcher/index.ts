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
const port = Number(process.env.SELLER_PORT ?? 4504);
const AGENT_ID = "seller-researcher";
const OUTPUT_FILE = "output/research.json";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

interface ResearchOutput {
  summary: string;
  sources: { title: string; url: string }[];
}

async function generate(task: string): Promise<ResearchOutput> {
  const res = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "user",
        content: `You are a research analyst. Research the following topic thoroughly and return ONLY valid JSON (no markdown, no code fences) with this exact schema:
{
  "summary": "comprehensive research summary in markdown format",
  "sources": [
    { "title": "Source title", "url": "https://..." }
  ]
}

Topic: ${task}

Each source must have a real, verifiable URL. Include 3-8 sources. The summary should cite sources by their index [1], [2], etc.`,
      },
    ],
  });
  const text = res.choices[0].message.content ?? "";
  return JSON.parse(text.replace(/```(?:json)?\s*/gi, "").trim()) as ResearchOutput;
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

app.post("/job", limiter, async (req, res) => {
  const { jobId, task } = req.body;
  console.log(`[${AGENT_ID}] Job #${jobId}: ${task}`);
  res.json({ status: "accepted", jobId });

  try {
    console.log(`[${AGENT_ID}] Calling Groq...`);
    const research = await generate(task);
    const sourceCount = research.sources.length;
    fs.mkdirSync("output", { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(research, null, 2));
    console.log(`[${AGENT_ID}] Research done: ${research.summary.length} chars, ${sourceCount} sources`);

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

app.listen(port, () => console.log(`[${AGENT_ID}] Listening on :${port}`));
