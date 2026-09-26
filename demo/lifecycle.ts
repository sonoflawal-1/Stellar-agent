/**
 * One-shot lifecycle orchestrator.
 *
 * 1. Spawns seller-agent as a child process
 * 2. Waits for it to start listening
 * 3. Runs buyer-agent inline (same process)
 * 4. Kills seller when buyer finishes
 * 5. Exits 0 on success
 *
 * x402 payment is tracked as a separate health check.
 * If the x402 micropayment step fails the lifecycle exits non-zero
 * so CI / dashboards catch facilitator regressions.
 *
 * CLI flags:
 *   --dry-run      Simulate the full lifecycle locally without testnet RPC (#586).
 *   --step         Pause between phases for manual inspection.
 *   --cleanup      Run cleanup script after a successful live run.
 *   --timeout-sec  Override the Stellar transaction timeout in seconds.
 */
import "dotenv/config";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { maskSecret } from "marc-stellar-sdk";

const STEP_MODE = process.argv.includes("--step");
const CLEANUP_MODE = process.argv.includes("--cleanup");
/** #586 — offline simulation mode: no testnet RPC is called. */
const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Resolve the Stellar transaction timeout (in seconds) from the
 * --timeout-sec <N> CLI argument or the TX_TIMEOUT_SECS environment
 * variable, defaulting to 60s for better reliability on testnet.
 */
function resolveTxTimeoutSecs(): number {
  const flagIdx = process.argv.indexOf("--timeout-sec");
  const raw =
    flagIdx !== -1 && process.argv[flagIdx + 1] !== undefined
      ? process.argv[flagIdx + 1]
      : process.env.TX_TIMEOUT_SECS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
}

const TX_TIMEOUT_SECS = resolveTxTimeoutSecs();

function pause(label: string): Promise<void> {
  if (!STEP_MODE) return Promise.resolve();
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n[step] ${label} — press Enter to continue...`, () => {
      rl.close();
      resolve();
    });
  });
}

const X402_FAIL_PATTERNS = ["Payment verification failed", "x402.*fail", "settle.*fail"];

function log(msg: string) {
  console.log(`[lifecycle] ${new Date().toISOString()} ${msg}`);
}

function waitForOutput(proc: ChildProcess, pattern: string, timeoutMs = 90_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for "${pattern}"`)),
      timeoutMs,
    );
    const onStdout = (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(maskSecret(text));
      if (text.includes(pattern)) finish();
    };
    const onStderr = (chunk: Buffer) => {
      const text = chunk.toString();
      process.stderr.write(maskSecret(text));
      if (text.includes(pattern)) finish();
    };
    const finish = () => {
      clearTimeout(timer);
      proc.stdout?.off("data", onStdout);
      proc.stderr?.off("data", onStderr);
      resolve();
    };
    proc.stdout?.on("data", onStdout);
    proc.stderr?.on("data", onStderr);
  });
}

async function waitForHttpReady(url: string, timeoutMs = 30_000, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(`Timed out waiting for ${url} to become ready`);
}

/**
 * Run the cleanup script to return demo tokens to treasury and deregister
 * agent identities, so repeated runs start with clean wallets.
 *
 * #585 — Use fileURLToPath() so the path is correct on Windows (no leading
 * slash on drive letters like /C:/...).
 */
async function runCleanup(): Promise<void> {
  // fileURLToPath converts file:///C:/... → C:\... on Windows and
  // file:///home/... → /home/... on POSIX — both safe to pass to execFile.
  const scriptPath = fileURLToPath(new URL("../../scripts/cleanup-demo.sh", import.meta.url));
  log("running cleanup — returning tokens to treasury...");
  return new Promise((resolve, reject) => {
    execFile("bash", [scriptPath], { cwd: import.meta.dirname }, (err, stdout, stderr) => {
      if (stdout) process.stdout.write(maskSecret(stdout));
      if (stderr) process.stderr.write(maskSecret(stderr));
      if (err) {
        log(`cleanup failed: ${maskSecret(err.message)}`);
        reject(err);
      } else {
        log("cleanup complete");
        resolve();
      }
    });
  });
}

/**
 * #586 — Dry-run mode.
 *
 * Simulates the complete agent lifecycle in-process without any network I/O:
 *   - Mocks seller startup and HTTP readiness
 *   - Mocks buyer flow and payment verification
 *   - Logs each phase so the orchestration logic is exercised
 *   - Exits 0, satisfying CI pipelines that have no testnet access
 */
