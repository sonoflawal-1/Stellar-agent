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
 */
import "dotenv/config";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";

const STEP_MODE = process.argv.includes("--step");
const CLEANUP_MODE = process.argv.includes("--cleanup");

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
      process.stdout.write(text);
      if (text.includes(pattern)) finish();
    };
    const onStderr = (chunk: Buffer) => {
      const text = chunk.toString();
      process.stderr.write(text);
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
 */
async function runCleanup(): Promise<void> {
  const scriptPath = new URL("../../scripts/cleanup-demo.sh", import.meta.url).pathname;
  log("running cleanup — returning tokens to treasury...");
  return new Promise((resolve, reject) => {
    execFile("bash", [scriptPath], { cwd: import.meta.dirname }, (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (err) {
        log(`cleanup failed: ${err.message}`);
        reject(err);
      } else {
        log("cleanup complete");
        resolve();
      }
    });
  });
}

async function main() {
  if (STEP_MODE) log("--step mode enabled: will pause between phases");
  if (CLEANUP_MODE) log("--cleanup enabled: will return tokens after success");

  await pause("about to start seller-agent");
  log("starting seller-agent...");
  const seller = spawn("npx", ["tsx", "seller-agent.ts"], {
    cwd: import.meta.dirname,
    env: { ...process.env },
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
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let x402Failed = false;

  buyer.stdout?.on("data", (c: Buffer) => {
    const text = c.toString();
    process.stdout.write(text);
    if (!x402Failed && X402_FAIL_PATTERNS.some((p) => text.match(p))) {
      x402Failed = true;
    }
  });

  buyer.stderr?.on("data", (c: Buffer) => {
    const text = c.toString();
    process.stderr.write(text);
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
  console.error(err);
  process.exit(1);
});
