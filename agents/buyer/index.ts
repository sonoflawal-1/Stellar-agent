import "dotenv/config";
import blessed from "blessed";
import { Keypair, Contract, Account, TransactionBuilder, BASE_FEE, Address, scValToNative, rpc } from "@stellar/stellar-sdk";
import { IdentityClient, CommerceClient, TESTNET, type MarcConfig, type Job } from "marc-stellar-sdk";

const cfg: MarcConfig = {
  rpcUrl: process.env.STELLAR_RPC_URL ?? TESTNET.rpcUrl,
  networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? TESTNET.networkPassphrase,
  identityContract: process.env.AGENT_IDENTITY_CONTRACT || TESTNET.identityContract,
  commerceContract: process.env.AGENTIC_COMMERCE_CONTRACT || TESTNET.commerceContract,
  usdcToken: process.env.USDC_TOKEN_CONTRACT || TESTNET.usdcToken,
  onTx: (hash) => log(`{gray-fg}tx: ${hash.slice(0, 16)}... → https://stellar.expert/explorer/testnet/tx/${hash}{/gray-fg}`),
};

async function getUsdc(pubkey: string): Promise<string> {
  try {
    const server = new rpc.Server(cfg.rpcUrl, { allowHttp: false });
    const op = new Contract(cfg.usdcToken).call("balance", new Address(pubkey).toScVal());
    const dummy = new Account(Keypair.random().publicKey(), "0");
    const tx = new TransactionBuilder(dummy, { fee: BASE_FEE, networkPassphrase: cfg.networkPassphrase })
      .addOperation(op).setTimeout(30).build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) return "?.??";
    const val = BigInt(scValToNative((sim as rpc.Api.SimulateTransactionSuccessResponse).result!.retval));
    return `${val / 10_000_000n}.${(val % 10_000_000n).toString().padStart(7, "0").slice(0, 2)}`;
  } catch { return "?.??"; }
}

// ── TUI ───────────────────────────────────────────────────────────────────────

const buyer = Keypair.fromSecret(process.env.BUYER_SECRET!);
const REGISTRY = "http://localhost:4500/agents";

const screen = blessed.screen({ smartCSR: true, title: "MARC Buyer Agent" });

const header = blessed.box({
  top: 0, left: 0, width: "100%", height: 3,
  tags: true,
  content: `{center}{bold}{cyan-fg}MARC Buyer Agent{/cyan-fg}{/bold} — {gray-fg}${buyer.publicKey().slice(0, 20)}...{/gray-fg}{/center}`,
});

const balanceBar = blessed.box({
  top: 3, left: 0, width: "100%", height: 3,
  tags: true,
  border: { type: "line" },
  style: { border: { fg: "gray" } },
  content: "{gray-fg}Loading balances...{/gray-fg}",
});

async function refreshBalances() {
  const buyerUsdc = await getUsdc(buyer.publicKey());
  balanceBar.setContent(
    `  {cyan-fg}Buyer{/cyan-fg} {bold}${buyerUsdc} USDC{/bold}   {gray-fg}|{/gray-fg}   {gray-fg}Dashboard → http://localhost:3000/app{/gray-fg}`
  );
  screen.render();
}

const agentsBox = blessed.box({
  top: 6, left: 0, width: "40%", height: "55%",
  label: " Available Agents ",
  border: { type: "line" },
  tags: true,
  style: { border: { fg: "cyan" } },
  content: "{gray-fg}Loading...{/gray-fg}",
});

const detailBox = blessed.box({
  top: 6, left: "40%", width: "60%", height: "55%",
  label: " Agent Details ",
  border: { type: "line" },
  tags: true,
  style: { border: { fg: "yellow" } },
  content: "{gray-fg}Select an agent to see details{/gray-fg}",
});

const taskBox = blessed.textarea({
  top: "61%", left: 0, width: "100%", height: 5,
  label: " Your Task (type here, Enter to submit) ",
  border: { type: "line" },
  tags: true,
  inputOnFocus: true,
  style: { border: { fg: "green" }, focus: { border: { fg: "white" } } },
});

const logBox = blessed.log({
  top: "61%", left: 0, width: "60%", height: "39%",
  label: " Buyer Activity ",
  border: { type: "line" },
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  style: { border: { fg: "magenta" } },
  hidden: true,
});

