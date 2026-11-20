/**
 * OrchestratorAgent — Bear Protocol issue #725
 *
 * Decomposes a high-level goal into a DAG of sub-tasks, discovers providers
 * from the agent registry, escrows each job on-chain via CommerceClient, polls
 * for completion, feeds deliverables into downstream tasks, and handles partial
 * failure by marking all dependents as failed.
 */

import "dotenv/config";
import { Keypair } from "@stellar/stellar-sdk";
import { CommerceClient, TESTNET, type MarcConfig } from "marc-stellar-sdk";
import { JobStatus } from "marc-stellar-sdk";
import { validateEnv } from "../shared/env.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TaskNode {
  id: string;
  skill: string;
  description: string;
  dependsOn: string[];
  budget: bigint;
  status: "pending" | "running" | "completed" | "failed";
  jobId?: bigint;
  deliverable?: string;
  providerAddress?: string;
}

export type TaskDAG = Map<string, TaskNode>;

// ── Registry agent shape returned by GET /agents ─────────────────────────────

interface RegistryAgent {
  id?: string;
  name?: string;
  description?: string;
  url?: string;
  wallet?: string;
  tags?: string[];
  [key: string]: unknown;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes
const DEFAULT_BUDGET = 10_000_000n; // 1 USDC (7 decimals)
const DEFAULT_EVALUATOR = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN"; // well-known testnet evaluator placeholder

// ── OrchestratorAgent ─────────────────────────────────────────────────────────

export class OrchestratorAgent {
  private readonly commerce: CommerceClient;
  private readonly keypair: Keypair;
  private readonly registryUrl: string;

  constructor(cfg: MarcConfig, registryUrl: string, keypair: Keypair) {
    this.commerce = new CommerceClient(cfg);
    this.keypair = keypair;
    this.registryUrl = registryUrl.replace(/\/+$/, "");
  }

  // ── Task Planning ───────────────────────────────────────────────────────────

  /**
   * Decompose a natural-language goal into a TaskDAG.
   *
   * The decomposition is a hardcoded heuristic for well-known goal patterns.
   * Unknown goals fall back to a generic 3-task research → write → publish DAG.
   */
  planTasks(goal: string): TaskDAG {
    const dag: TaskDAG = new Map();
    const lower = goal.toLowerCase();

    if (lower.includes("launch") && lower.includes("product")) {
      // namer → copywriter (depends on namer) → webbuilder (depends on copywriter)
      dag.set("name", {
        id: "name",
        skill: "namer",
        description: `Generate a memorable product name for: ${goal}`,
        dependsOn: [],
        budget: DEFAULT_BUDGET,
        status: "pending",
      });
      dag.set("copy", {
        id: "copy",
        skill: "copywriter",
        description: `Write marketing copy for the product named [name-deliverable]. Goal: ${goal}`,
        dependsOn: ["name"],
        budget: DEFAULT_BUDGET,
        status: "pending",
      });
      dag.set("web", {
        id: "web",
        skill: "webbuilder",
        description: `Build a landing page using the copy [copy-deliverable] for: ${goal}`,
        dependsOn: ["copy"],
        budget: DEFAULT_BUDGET,
        status: "pending",
      });
    } else if (lower.includes("research") || lower.includes("analyse") || lower.includes("analyze")) {
      // researcher → copywriter (summarise findings)
      dag.set("research", {
        id: "research",
        skill: "researcher",
        description: `Research the following topic thoroughly: ${goal}`,
        dependsOn: [],
        budget: DEFAULT_BUDGET,
        status: "pending",
      });
      dag.set("report", {
        id: "report",
        skill: "copywriter",
        description: `Summarise the research findings [research-deliverable] into a concise report. Goal: ${goal}`,
        dependsOn: ["research"],
        budget: DEFAULT_BUDGET,
        status: "pending",
      });
    } else {
      // Generic fallback: research → write → publish
      dag.set("task-1", {
        id: "task-1",
        skill: "researcher",
        description: `Step 1 — gather background information for: ${goal}`,
        dependsOn: [],
        budget: DEFAULT_BUDGET,
        status: "pending",
      });
      dag.set("task-2", {
        id: "task-2",
        skill: "copywriter",
        description: `Step 2 — produce content based on [task-1-deliverable] for: ${goal}`,
        dependsOn: ["task-1"],
        budget: DEFAULT_BUDGET,
        status: "pending",
      });
      dag.set("task-3", {
        id: "task-3",
        skill: "webbuilder",
        description: `Step 3 — publish and present [task-2-deliverable] for: ${goal}`,
        dependsOn: ["task-2"],
        budget: DEFAULT_BUDGET,
        status: "pending",
      });
    }

    console.log(`[orchestrator] Planned ${dag.size} tasks for goal: "${goal}"`);
    for (const [id, node] of dag) {
      console.log(`  • ${id} (${node.skill}) deps=[${node.dependsOn.join(", ")}]`);
    }
    return dag;
  }

