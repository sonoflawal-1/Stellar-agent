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

export interface RetryPolicy {
  /** Total attempts allowed (including the first). */
  maxAttempts: number;
  /** Base backoff in ms; attempt N waits baseBackoffMs * 2^(N-1). */
  baseBackoffMs: number;
  /** Upper bound on a single backoff wait. */
  maxBackoffMs: number;
}

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "compensated";

export interface TaskNode {
  id: string;
  skill: string;
  description: string;
  dependsOn: string[];
  budget: bigint;
  status: TaskStatus;
  jobId?: bigint;
  deliverable?: string;
  providerAddress?: string;
  retry: RetryPolicy;
  attempts: number;
  lastError?: string;
}

export type TaskDAG = Map<string, TaskNode>;

/** Per-node fund accounting for the final report. */
export interface NodeFunds {
  budget: bigint;
  /** Amount escrowed on-chain (0 if no job was ever created). */
  escrowed: bigint;
  /** Amount released to the provider on successful completion. */
  released: bigint;
  /** Amount refunded back to the orchestrator via compensation. */
  refunded: bigint;
}

export interface NodeReport {
  id: string;
  skill: string;
  status: TaskStatus;
  jobId?: bigint;
  providerAddress?: string;
  deliverable?: string;
  attempts: number;
  lastError?: string;
  funds: NodeFunds;
}

