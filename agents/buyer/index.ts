import "dotenv/config";
import blessed from "blessed";
import {
  Keypair,
  Contract,
  Account,
  TransactionBuilder,
  BASE_FEE,
  Address,
  scValToNative,
  rpc,
} from "@stellar/stellar-sdk";
import {
  IdentityClient,
  CommerceClient,
  TESTNET,
  type MarcConfig,
  type Job,
} from "marc-stellar-sdk";
import { retryWithBackoff } from "../shared.js";
import { watchFile, unwatchFile, readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";

const DEFAULT_JOB_BUDGET = 10_000_000n;

// ── LLM configuration ─────────────────────────────────────────────────────────
// Provider/model are env-configurable per issue #650. Supported providers:
//   AGENT_LLM_PROVIDER=openai    (default model: gpt-4o)
//   AGENT_LLM_PROVIDER=anthropic (default model: claude-3-5-sonnet-latest)
const LLM_PROVIDER = (process.env.AGENT_LLM_PROVIDER ?? "openai").toLowerCase();
const LLM_MODEL =
  process.env.AGENT_LLM_MODEL ??
  (LLM_PROVIDER === "anthropic" ? "claude-3-5-sonnet-latest" : "gpt-4o");

interface TaskClassification {
  capabilities: string[];
  summary: string;
}

interface ProviderSelection {
  agent: any;
  score: number;
}

interface BuyerResult {
  jobId: string;
  provider: string;
  cost: string;
  result: string;
}

/**
 * Classify a natural-language task into capability tags using the configured
 * LLM provider. Falls back to keyword matching when no API key is present so
 * the agent still works offline / in CI.
 */
async function classifyTask(description: string): Promise<TaskClassification> {
  const prompt =
    "You are a task router for an agent marketplace. Given a user task, " +
    "return ONLY JSON of the form {\"capabilities\": string[], \"summary\": string}. " +
    "Capabilities must be short lowercase tags (e.g. \"translation\", \"summarization\", " +
    "\"code-review\", \"image-generation\", \"data-analysis\").\n\nTask: " +
    description;

  try {
    const raw = await callLlm(prompt);
    const parsed = JSON.parse(extractJson(raw)) as TaskClassification;
    if (Array.isArray(parsed.capabilities) && parsed.capabilities.length > 0) {
      return {
        capabilities: parsed.capabilities.map((c) => String(c).toLowerCase()),
        summary: parsed.summary ?? description,
      };
    }
  } catch (err) {
    log(`{yellow-fg}LLM classification failed, using keyword fallback{/yellow-fg}`);
  }
  return keywordClassify(description);
}

function keywordClassify(description: string): TaskClassification {
  const text = description.toLowerCase();
  const capabilities = text
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2)
    .slice(0, 8);
  return { capabilities, summary: description };
}

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON in LLM response");
  return text.slice(start, end + 1);
}

async function callLlm(prompt: string): Promise<string> {
  if (LLM_PROVIDER === "anthropic") {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY not set");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}`);
    const data = (await res.json()) as { content: { text: string }[] };
    return data.content.map((c) => c.text).join("");
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return data.choices[0]?.message?.content ?? "";
}

/**
 * Query the registry for agents whose declared tasks match the classified
 * capabilities, then auto-select the best provider by reputation score and
 * price (higher reputation and lower price win).
 */
function selectProvider(
  available: any[],
  capabilities: string[],
): ProviderSelection | null {
  const matches = available.filter((a) => {
    const tasks: string[] = (a.tasks ?? []).map((t: string) => t.toLowerCase());
    const haystack = `${a.name} ${a.description} ${tasks.join(" ")}`.toLowerCase();
    return capabilities.some((cap) => haystack.includes(cap));
  });
  const pool = matches.length > 0 ? matches : available;
  if (pool.length === 0) return null;

  const scored = pool.map((a) => {
    const reputation = Number(a.reputation ?? a.reputation_score ?? 0);
    const price = Number(a.price_usdc ?? 0);
    // Reputation dominates; price is a tie-breaker (lower is better).
    const score = reputation * 100 - price;
    return { agent: a, score };
  });
  scored.sort((x, y) => y.score - x.score);
  return scored[0];
}

function parseCliArgs(args: string[]) {
  const values = {
    budget: DEFAULT_JOB_BUDGET,
    provider: undefined as string | undefined,
    description: undefined as string | undefined,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--budget") {
      values.budget = BigInt(args[i + 1] ?? String(DEFAULT_JOB_BUDGET));
      i += 1;
    } else if (arg === "--provider") {
      values.provider = args[i + 1];
      i += 1;
    } else if (arg === "--description") {
      values.description = args[i + 1];
      i += 1;
    }
  }
  return values;
}

