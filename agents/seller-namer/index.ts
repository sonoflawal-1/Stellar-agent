import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import rateLimit from "express-rate-limit";
import Groq from "groq-sdk";
import { Keypair } from "@stellar/stellar-sdk";
import { IdentityClient, CommerceClient, TESTNET, type MarcConfig } from "marc-stellar-sdk";

const cfg: MarcConfig = {
  rpcUrl: process.env.STELLAR_RPC_URL ?? TESTNET.rpcUrl,
  networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? TESTNET.networkPassphrase,
  identityContract: process.env.AGENT_IDENTITY_CONTRACT || TESTNET.identityContract,
  commerceContract: process.env.AGENTIC_COMMERCE_CONTRACT || TESTNET.commerceContract,
  usdcToken: process.env.USDC_TOKEN_CONTRACT || TESTNET.usdcToken,
  onTx: (hash) => console.log(`[tx] ${hash} → https://stellar.expert/explorer/testnet/tx/${hash}`),
};

const seller = Keypair.fromSecret(process.env.SELLER_SECRET!);
const port = Number(process.env.SELLER_PORT ?? 4503);
const AGENT_ID = "seller-namer";
const OUTPUT_FILE = "output/names.md";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function generate(prompt: string): Promise<string> {
  const res = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
  });
  return res.choices[0].message.content ?? "";
}

const identity = new IdentityClient(cfg);
let agentId = await identity.agentOf(seller.publicKey());
if (!agentId) {
  agentId = await identity.register(seller, `ipfs://${AGENT_ID}.json`);
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
    const names = await generate(
      `You are a creative naming expert. Generate 10 unique name suggestions for:\n\n${task}\n\nFormat as a numbered markdown list. Each entry: bold name + 1-2 sentences rationale.`
    );
    fs.mkdirSync("output", { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, names);
    console.log(`[${AGENT_ID}] Names generated (${names.length} chars)`);

    const commerce = new CommerceClient(cfg);
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await commerce.submit(seller, BigInt(jobId), `file://${path.resolve(OUTPUT_FILE)}`);
        console.log(`[${AGENT_ID}] ✓ Job #${jobId} submitted`);
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
