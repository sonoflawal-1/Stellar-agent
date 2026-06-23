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
import { spawn, type ChildProcess } from "node:child_process";

const X402_FAIL_PATTERNS = [
  "Payment verification failed",
  "x402.*fail",
  "settle.*fail",
];

function log(msg: string) {
  console.log(`[lifecycle] ${new Date().toISOString()} ${msg}`);
}

function waitForOutput(proc: ChildProcess, pattern: string, timeoutMs = 90_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${pattern}"`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(text);
      if (text.includes(pattern)) {
        clearTimeout(timer);
        proc.stdout?.off("data", onData);
        resolve();
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", (c: Buffer) => process.stderr.write(c));
  });
}

async function main() {
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

  // Give server a moment to fully bind.
  await new Promise((r) => setTimeout(r, 2000));

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
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