export interface OrchestratorReport {
  goal: string;
  nodes: NodeReport[];
  totals: {
    escrowed: bigint;
    released: bigint;
    refunded: bigint;
    /** Funds that were escrowed but neither released nor refunded. */
    outstanding: bigint;
  };
  allSucceeded: boolean;
}

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
const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseBackoffMs: 1_000,
  maxBackoffMs: 10_000,
};

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

  /** Build a fresh pending node with the default retry policy. */
  private _node(
    id: string,
    skill: string,
    description: string,
    dependsOn: string[],
    budget: bigint = DEFAULT_BUDGET,
  ): TaskNode {
    return {
      id,
      skill,
      description,
      dependsOn,
      budget,
      status: "pending",
      retry: { ...DEFAULT_RETRY },
      attempts: 0,
    };
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
      dag.set(
        "name",
        this._node("name", "namer", `Generate a memorable product name for: ${goal}`, []),
      );
      dag.set(
        "copy",
        this._node(
          "copy",
          "copywriter",
          `Write marketing copy for the product named [name-deliverable]. Goal: ${goal}`,
          ["name"],
        ),
      );
      dag.set(
        "web",
        this._node(
          "web",
          "webbuilder",
          `Build a landing page using the copy [copy-deliverable] for: ${goal}`,
          ["copy"],
        ),
      );
    } else if (lower.includes("research") || lower.includes("analyse") || lower.includes("analyze")) {
      // researcher → copywriter (summarise findings)
      dag.set(
        "research",
        this._node(
          "research",
          "researcher",
          `Research the following topic thoroughly: ${goal}`,
          [],
        ),
      );
      dag.set(
        "report",
        this._node(
          "report",
          "copywriter",
          `Summarise the research findings [research-deliverable] into a concise report. Goal: ${goal}`,
          ["research"],
        ),
      );
    } else {
      // Generic fallback: research → write → publish
      dag.set(
        "task-1",
        this._node("task-1", "researcher", `Step 1 — gather background information for: ${goal}`, []),
      );
      dag.set(
        "task-2",
        this._node(
          "task-2",
          "copywriter",
          `Step 2 — produce content based on [task-1-deliverable] for: ${goal}`,
          ["task-1"],
        ),
      );
      dag.set(
        "task-3",
        this._node(
          "task-3",
          "webbuilder",
          `Step 3 — publish and present [task-2-deliverable] for: ${goal}`,
          ["task-2"],
        ),
      );
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

  // ── Partial Failure Handling / Compensation ─────────────────────────────────

  /**
   * Collect the failed task and all tasks that (transitively) depend on it.
   * Completed nodes are never included — their deliverables are preserved.
   */
  private _collectFailureClosure(dag: TaskDAG, failedTaskId: string): Set<string> {
    const affected = new Set<string>([failedTaskId]);

    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, node] of dag) {
        if (!affected.has(id) && node.dependsOn.some((dep) => affected.has(dep))) {
          affected.add(id);
          changed = true;
        }
      }
    }

    // Never compensate a node that already succeeded.
    for (const id of [...affected]) {
      if (dag.get(id)?.status === "completed") affected.delete(id);
    }
    return affected;
  }

  /**
   * Mark a failed task and all its transitive dependents as failed, then run
   * compensation (cancel/refund) for any escrowed jobs among them.
   *
   * Kept for backwards compatibility — delegates to the compensation path.
   */
  async handlePartialFailure(dag: TaskDAG, failedTaskId: string): Promise<void> {
    await this.compensate(dag, failedTaskId);
  }

  /**
   * Compensation path: for the failed node and every transitive dependent,
   * cancel/refund any escrowed on-chain job and mark the node "compensated"
   * (or "failed" if it never escrowed funds). Completed nodes are untouched.
   */
  async compensate(dag: TaskDAG, failedTaskId: string): Promise<void> {
    const affected = this._collectFailureClosure(dag, failedTaskId);

    for (const id of affected) {
      const node = dag.get(id)!;
      if (node.status === "completed") continue;

      if (node.jobId !== undefined) {
        try {
          console.log(`[orchestrator]   Compensating job #${node.jobId} for task "${id}"…`);
          await this._refundJob(node.jobId);
          node.status = "compensated";
          console.error(
            `[orchestrator] Task "${id}" (${node.skill}) COMPENSATED — job #${node.jobId} refunded`,
          );
        } catch (err) {
          node.status = "failed";
          node.lastError = `compensation failed: ${(err as Error).message}`;
          console.error(
            `[orchestrator] Task "${id}" compensation FAILED: ${(err as Error).message}`,
          );
        }
      } else {
        node.status = "failed";
        console.error(`[orchestrator] Task "${id}" (${node.skill}) marked as FAILED (no escrow)`);
      }
    }
  }

  /**
   * Cancel/refund an escrowed job. Prefers an explicit refund; falls back to
   * cancellation when the SDK exposes only that.
   */
  private async _refundJob(jobId: bigint): Promise<void> {
    const commerce = this.commerce as unknown as {
      refundJob?: (kp: Keypair, id: bigint) => Promise<unknown>;
      cancelJob?: (kp: Keypair, id: bigint) => Promise<unknown>;
    };
    if (typeof commerce.refundJob === "function") {
      await commerce.refundJob(this.keypair, jobId);
      return;
    }
    if (typeof commerce.cancelJob === "function") {
      await commerce.cancelJob(this.keypair, jobId);
      return;
    }
    throw new Error("CommerceClient exposes neither refundJob nor cancelJob");
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

      const deliverable = await this.runNode(dag, task, description);
      if (deliverable === null) {
        // Terminal failure — compensate this node and all dependents.
        await this.compensate(dag, task.id);
        continue;
      }

      task.deliverable = deliverable;
      task.status = "completed";
      completed.add(task.id);
      console.log(`[orchestrator] ✓ Task "${task.id}" completed. Deliverable: ${deliverable}`);
    }
  }

  /**
   * Run a single node with retries. Each attempt re-discovers a provider and
   * escrows a fresh job (a failed attempt's job is refunded before retrying).
   *
   * Returns the deliverable on success, or null after exhausting attempts.
   */
  async runNode(dag: TaskDAG, task: TaskNode, description: string): Promise<string | null> {
    const max = Math.max(1, task.retry.maxAttempts);

    for (let attempt = 1; attempt <= max; attempt++) {
      task.attempts = attempt;
      console.log(`[orchestrator]   Attempt ${attempt}/${max} for task "${task.id}"`);

      try {
        // Locate a provider
        const providerAddress = await this.findProvider(task.skill);
        if (!providerAddress) {
          throw new Error(`no provider found for skill "${task.skill}"`);
        }
        task.providerAddress = providerAddress;

        // Escrow the job on-chain
        console.log(`[orchestrator]   Escrowing job on-chain with provider ${providerAddress}…`);
        const jobId = await this.commerce.createJob(
          this.keypair,
          providerAddress,
          DEFAULT_EVALUATOR,
          undefined, // uses cfg.usdcToken
          task.budget,
          description,
        );
        task.jobId = jobId;
        console.log(`[orchestrator]   Job #${jobId} created on-chain ✓`);

        // Poll for completion
        const deliverable = await this._pollJobCompletion(jobId);
        if (deliverable === null) {
          throw new Error(`job #${jobId} timed out or was rejected`);
        }
        return deliverable;
      } catch (err) {
        task.lastError = (err as Error).message;
        console.error(`[orchestrator]   Attempt ${attempt} failed: ${task.lastError}`);

        // Refund the escrowed job from this attempt before retrying.
        if (task.jobId !== undefined) {
          try {
            await this._refundJob(task.jobId);
            console.log(`[orchestrator]   Refunded job #${task.jobId} after failed attempt`);
          } catch (refundErr) {
            console.error(
              `[orchestrator]   Refund of job #${task.jobId} failed: ${(refundErr as Error).message}`,
            );
          }
          task.jobId = undefined;
        }

        if (attempt < max) {
          const backoff = Math.min(
            task.retry.baseBackoffMs * 2 ** (attempt - 1),
            task.retry.maxBackoffMs,
          );
          console.log(`[orchestrator]   Backing off ${backoff}ms before retry…`);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }

    console.error(`[orchestrator] Task "${task.id}" exhausted ${max} attempts`);
    return null;
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
  async run(goal: string): Promise<OrchestratorReport> {
    console.log(`\n[orchestrator] ═══════════════════════════════════════════════`);
    console.log(`[orchestrator] Goal: "${goal}"`);
    console.log(`[orchestrator] ═══════════════════════════════════════════════\n`);

    const dag = this.planTasks(goal);
    await this.executeDAG(dag);

    const report = this.buildReport(goal, dag);
    this.logReport(report);
    return report;
  }

  /** Assemble the final report object with per-node status and fund flows. */
  buildReport(goal: string, dag: TaskDAG): OrchestratorReport {
    const nodes: NodeReport[] = [];
    const totals = { escrowed: 0n, released: 0n, refunded: 0n, outstanding: 0n };
    let allSucceeded = true;

    for (const [id, node] of dag) {
      const funds: NodeFunds = {
        budget: node.budget,
        escrowed: 0n,
        released: 0n,
        refunded: 0n,
      };

      if (node.status === "completed") {
        funds.escrowed = node.budget;
        funds.released = node.budget;
      } else if (node.status === "compensated") {
        funds.escrowed = node.budget;
        funds.refunded = node.budget;
      } else if (node.jobId !== undefined) {
        // Escrowed but neither released nor refunded — funds still at risk.
        funds.escrowed = node.budget;
      }

      totals.escrowed += funds.escrowed;
      totals.released += funds.released;
      totals.refunded += funds.refunded;

      if (node.status !== "completed") allSucceeded = false;

      nodes.push({
        id,
        skill: node.skill,
        status: node.status,
        jobId: node.jobId,
        providerAddress: node.providerAddress,
        deliverable: node.deliverable,
        attempts: node.attempts,
        lastError: node.lastError,
        funds,
      });
    }

    totals.outstanding = totals.escrowed - totals.released - totals.refunded;
    return { goal, nodes, totals, allSucceeded };
  }

  /** Log the final report in a human-readable form. */
  logReport(report: OrchestratorReport): void {
    console.log("\n[orchestrator] ═══════════════ FINAL REPORT ═══════════════════");
    for (const node of report.nodes) {
      const icon = node.status === "completed" ? "✓" : "✗";
      console.log(`  ${icon} [${node.status.toUpperCase()}] ${node.id} (${node.skill})`);
      if (node.jobId !== undefined) console.log(`      job: #${node.jobId}`);
      if (node.providerAddress) console.log(`      provider: ${node.providerAddress}`);
      console.log(`      attempts: ${node.attempts}`);
      console.log(
        `      funds: budget=${node.funds.budget} escrowed=${node.funds.escrowed} ` +
          `released=${node.funds.released} refunded=${node.funds.refunded}`,
      );
      if (node.deliverable) console.log(`      deliverable: ${node.deliverable}`);
      if (node.lastError) console.log(`      lastError: ${node.lastError}`);
    }

    console.log(
      `\n  TOTALS: escrowed=${report.totals.escrowed} released=${report.totals.released} ` +
        `refunded=${report.totals.refunded} outstanding=${report.totals.outstanding}`,
    );

    if (report.allSucceeded) {
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