async function runDryRun(): Promise<void> {
  log("DRY-RUN mode — no testnet RPC will be called");

  await pause("about to start seller-agent (simulated)");
  log("[dry-run] starting seller-agent… (simulated)");
  await new Promise((r) => setTimeout(r, 200));
  log("[dry-run] seller-agent listening on :4402 (simulated)");
  log("[dry-run] seller HTTP ready (simulated)");

  await pause("seller is ready — about to run buyer-agent (simulated)");
  log("[dry-run] running buyer-agent… (simulated)");
  await new Promise((r) => setTimeout(r, 200));
  log("[dry-run] buyer: registering agent identity… (simulated)");
  await new Promise((r) => setTimeout(r, 100));
  log("[dry-run] buyer: creating escrow job #DRY-001… (simulated)");
  await new Promise((r) => setTimeout(r, 100));
  log("[dry-run] buyer: sending x402 payment… (simulated)");
  await new Promise((r) => setTimeout(r, 100));
  log("[dry-run] buyer: payment verified ✓ (simulated)");
  await new Promise((r) => setTimeout(r, 100));
  log("[dry-run] buyer: deliverable received ✓ (simulated)");
  await new Promise((r) => setTimeout(r, 100));
  log("[dry-run] buyer: evaluator approving job… (simulated)");
  await new Promise((r) => setTimeout(r, 100));
  log("[dry-run] buyer: funds released to seller ✓ (simulated)");

  await pause("buyer finished — about to shut down seller (simulated)");
  log("[dry-run] shutting down seller-agent (simulated)");

  log("SUCCESS — dry-run lifecycle completed (exit 0)");
  process.exit(0);
}

async function main() {
  if (DRY_RUN) {
    await runDryRun();
    return; // runDryRun calls process.exit(0), but satisfy TS control flow
  }

  if (STEP_MODE) log("--step mode enabled: will pause between phases");
  if (CLEANUP_MODE) log("--cleanup enabled: will return tokens after success");
  log(`transaction timeout: ${TX_TIMEOUT_SECS}s`);

  await pause("about to start seller-agent");
  log("starting seller-agent...");
  const seller = spawn("npx", ["tsx", "seller-agent.ts"], {
    cwd: import.meta.dirname,
    env: { ...process.env, TX_TIMEOUT_SECS: String(TX_TIMEOUT_SECS) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  seller.on("exit", (code) => {
    if (code !== null && code !== 0) {
      log(`seller exited with code ${code}`);
      process.exit(1);
    }
  });

  // Wait for seller to be ready.
  await waitForOutput(seller, "listening on");
  log("seller is up");

  // Confirm the HTTP server has actually finished binding before proceeding.
  const sellerPort = Number(process.env.SELLER_PORT ?? 4402);
  await waitForHttpReady(`http://localhost:${sellerPort}/api/work`);

  await pause("seller is ready — about to run buyer-agent");
  log("running buyer-agent...");
  const buyer = spawn("npx", ["tsx", "buyer-agent.ts"], {
    cwd: import.meta.dirname,
    env: { ...process.env, TX_TIMEOUT_SECS: String(TX_TIMEOUT_SECS) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let x402Failed = false;

  buyer.stdout?.on("data", (c: Buffer) => {
    const text = c.toString();
    process.stdout.write(maskSecret(text));
    if (!x402Failed && X402_FAIL_PATTERNS.some((p) => text.match(p))) {
      x402Failed = true;
    }
  });

  buyer.stderr?.on("data", (c: Buffer) => {
    const text = c.toString();
    process.stderr.write(maskSecret(text));
    if (!x402Failed && X402_FAIL_PATTERNS.some((p) => text.match(p))) {
      x402Failed = true;
    }
  });

  const buyerExit = await new Promise<number>((resolve) => {
    buyer.on("exit", (code) => resolve(code ?? 1));
  });

  await pause("buyer finished — about to shut down seller");
  log("buyer finished, shutting down seller...");
  seller.kill("SIGTERM");

  if (buyerExit !== 0) {
    log(`FAIL — buyer exited with code ${buyerExit}`);
    process.exit(1);
  }

  if (x402Failed) {
    log(`FAIL — x402 micropayment failed (check facilitator config)`);
    process.exit(1);
  }

  log("SUCCESS — full lifecycle completed");

  if (CLEANUP_MODE) {
    try {
      await runCleanup();
    } catch {
      log("WARN — cleanup failed, tokens remain on testnet wallets");
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(maskSecret(String(err?.stack ?? err)));
  process.exit(1);
});