const cliArgs = parseCliArgs(process.argv.slice(2));

const cfg: MarcConfig = {
  rpcUrl: process.env.STELLAR_RPC_URL ?? TESTNET.rpcUrl,
  networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? TESTNET.networkPassphrase,
  identityContract: process.env.AGENT_IDENTITY_CONTRACT || TESTNET.identityContract,
  commerceContract: process.env.AGENTIC_COMMERCE_CONTRACT || TESTNET.commerceContract,
  usdcToken: process.env.USDC_TOKEN_CONTRACT || TESTNET.usdcToken,
  onTx: (hash) =>
    log(
      `{gray-fg}tx: ${hash.slice(0, 16)}... → https://stellar.expert/explorer/testnet/tx/${hash}{/gray-fg}`,
    ),
};

async function getUsdc(pubkey: string): Promise<string> {
  try {
    const server = new rpc.Server(cfg.rpcUrl, { allowHttp: false });
    const op = new Contract(cfg.usdcToken).call("balance", new Address(pubkey).toScVal());
    const dummy = new Account(Keypair.random().publicKey(), "0");
    const tx = new TransactionBuilder(dummy, {
      fee: BASE_FEE,
      networkPassphrase: cfg.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) return "?.??";
    const val = BigInt(
      scValToNative((sim as rpc.Api.SimulateTransactionSuccessResponse).result!.retval),
    );
    return `${val / 10_000_000n}.${(val % 10_000_000n).toString().padStart(7, "0").slice(0, 2)}`;
  } catch {
    return "?.??";
  }
}

// ── TUI ───────────────────────────────────────────────────────────────────────

const buyer = Keypair.fromSecret(process.env.BUYER_SECRET!);
const REGISTRY = "http://localhost:4500/agents";
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 120; // 10 minutes

const screen = blessed.screen({ smartCSR: true, title: "MARC Buyer Agent" });

const header = blessed.box({
  top: 0,
  left: 0,
  width: "100%",
  height: 3,
  tags: true,
  content: `{center}{bold}{cyan-fg}MARC Buyer Agent{/cyan-fg}{/bold} — {gray-fg}${buyer.publicKey().slice(0, 20)}...{/gray-fg}{/center}`,
});

const balanceBar = blessed.box({
  top: 3,
  left: 0,
  width: "100%",
  height: 3,
  tags: true,
  border: { type: "line" },
  style: { border: { fg: "gray" } },
  content: "{gray-fg}Loading balances...{/gray-fg}",
});

async function refreshBalances() {
  const buyerUsdc = await getUsdc(buyer.publicKey());
  balanceBar.setContent(
    `  {cyan-fg}Buyer{/cyan-fg} {bold}${buyerUsdc} USDC{/bold}   {gray-fg}|{/gray-fg}   {gray-fg}Dashboard → http://localhost:3000/app{/gray-fg}`,
  );
  screen.render();
}

const agentsBox = blessed.box({
  top: 6,
  left: 0,
  width: "40%",
  height: "55%",
  label: " Available Agents ",
  border: { type: "line" },
  tags: true,
  style: { border: { fg: "cyan" } },
  content: "{gray-fg}Loading...{/gray-fg}",
});

const detailBox = blessed.box({
  top: 6,
  left: "40%",
  width: "60%",
  height: "55%",
  label: " Agent Details ",
  border: { type: "line" },
  tags: true,
  style: { border: { fg: "yellow" } },
  content: "{gray-fg}Select an agent to see details{/gray-fg}",
});

const taskBox = blessed.textarea({
  top: "61%",
  left: 0,
  width: "100%",
  height: 5,
  label: " Your Task (type here, Enter to submit) ",
  border: { type: "line" },
  tags: true,
  inputOnFocus: true,
  style: { border: { fg: "green" }, focus: { border: { fg: "white" } } },
});

const logBox = blessed.log({
  top: "61%",
  left: 0,
  width: "60%",
  height: "39%",
  label: " Buyer Activity ",
  border: { type: "line" },
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  style: { border: { fg: "magenta" } },
  hidden: true,
});

const sellerLogBox = blessed.log({
  top: "61%",
  left: "60%",
  width: "40%",
  height: "39%",
  label: " Seller Activity ",
  border: { type: "line" },
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  style: { border: { fg: "cyan" } },
  hidden: true,
});

screen.append(header);
screen.append(balanceBar);
screen.append(agentsBox);
screen.append(detailBox);
screen.append(taskBox);
screen.append(logBox);
screen.append(sellerLogBox);

// Recalculate layout when the terminal window is resized so boxes and logs
// do not overlap or become distorted.
screen.on("resize", () => {
  header.emit("attach");
  balanceBar.emit("attach");
  agentsBox.emit("attach");
  detailBox.emit("attach");
  taskBox.emit("attach");
  logBox.emit("attach");
  sellerLogBox.emit("attach");
  screen.render();
});

screen.key(["C-c"], () => process.exit(0));
screen.key(["n"], () => {
  logBox.hide();
  sellerLogBox.hide();
  taskBox.show();
  taskBox.setValue("");
  agentsBox.focus();
  screen.render();
});

function log(msg: string) {
  const ts = new Date().toTimeString().slice(0, 8);
  logBox.log(`{gray-fg}[${ts}]{/gray-fg} ${msg}`);
  screen.render();
}

// ── Load agents ───────────────────────────────────────────────────────────────

let agents: any[] = [];
let selectedIndex = 0;
let currentSellerLog: string | null = null;

function watchSellerLog(picked: any) {
  if (currentSellerLog) {
    unwatchFile(currentSellerLog);
  }
  const sellerLog = `../agents/${picked.id}/seller.log`;
  currentSellerLog = sellerLog;
  let lastSize = 0;
  watchFile(sellerLog, { interval: 1000 }, () => {
    if (!existsSync(sellerLog)) return;
    const content = readFileSync(sellerLog, "utf8");
    const newContent = content.slice(lastSize);
    lastSize = content.length;
    newContent
      .split("\n")
      .filter(Boolean)
      .forEach((line) => sellerLogBox.log(line));
    screen.render();
  });
}

async function loadAgents() {
  try {
    agents = await fetch(REGISTRY).then((r) => r.json());
    renderAgents();
  } catch {
    agentsBox.setContent("{red-fg}Registry not running — start agents/registry first{/red-fg}");
    screen.render();
  }
}

function renderAgents() {
  agentsBox.setContent(
    agents
      .map((a, i) =>
        i === selectedIndex
          ? `{white-bg}{black-fg} ▶ ${a.name} {/black-fg}{/white-bg}`
          : `   {cyan-fg}${a.name}{/cyan-fg}`,
      )
      .join("\n"),
  );
  if (agents[selectedIndex]) {
    const a = agents[selectedIndex];
    detailBox.setContent(
      `{bold}{cyan-fg}${a.name}{/cyan-fg}{/bold}\n\n` +
        `{yellow-fg}What it does:{/yellow-fg}\n${a.description}\n\n` +
        `{yellow-fg}Tasks:{/yellow-fg}\n${a.tasks.map((t: string) => `  • ${t}`).join("\n")}\n\n` +
        `{yellow-fg}Input:{/yellow-fg}\n${a.input}\n\n` +
        `{yellow-fg}Output:{/yellow-fg}\n${a.output}\n\n` +
        `{yellow-fg}Price:{/yellow-fg} {green-fg}${a.price_usdc} USDC{/green-fg}\n` +
        `{yellow-fg}Wallet:{/yellow-fg} {gray-fg}${a.wallet?.slice(0, 20)}...{/gray-fg}`,
    );
  }
  screen.render();
}

screen.key(["up", "k"], () => {
  if (taskBox.hidden) return; // only navigate when task box visible
  selectedIndex = Math.max(0, selectedIndex - 1);
  renderAgents();
});
screen.key(["down", "j"], () => {
  if (taskBox.hidden) return;
  selectedIndex = Math.min(agents.length - 1, selectedIndex + 1);
  renderAgents();
});

// ── LLM-powered job routing ───────────────────────────────────────────────────

/**
 * End-to-end NLP job routing: classify the task, pick a provider from the
 * registry, create the escrow job, poll until completion, and return a
 * structured result. Retries provider selection if the chosen provider fails
 * to submit within the timeout.
 */
async function runSmartJob(description: string): Promise<BuyerResult | null> {
  log(`{cyan-fg}Classifying task via ${LLM_PROVIDER}/${LLM_MODEL}...{/cyan-fg}`);
  const { capabilities, summary } = await classifyTask(description);
  log(`{gray-fg}capabilities: ${capabilities.join(", ")}{/gray-fg}`);

  const available = agents.length > 0 ? agents : await fetch(REGISTRY).then((r) => r.json());
  const selection = selectProvider(available, capabilities);
  if (!selection) {
    log("{red-fg}No matching provider found in registry{/red-fg}");
    return null;
  }

  const provider = selection.agent;
  log(
    `{green-fg}Selected provider:{/green-fg} ${provider.name} (score ${selection.score.toFixed(2)})`,
  );

  const jobId = await createEscrowJob(provider, summary, cliArgs.budget);
  if (!jobId) return null;

  const result = await pollJobCompletion(jobId);
  if (!result) {
    log("{yellow-fg}Provider timed out — retrying with next best provider{/yellow-fg}");
    const fallback = selectProvider(
      available.filter((a) => a.id !== provider.id),
      capabilities,
    );
    if (!fallback) return null;
    const retryJobId = await createEscrowJob(fallback.agent, summary, cliArgs.budget);
    if (!retryJobId) return null;
    const retryResult = await pollJobCompletion(retryJobId);
    if (!retryResult) return null;
    return {
      jobId: retryJobId,
      provider: fallback.agent.name,
      cost: `${fallback.agent.price_usdc} USDC`,
      result: retryResult,
    };
  }

  return {
    jobId,
    provider: provider.name,
    cost: `${provider.price_usdc} USDC`,
    result,
  };
}

async function createEscrowJob(
  provider: any,
  description: string,
  budget: bigint,
): Promise<string | null> {
  try {
    const commerce = new CommerceClient(cfg, buyer);
    const job = await retryWithBackoff(() =>
      commerce.createJob({
        provider: provider.wallet,
        description,
        budget,
      }),
    );
    log(`{green-fg}Escrow job created:{/green-fg} ${job.id}`);
    return job.id;
  } catch (err) {
    log(`{red-fg}Failed to create job: ${(err as Error).message}{/red-fg}`);
    return null;
  }
}

async function pollJobCompletion(jobId: string): Promise<string | null> {
  const commerce = new CommerceClient(cfg, buyer);
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    try {
      const job: Job = await commerce.getJob(jobId);
      if (job.status === "Completed") {
        log(`{green-fg}Job ${jobId} completed{/green-fg}`);
        return job.result ?? "";
      }
      if (job.status === "Failed" || job.status === "Cancelled") {
        log(`{red-fg}Job ${jobId} ${job.status}{/red-fg}`);
        return null;
      }
    } catch {
      // transient RPC error — keep polling
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
}

// Submit handler: route the typed task through the LLM-powered pipeline.
taskBox.key("enter", async () => {
  const description = taskBox.getValue().trim();
  if (!description) return;
  taskBox.hide();
  logBox.show();
  sellerLogBox.show();
  screen.render();

  const result = await runSmartJob(description);
  if (result) {
    log(
      `{bold}{green-fg}Result{/green-fg}{/bold} ${JSON.stringify(result, null, 2)}`,
    );
  }
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

loadAgents();
refreshBalances();
setInterval(refreshBalances, 15_000);

if (cliArgs.description) {
  runSmartJob(cliArgs.description).then((result) => {
    if (result) console.log(JSON.stringify(result, null, 2));
  });
}

screen.render();