const sellerLogBox = blessed.log({
  top: "61%", left: "60%", width: "40%", height: "39%",
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
screen.key(["C-c"], () => process.exit(0));
screen.key(["n"], () => {
  logBox.hide(); sellerLogBox.hide();
  taskBox.show(); taskBox.setValue("");
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
    agents.map((a, i) =>
      i === selectedIndex
        ? `{white-bg}{black-fg} ▶ ${a.name} {/black-fg}{/white-bg}`
        : `   {cyan-fg}${a.name}{/cyan-fg}`
    ).join("\n")
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
      `{yellow-fg}Wallet:{/yellow-fg} {gray-fg}${a.wallet?.slice(0, 20)}...{/gray-fg}`
    );
  }
  screen.render();
}

screen.key(["up", "k"], () => {
  if (taskBox.hidden) return; // only navigate when task box visible
  selectedIndex = Math.max(0, selectedIndex - 1); renderAgents();
});
screen.key(["down", "j"], () => {
  if (taskBox.hidden) return;
  selectedIndex = Math.min(agents.length - 1, selectedIndex + 1); renderAgents();
});

// Arrow keys on agentsBox directly
agentsBox.key(["up"], () => { selectedIndex = Math.max(0, selectedIndex - 1); renderAgents(); });
agentsBox.key(["down"], () => { selectedIndex = Math.min(agents.length - 1, selectedIndex + 1); renderAgents(); });
agentsBox.key(["enter", "tab"], () => { taskBox.focus(); });
screen.key(["enter"], async () => {
  const task = taskBox.getValue().trim();
  if (!task || agents.length === 0) return;
  await submitTask(task);
});

taskBox.key(["enter"], async () => {
  const task = taskBox.getValue().trim();
  if (!task) return;
  await submitTask(task);
});

// ── Deliverable validation ────────────────────────────────────────────────────

function validateDeliverable(job: Job): { valid: boolean; reason?: string } {
  if (!job.deliverable || typeof job.deliverable !== "string") {
    return { valid: false, reason: "deliverable is empty or not a string" };
  }
  const s = job.deliverable.trim();
  if (s.length === 0) {
    return { valid: false, reason: "deliverable is whitespace-only" };
  }
  const scheme = s.split("://")[0];
  if (!scheme || !/^[a-z][a-z0-9+.-]*$/i.test(scheme)) {
    return { valid: false, reason: `deliverable is not a valid URI: "${s.slice(0, 80)}"` };
  }
  if (job.status !== "Submitted") {
    return { valid: false, reason: `expected status Submitted, got ${job.status}` };
  }
  return { valid: true };
}

// ── Submit task ───────────────────────────────────────────────────────────────

async function submitTask(task: string) {
  const picked = agents[selectedIndex];
  taskBox.hide();
  logBox.show();
  sellerLogBox.show();
  sellerLogBox.setLabel(` ${picked.name} Activity `);

  // Tail seller log file
  import("node:fs").then(({ watchFile, readFileSync, existsSync }) => {
    const sellerLog = `../agents/${picked.id}/seller.log`;
    let lastSize = 0;
    watchFile(sellerLog, { interval: 1000 }, () => {
      if (!existsSync(sellerLog)) return;
      const content = readFileSync(sellerLog, "utf8");
      const newContent = content.slice(lastSize);
      lastSize = content.length;
      newContent.split("\n").filter(Boolean).forEach((line) => sellerLogBox.log(line));
      screen.render();
    });
  });

  screen.render();

  log(`{cyan-fg}Hiring {bold}${picked.name}{/bold}:{/cyan-fg}`);
  log(`  "${task}"`);

  try {
    const identity = new IdentityClient(cfg);
    let agentId = await identity.agentOf(buyer.publicKey());
    if (!agentId) {
      agentId = await identity.register(buyer, "ipfs://buyer-agent.json");
      log(`Registered on-chain as agent #${agentId}`);
    } else {
      log(`Buyer is agent #${agentId} on-chain`);
    }

    log(`Creating escrow job on MARC...`);
    const commerce = new CommerceClient(cfg);
    const jobId = await commerce.createJob(
      buyer, picked.wallet, buyer.publicKey(),
      cfg.usdcToken, BigInt(10_000_000), task,
    );
    log(`{green-fg}Job #${jobId} created — 1 USDC locked in escrow{/green-fg}`);

    // Notify seller server
    log(`Sending job to ${picked.name} at ${picked.url}...`);
    const sellerRes = await fetch(`${picked.url}/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: jobId.toString(), task }),
    });

    if (!sellerRes.ok) {
      const text = await sellerRes.text();
      log(`{red-fg}Seller rejected job request: ${sellerRes.status} ${text}{/red-fg}`);
      log(`{red-fg}Cancelling job #${jobId} — no payment issued{/red-fg}`);
      await commerce.cancel(buyer, jobId);
      return;
    }

    let sellerBody: any;
    try {
      sellerBody = await sellerRes.json();
    } catch {
      log(`{red-fg}Seller returned invalid JSON for job acceptance{/red-fg}`);
      log(`{red-fg}Cancelling job #${jobId} — no payment issued{/red-fg}`);
      await commerce.cancel(buyer, jobId);
      return;
    }

    if (sellerBody?.status !== "accepted" || sellerBody?.jobId !== jobId.toString()) {
      log(`{red-fg}Seller response failed validation: ${JSON.stringify(sellerBody)}{/red-fg}`);
      log(`{red-fg}Cancelling job #${jobId} — no payment issued{/red-fg}`);
      await commerce.cancel(buyer, jobId);
      return;
    }

    log(`{cyan-fg}${picked.name} accepted the job — working...{/cyan-fg}`);
    log(`Waiting for deliverable...`);

    // Poll for submission with retry on timeout
    let job: Job | null = null;
    while (true) {
      try {
        job = await commerce.getJob(jobId);
        if (job?.status === "Submitted") {
          log(`{green-fg}Deliverable received: ${job.deliverable}{/green-fg}`);
          break;
        }
      } catch { /* transient RPC error — retry */ }
      await new Promise((r) => setTimeout(r, 5000));
    }

    // Validate deliverable before paying
    const validation = validateDeliverable(job!);
    if (!validation.valid) {
      log(`{red-fg}Deliverable validation failed: ${validation.reason}{/red-fg}`);
      log(`{red-fg}Cancelling job #${jobId} — no payment issued{/red-fg}`);
      await commerce.cancel(buyer, jobId);
      return;
    }

    await commerce.complete(buyer, jobId);
    log(`{green-fg}{bold}✓ Job #${jobId} complete — 99% paid to ${picked.name}{/bold}{/green-fg}`);
    log(`{gray-fg}Press 'n' to start a new task{/gray-fg}`);
    await refreshBalances();
  } catch (err) {
    const msg = err instanceof Error ? err.message : JSON.stringify(err);
    log(`{red-fg}Error: ${msg.split("\n")[0] || JSON.stringify(err)}{/red-fg}`);
    log(`{gray-fg}Seller wallet: ${picked.wallet ?? "NOT SET — re-run wallet populate script"}{/gray-fg}`);
  }
}

agentsBox.focus();
screen.render();
refreshBalances();
await loadAgents();