  // ── Provider Discovery ──────────────────────────────────────────────────────

  /**
   * Query the registry and return the wallet address of the first agent whose
   * name, description, or tags contain the requested skill keyword.
   */
  async findProvider(skill: string): Promise<string | null> {
    const url = `${this.registryUrl}/agents`;
    console.log(`[orchestrator] Querying registry for skill "${skill}" at ${url}`);

    let agents: RegistryAgent[];
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`[orchestrator] Registry returned ${res.status} for GET /agents`);
        return null;
      }
      agents = (await res.json()) as RegistryAgent[];
    } catch (err) {
      console.warn(`[orchestrator] Registry unreachable: ${(err as Error).message}`);
      return null;
    }

    const needle = skill.toLowerCase();
    const match = agents.find((a) => {
      const searchable = [
        a.id ?? "",
        a.name ?? "",
        a.description ?? "",
        ...(a.tags ?? []),
      ]
        .join(" ")
        .toLowerCase();
      return searchable.includes(needle);
    });

    if (match?.wallet) {
      console.log(`[orchestrator] Found provider for "${skill}": ${match.wallet} (${match.name ?? match.id})`);
      return match.wallet;
    }

    console.warn(`[orchestrator] No provider found for skill "${skill}"`);
    return null;
  }

  // ── Partial Failure Handling ────────────────────────────────────────────────

  /**
   * Mark a failed task and all tasks that (transitively) depend on it as
   * "failed", then log them.
   */
  handlePartialFailure(dag: TaskDAG, failedTaskId: string): void {
    const toFail = new Set<string>([failedTaskId]);

    // BFS to collect all downstream dependents
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, node] of dag) {
        if (!toFail.has(id) && node.dependsOn.some((dep) => toFail.has(dep))) {
          toFail.add(id);
          changed = true;
        }
      }
    }

    for (const id of toFail) {
      const node = dag.get(id)!;
      if (node.status !== "completed") {
        node.status = "failed";
        console.error(`[orchestrator] Task "${id}" (${node.skill}) marked as FAILED`);
      }
    }
  }

  // ── DAG Execution ───────────────────────────────────────────────────────────

  /**
   * Execute all tasks in the DAG respecting dependency order.
   *
   * Uses a simple iterative "ready queue" approach (equivalent to Kahn's
   * topological sort) — no external graph library required.
   */
  async executeDAG(dag: TaskDAG): Promise<void> {
    const completed = new Set<string>();

    const isReady = (node: TaskNode): boolean =>
      node.status === "pending" &&
      node.dependsOn.every((dep) => {
        const d = dag.get(dep);
        return d?.status === "completed";
      });

    // Safety valve: abort if we loop too many times without progress
    let iterationsWithoutProgress = 0;
    const MAX_STALL = dag.size + 1;

    while (completed.size < dag.size) {
      // Collect tasks that are done
      for (const [id, node] of dag) {
        if (node.status === "completed") completed.add(id);
        if (node.status === "failed") completed.add(id); // don't block on failed tasks
      }
      if (completed.size === dag.size) break;

      // Find a ready task
      const ready: TaskNode[] = [];
      for (const node of dag.values()) {
        if (isReady(node)) ready.push(node);
      }

      if (ready.length === 0) {
        iterationsWithoutProgress++;
        if (iterationsWithoutProgress > MAX_STALL) {
          console.error("[orchestrator] DAG stalled — possible cycle or all remaining tasks failed");
          break;
        }
        // Brief pause before re-checking (handles transient failed deps)
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      iterationsWithoutProgress = 0;

      // Execute first ready task (sequential by design — issue spec says "sequentially on-chain")
      const task = ready[0];
      task.status = "running";

      // Substitute upstream deliverables into the description
      const description = this._interpolateDescription(dag, task);

      console.log(`\n[orchestrator] ▶ Executing task "${task.id}" (${task.skill})`);
      console.log(`  description: ${description}`);

      // Locate a provider
      const providerAddress = await this.findProvider(task.skill);
      if (!providerAddress) {
        console.error(`[orchestrator] No provider for skill "${task.skill}" — failing task`);
        this.handlePartialFailure(dag, task.id);
        continue;
      }
      task.providerAddress = providerAddress;

      // Escrow the job on-chain
      let jobId: bigint;
      try {
        console.log(`[orchestrator]   Escrowing job on-chain with provider ${providerAddress}…`);
        jobId = await this.commerce.createJob(
          this.keypair,
          providerAddress,
          DEFAULT_EVALUATOR,
          undefined, // uses cfg.usdcToken
          task.budget,
          description,
        );
        task.jobId = jobId;
        console.log(`[orchestrator]   Job #${jobId} created on-chain ✓`);
      } catch (err) {
        console.error(`[orchestrator]   createJob failed: ${(err as Error).message}`);
        this.handlePartialFailure(dag, task.id);
        continue;
      }

      // Poll for completion
      const deliverable = await this._pollJobCompletion(jobId);
      if (deliverable === null) {
        console.error(`[orchestrator]   Job #${jobId} timed out or was rejected`);
        this.handlePartialFailure(dag, task.id);
        continue;
      }

      task.deliverable = deliverable;
      task.status = "completed";
      completed.add(task.id);
      console.log(`[orchestrator] ✓ Task "${task.id}" completed. Deliverable: ${deliverable}`);
    }
  }

  // ── Polling ─────────────────────────────────────────────────────────────────

  /**
   * Poll `getJob` every POLL_INTERVAL_MS until the job reaches a terminal state.
   *
   * Returns the deliverable string on success, or null on timeout/rejection.
   */
  private async _pollJobCompletion(jobId: bigint): Promise<string | null> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    console.log(`[orchestrator]   Polling job #${jobId} (timeout ${POLL_TIMEOUT_MS / 1000}s)…`);

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      let job;
      try {
        job = await this.commerce.getJob(jobId);
      } catch (err) {
        console.warn(`[orchestrator]   getJob #${jobId} error: ${(err as Error).message}`);
        continue;
      }

      console.log(`[orchestrator]   Job #${jobId} status: ${job.status}`);

      if (job.status === JobStatus.Completed) {
        return job.deliverable || `job-${jobId}-completed`;
      }
      if (
        job.status === JobStatus.Rejected ||
        job.status === JobStatus.Cancelled
      ) {
        return null;
      }
      // Funded / Submitted — keep polling
    }

    console.error(`[orchestrator]   Job #${jobId} poll timeout exceeded`);
    return null;
  }

  // ── Description Interpolation ───────────────────────────────────────────────

  /**
   * Replace `[<depId>-deliverable]` placeholders in a task description with
   * the actual deliverable from the upstream task.
   */
  private _interpolateDescription(dag: TaskDAG, task: TaskNode): string {
    let desc = task.description;
    for (const depId of task.dependsOn) {
      const dep = dag.get(depId);
      if (dep?.deliverable) {
        desc = desc.replace(new RegExp(`\\[${depId}-deliverable\\]`, "g"), dep.deliverable);
      }
    }
    return desc;
  }

  // ── Top-level Run ───────────────────────────────────────────────────────────

  /**
   * Full pipeline: plan → execute DAG → report.
   */
  async run(goal: string): Promise<void> {
    console.log(`\n[orchestrator] ═══════════════════════════════════════════════`);
    console.log(`[orchestrator] Goal: "${goal}"`);
    console.log(`[orchestrator] ═══════════════════════════════════════════════\n`);

    const dag = this.planTasks(goal);
    await this.executeDAG(dag);

    // Final report
    console.log("\n[orchestrator] ═══════════════ FINAL REPORT ═══════════════════");
    let allSucceeded = true;
    for (const [id, node] of dag) {
      const icon = node.status === "completed" ? "✓" : "✗";
      console.log(`  ${icon} [${node.status.toUpperCase()}] ${id} (${node.skill})`);
      if (node.deliverable) {
        console.log(`      deliverable: ${node.deliverable}`);
      }
      if (node.status !== "completed") allSucceeded = false;
    }

    if (allSucceeded) {
      console.log("\n[orchestrator] All tasks completed successfully ✓");
    } else {
      console.log("\n[orchestrator] Some tasks failed — see report above ✗");
    }
    console.log("[orchestrator] ════════════════════════════════════════════════\n");
  }
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  // Validate required env vars at startup — exits with code 1 and a clear
  // table of missing variables if anything is absent.
  const env = validateEnv("orchestrator");

  const secretKey = env.SECRET_KEY;
  const registryUrl = env.REGISTRY_URL ?? "http://localhost:3001";

  const cfg: MarcConfig = {
    rpcUrl: process.env.STELLAR_RPC_URL ?? TESTNET.rpcUrl,
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? TESTNET.networkPassphrase,
    identityContract: process.env.AGENT_IDENTITY_CONTRACT ?? TESTNET.identityContract,
    commerceContract: process.env.AGENTIC_COMMERCE_CONTRACT ?? TESTNET.commerceContract,
    usdcToken: process.env.USDC_TOKEN_CONTRACT ?? TESTNET.usdcToken,
    onTx: (hash) =>
      console.log(`[tx] ${hash} → https://stellar.expert/explorer/testnet/tx/${hash}`),
  };

  const keypair = Keypair.fromSecret(secretKey);
  const goal = process.argv[2] ?? "Launch a new product: a Stellar-powered payment tool";

  const orchestrator = new OrchestratorAgent(cfg, registryUrl, keypair);
  orchestrator.run(goal).catch((err) => {
    console.error("[orchestrator] Fatal error:", err);
    process.exit(1);
  });
}
