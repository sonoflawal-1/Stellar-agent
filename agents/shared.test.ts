import assert from "node:assert/strict";
import test from "node:test";
import {
  makeSellerResponse,
  retryWithBackoff,
  withRetry,
  isRetryableError,
  computeBackoffDelay,
  sendToDeadLetterQueue,
  validateEnv,
  validatePrompt,
  MAX_PROMPT_LENGTH,
  isMockLlm,
  MOCK_DELIVERABLES,
  AgentConfigSchema,
  validateAgentConfig,
  autoRegister,
  registerGracefulShutdown,
  createBudgetPolicy,
  BudgetExceededError,
  TaskQueue,
  submitDeliverable,
  computeDeliverableHash,
  extractJsonObject,
  parseLlmJson,
  parseNamerResponse,
  parseResearcherResponse,
} from "./shared.js";

test("makeSellerResponse - returns standard response format with success true and execution_time_ms >= 0", () => {
  const payload = { result: "test-data", count: 42 };
  const response = makeSellerResponse(payload);

  assert.equal(response.success, true);
  assert.deepEqual(response.data, payload);
  assert.equal(typeof response.execution_time_ms, "number");
  assert.ok(response.execution_time_ms >= 0);
});

test("makeSellerResponse - correctly computes execution_time_ms with given startTime", () => {
  const startTime = Date.now() - 150;
  const response = makeSellerResponse("hello", startTime);

  assert.equal(response.success, true);
  assert.equal(response.data, "hello");
  assert.ok(response.execution_time_ms >= 140);
});

test("validateEnv - passes when all required environment variables are set", () => {
  const originalEnv = { ...process.env };
  try {
    process.env.REGISTRY_URL = "http://localhost:4500";
    process.env.GROQ_API_KEY = "gsk_test123";

    // Should not throw or exit
    assert.doesNotThrow(() => {
      validateEnv(["REGISTRY_URL", "GROQ_API_KEY"]);
    });
  } finally {
    process.env = originalEnv;
  }
});

test("validateEnv - detects missing environment variables and exits with code 1", () => {
  const originalEnv = { ...process.env };
  const originalExit = process.exit;
  const originalError = console.error;

  let exitCalled = false;
  let exitCode: number | undefined;

  // @ts-ignore
  process.exit = (code?: number) => {
    exitCalled = true;
    exitCode = code;
    throw new Error(`process.exit called with ${code}`);
  };
  console.error = () => {};

  try {
    delete process.env.NON_EXISTENT_VAR_12345;
    assert.throws(
      () => validateEnv(["NON_EXISTENT_VAR_12345"]),
      /process.exit called with 1/,
    );
    assert.equal(exitCalled, true);
    assert.equal(exitCode, 1);
  } finally {
    process.env = originalEnv;
    process.exit = originalExit;
    console.error = originalError;
  }
});

test("validateEnv - treats empty or whitespace-only variables as missing", () => {
  const originalEnv = { ...process.env };
  const originalExit = process.exit;
  const originalError = console.error;

  let exitCalled = false;

  // @ts-ignore
  process.exit = (code?: number) => {
    exitCalled = true;
    throw new Error(`process.exit called with ${code}`);
  };
  console.error = () => {};

  try {
    process.env.EMPTY_TEST_VAR = "   ";
    assert.throws(
      () => validateEnv(["EMPTY_TEST_VAR"]),
      /process.exit called with 1/,
    );
    assert.equal(exitCalled, true);
  } finally {
    process.env = originalEnv;
    process.exit = originalExit;
    console.error = originalError;
  }
});

test("validateEnv - handles aliases correctly for PORT (PORT or SELLER_PORT)", () => {
  const originalEnv = { ...process.env };
  const originalExit = process.exit;
  const originalError = console.error;

  // @ts-ignore
  process.exit = (code?: number) => {
    throw new Error(`process.exit called with ${code}`);
  };
  console.error = () => {};

  try {
    // Case 1: Only PORT is set
    delete process.env.SELLER_PORT;
    process.env.PORT = "4501";
    assert.doesNotThrow(() => validateEnv(["PORT"]));

    // Case 2: Only SELLER_PORT is set
    delete process.env.PORT;
    process.env.SELLER_PORT = "4502";
    assert.doesNotThrow(() => validateEnv(["PORT"]));

    // Case 3: Both set
    process.env.PORT = "4501";
    process.env.SELLER_PORT = "4502";
    assert.doesNotThrow(() => validateEnv(["PORT"]));

    // Case 4: Neither set -> fails
    delete process.env.PORT;
    delete process.env.SELLER_PORT;
    assert.throws(() => validateEnv(["PORT"]), /process.exit called with 1/);
  } finally {
    process.env = originalEnv;
    process.exit = originalExit;
    console.error = originalError;
  }
});

test("validateEnv - handles aliases correctly for SECRET_KEY (SECRET_KEY or SELLER_SECRET)", () => {
  const originalEnv = { ...process.env };
  const originalExit = process.exit;
  const originalError = console.error;

  // @ts-ignore
  process.exit = (code?: number) => {
    throw new Error(`process.exit called with ${code}`);
  };
  console.error = () => {};

  try {
    // Case 1: Only SECRET_KEY is set
    delete process.env.SELLER_SECRET;
    process.env.SECRET_KEY = "S_TEST_SECRET_1";
    assert.doesNotThrow(() => validateEnv(["SECRET_KEY"]));

    // Case 2: Only SELLER_SECRET is set
    delete process.env.SECRET_KEY;
    process.env.SELLER_SECRET = "S_TEST_SECRET_2";
    assert.doesNotThrow(() => validateEnv(["SECRET_KEY"]));

    // Case 3: Both set
    process.env.SECRET_KEY = "S_TEST_SECRET_1";
    process.env.SELLER_SECRET = "S_TEST_SECRET_2";
    assert.doesNotThrow(() => validateEnv(["SECRET_KEY"]));

    // Case 4: Neither set -> fails
    delete process.env.SECRET_KEY;
    delete process.env.SELLER_SECRET;
    assert.throws(() => validateEnv(["SECRET_KEY"]), /process.exit called with 1/);
  } finally {
    process.env = originalEnv;
    process.exit = originalExit;
    console.error = originalError;
  }
});

test("retryWithBackoff - resolves immediately on first try if successful", async () => {
  let attempts = 0;
  const result = await retryWithBackoff(async () => {
    attempts++;
    return "ok";
  }, { maxAttempts: 3, baseDelayMs: 1 });

  assert.equal(result, "ok");
  assert.equal(attempts, 1);
});

test("retryWithBackoff - retries on error and successfully resolves after transient failure", async () => {
  let attempts = 0;
  const originalError = console.error;
  console.error = () => {}; // suppress retry logs during test

  try {
    const result = await retryWithBackoff(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error(`transient error attempt ${attempts}`);
      }
      return "recovered";
    }, { maxAttempts: 5, baseDelayMs: 1 });

    assert.equal(result, "recovered");
    assert.equal(attempts, 3);
  } finally {
    console.error = originalError;
  }
});

test("retryWithBackoff - throws error after exhausting all maxAttempts", async () => {
  let attempts = 0;
  const originalError = console.error;
  console.error = () => {}; // suppress retry logs during test

  try {
    await assert.rejects(
      async () => {
        await retryWithBackoff(async () => {
          attempts++;
          throw new Error("persistent failure");
        }, { maxAttempts: 3, baseDelayMs: 1, label: "test" });
      },
      /persistent failure/,
    );

    assert.equal(attempts, 3);
  } finally {
    console.error = originalError;
  }
});

test("withRetry - resolves immediately on first try if successful", async () => {
  let attempts = 0;
  const result = await withRetry(async () => {
    attempts++;
    return "ok";
  }, { maxRetries: 3, initialDelayMs: 1, factor: 2 });

  assert.equal(result, "ok");
  assert.equal(attempts, 1);
});

test("withRetry - retries retryable errors and recovers after transient failure", async () => {
  let attempts = 0;
  const originalError = console.error;
  console.error = () => {};

  try {
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 3) {
        const err = new Error("socket hang up") as Error & { code?: string };
        err.code = "ECONNRESET";
        throw err;
      }
      return "recovered";
    }, { maxRetries: 5, initialDelayMs: 1, factor: 2 });

    assert.equal(result, "recovered");
    assert.equal(attempts, 3);
  } finally {
    console.error = originalError;
  }
});

test("withRetry - exhausts maxRetries and rethrows the last error", async () => {
  let attempts = 0;
  const originalError = console.error;
  console.error = () => {};

  try {
    await assert.rejects(
      async () => {
        await withRetry(async () => {
          attempts++;
          const err = new Error("upstream 503") as Error & { status?: number };
          err.status = 503;
          throw err;
        }, { maxRetries: 4, initialDelayMs: 1, factor: 2, label: "test" });
      },
      /upstream 503/,
    );

    // 1 initial attempt + 4 retries
    assert.equal(attempts, 5);
  } finally {
    console.error = originalError;
  }
});

test("withRetry - does not retry non-retryable errors", async () => {
  let attempts = 0;
  const originalError = console.error;
  console.error = () => {};

  try {
    await assert.rejects(
      async () => {
        await withRetry(async () => {
          attempts++;
          throw new Error("validation failed: bad prompt");
        }, { maxRetries: 5, initialDelayMs: 1, factor: 2 });
      },
      /validation failed/,
    );

    assert.equal(attempts, 1);
  } finally {
    console.error = originalError;
  }
});

test("isRetryableError - classifies network and rate-limit errors as retryable", () => {
  const econnreset = new Error("reset") as Error & { code?: string };
  econnreset.code = "ECONNRESET";
  assert.equal(isRetryableError(econnreset), true);

  const etimedout = new Error("timeout") as Error & { code?: string };
  etimedout.code = "ETIMEDOUT";
  assert.equal(isRetryableError(etimedout), true);

  const rateLimited = new Error("too many requests") as Error & { status?: number };
  rateLimited.status = 429;
  assert.equal(isRetryableError(rateLimited), true);

  const unavailable = new Error("service unavailable") as Error & { status?: number };
  unavailable.status = 503;
  assert.equal(isRetryableError(unavailable), true);

  const badRequest = new Error("bad request") as Error & { status?: number };
  badRequest.status = 400;
  assert.equal(isRetryableError(badRequest), false);

  assert.equal(isRetryableError(new Error("plain failure")), false);
});

test("computeBackoffDelay - grows exponentially and stays within jitter bounds", () => {
  const opts = { initialDelayMs: 1000, factor: 2, jitter: 0.2 };

  // attempt 0 -> base 1000, attempt 1 -> 2000, attempt 2 -> 4000
  const d0 = computeBackoffDelay(0, opts);
  const d1 = computeBackoffDelay(1, opts);
  const d2 = computeBackoffDelay(2, opts);

  assert.ok(d0 >= 800 && d0 <= 1200, `d0=${d0} out of jitter bounds`);
  assert.ok(d1 >= 1600 && d1 <= 2400, `d1=${d1} out of jitter bounds`);
  assert.ok(d2 >= 3200 && d2 <= 4800, `d2=${d2} out of jitter bounds`);

  // Exponential growth: midpoints should roughly double.
  assert.ok(d1 > d0);
  assert.ok(d2 > d1);
});

test("computeBackoffDelay - jitter produces varied delays across calls", () => {
  const opts = { initialDelayMs: 1000, factor: 2, jitter: 0.5 };
  const samples = new Set<number>();
  for (let i = 0; i < 20; i++) {
    samples.add(computeBackoffDelay(0, opts));
  }
  // With jitter, we expect more than one distinct value across 20 samples.
  assert.ok(samples.size > 1);
});

test("computeBackoffDelay - respects maxDelayMs cap", () => {
  const opts = { initialDelayMs: 1000, factor: 2, jitter: 0, maxDelayMs: 3000 };
  const d5 = computeBackoffDelay(5, opts);
  assert.ok(d5 <= 3000, `d5=${d5} exceeded maxDelayMs`);
});

test("sendToDeadLetterQueue - persists job payload, error diagnostics and context", async () => {
  const inserted: Array<Record<string, unknown>> = [];
  const store = {
    async insert(row: Record<string, unknown>) {
      inserted.push(row);
      return { id: inserted.length };
    },
  };

  const error = new Error("LLM API timeout");
  error.stack = "Error: LLM API timeout\n    at handler (agents/seller-x/src/index.ts:42:7)";

  const jobPayload = { jobId: "job-123", deliverable: "landing-page" };
  const context = { agent: "seller-copywriter", attempt: 5, escrowId: "esc-9" };

  const result = await sendToDeadLetterQueue(store, {
    jobPayload,
    error,
    context,
  });

  assert.equal(inserted.length, 1);
  const row = inserted[0];
  assert.deepEqual(row.job_payload, jobPayload);
  assert.equal(row.error_message, "LLM API timeout");
  assert.ok(typeof row.error_stack === "string");
  assert.ok((row.error_stack as string).includes("agents/seller-x/src/index.ts:42:7"));
  assert.deepEqual(row.context, context);
  assert.ok(row.created_at instanceof Date || typeof row.created_at === "string");
  assert.ok(result && typeof result.id === "number");
});

test("withRetry - routes exhausted job to dead-letter queue with diagnostics", async () => {
  const inserted: Array<Record<string, unknown>> = [];
  const store = {
    async insert(row: Record<string, unknown>) {
      inserted.push(row);
      return { id: inserted.length };
    },
  };

  const originalError = console.error;
  console.error = () => {};

  let attempts = 0;
  const jobPayload = { jobId: "job-dlq-1", deliverable: "seo-audit" };
  const context = { agent: "seller-seo", escrowId: "esc-1" };

  try {
    await assert.rejects(
      async () => {
        await withRetry(async () => {
          attempts++;
          const err = new Error("persistent 503") as Error & { status?: number };
          err.status = 503;
          throw err;
        }, {
          maxRetries: 2,
          initialDelayMs: 1,
          factor: 2,
          deadLetterStore: store,
          jobPayload,
          context,
        });
      },
      /persistent 503/,
    );

    assert.equal(attempts, 3);
    assert.equal(inserted.length, 1);
    const row = inserted[0];
    assert.deepEqual(row.job_payload, jobPayload);
    assert.equal(row.error_message, "persistent 503");
    assert.ok(typeof row.error_stack === "string");
    assert.deepEqual(row.context, context);
  } finally {
    console.error = originalError;
  }
});

test("withRetry - does not write to DLQ when job eventually succeeds", async () => {
  const inserted: Array<Record<string, unknown>> = [];
  const store = {
    async insert(row: Record<string, unknown>) {
      inserted.push(row);
      return { id: inserted.length };
    },
  };

  const originalError = console.error;
  console.error = () => {};

  let attempts = 0;
  try {
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 2) {
        const err = new Error("transient 429") as Error & { status?: number };
        err.status = 429;
        throw err;
      }
      return "done";
    }, {
      maxRetries: 3,
      initialDelayMs: 1,
      factor: 2,
      deadLetterStore: store,
      jobPayload: { jobId: "job-ok" },
      context: { agent: "seller-x" },
    });

    assert.equal(result, "done");
    assert.equal(inserted.length, 0);
  } finally {
    console.error = originalError;
  }
});

test("validatePrompt - accepts valid non-empty string under 8000 characters", () => {
  const result = validatePrompt("Build a modern landing page for an AI product");
  assert.equal(result.valid, true);
  assert.equal(result.error, undefined);
});

test("validatePrompt - accepts prompt at exact boundary of 8000 characters", () => {
  const boundaryPrompt = "a".repeat(MAX_PROMPT_LENGTH);
  assert.equal(boundaryPrompt.length, 8000);
  const result = validatePrompt(boundaryPrompt);
  assert.equal(result.valid, true);
  assert.equal(result.error, undefined);
});

test("validatePrompt - rejects prompt exceeding 8000 characters boundary by 1 char", () => {
  const oversizedPrompt = "a".repeat(8001);
  const result = validatePrompt(oversizedPrompt);
  assert.equal(result.valid, false);
  assert.equal(
    result.error,
    "Prompt exceeds maximum allowed length of 8000 characters",
  );
});

test("validatePrompt - rejects empty string", () => {
  const result = validatePrompt("");
  assert.equal(result.valid, false);
  assert.equal(result.error, "Prompt must be a non-empty string");
});

test("validatePrompt - rejects whitespace-only string", () => {
  const result = validatePrompt("    \n\t  ");
  assert.equal(result.valid, false);
  assert.equal(result.error, "Prompt must be a non-empty string");
});

const VALID_CONFIG = {
  name: "CopywriterAgent",
  version: "1.2.0",
  capabilities: ["copywriting", "seo", "email-marketing"],
  pricing: { model: "per-job", price: 5000000, currency: "USDC" },
  endpoint: "http://localhost:3001/api",
  health: "/health",
};

test("AgentConfigSchema - accepts a valid agent.config.json payload", () => {
  const parsed = AgentConfigSchema.parse(VALID_CONFIG);
  assert.equal(parsed.name, "CopywriterAgent");
  assert.equal(parsed.version, "1.2.0");
  assert.deepEqual(parsed.capabilities, ["copywriting", "seo", "email-marketing"]);
  assert.equal(parsed.pricing.price, 5000000);
  assert.equal(parsed.pricing.currency, "USDC");
});

test("AgentConfigSchema - rejects config missing required fields", () => {
  const { name, ...withoutName } = VALID_CONFIG;
  assert.equal(AgentConfigSchema.safeParse(withoutName).success, false);
});

test("AgentConfigSchema - rejects invalid pricing model", () => {
  const invalid = { ...VALID_CONFIG, pricing: { ...VALID_CONFIG.pricing, model: "per-hour" } };
  assert.equal(AgentConfigSchema.safeParse(invalid).success, false);
});

test("validateAgentConfig - returns parsed config for valid input", () => {
  const result = validateAgentConfig(VALID_CONFIG);
  assert.equal(result.valid, true);
  assert.equal(result.config?.name, "CopywriterAgent");
  assert.equal(result.error, undefined);
});

test("validateAgentConfig - returns error for invalid input", () => {
  const result = validateAgentConfig({ name: "" });
  assert.equal(result.valid, false);
  assert.equal(typeof result.error, "string");
  assert.equal(result.config, undefined);
});

test("autoRegister - dry-run previews registration without submitting a transaction", async () => {
  let registerCalls = 0;
  const identityClient = {
    isRegistered: async () => false,
    register: async () => {
      registerCalls++;
      return { id: 42 };
    },
  };

  const result = await autoRegister(VALID_CONFIG, { publicKey: "GTEST" }, {
    identityClient,
    dryRun: true,
    devMode: true,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.registered, false);
  assert.equal(result.skipped, false);
  assert.equal(registerCalls, 0);
  assert.ok(result.metadataUri.startsWith("local://"));
});

test("autoRegister - registers when not already registered", async () => {
  let registerCalls = 0;
  const identityClient = {
    isRegistered: async () => false,
    register: async () => {
      registerCalls++;
      return { id: 42 };
    },
  };

  const result = await autoRegister(VALID_CONFIG, { publicKey: "GTEST" }, {
    identityClient,
    devMode: true,
  });

  assert.equal(result.registered, true);
  assert.equal(result.skipped, false);
  assert.equal(result.agentId, 42);
  assert.equal(registerCalls, 1);
});

test("autoRegister - is idempotent and skips when already registered", async () => {
  let registerCalls = 0;
  const identityClient = {
    isRegistered: async () => true,
    register: async () => {
      registerCalls++;
      return { id: 42 };
    },
  };

  const result = await autoRegister(VALID_CONFIG, { publicKey: "GTEST" }, {
    identityClient,
    devMode: true,
  });

  assert.equal(result.skipped, true);
  assert.equal(result.registered, false);
  assert.equal(registerCalls, 0);
});

test("autoRegister - throws on invalid config", async () => {
  await assert.rejects(
    async () => {
      await autoRegister({ name: "" }, { publicKey: "GTEST" }, { devMode: true });
    },
    /Invalid agent config/,
  );
});

function makeFakeServer() {
  let closeCalls = 0;
  const server = {
    close(cb?: (err?: Error) => void) {
      closeCalls++;
      if (cb) cb();
    },
  };
  return { server, getCloseCalls: () => closeCalls };
}

function makeFakeTracker() {
  let active = 0;
  let waitCalls = 0;
  return {
    tracker: {
      get activeCount() {
        return active;
      },
      async waitForIdle() {
        waitCalls++;
        while (active > 0) {
          await new Promise((r) => setTimeout(r, 1));
        }
      },
    },
    setActive: (n: number) => {
      active = n;
    },
    getWaitCalls: () => waitCalls,
  };
}

function makeFakeDb() {
  let closeCalls = 0;
  return {
    db: {
      close() {
        closeCalls++;
      },
    },
    getCloseCalls: () => closeCalls,
  };
}

test("registerGracefulShutdown - SIGTERM waits for in-flight task, closes server and db, exits 0", async () => {
  const originalExit = process.exit;
  const originalError = console.error;
  const originalLog = console.log;

  let exitCode: number | undefined;
  // @ts-ignore
  process.exit = (code?: number) => {
    exitCode = code;
    throw new Error(`process.exit called with ${code}`);
  };
  console.error = () => {};
  console.log = () => {};

  const { server, getCloseCalls } = makeFakeServer();
  const { tracker, setActive, getWaitCalls } = makeFakeTracker();
  const { db, getCloseCalls: getDbCloseCalls } = makeFakeDb();

  let taskCompleted = false;
  setActive(1);
  const task = (async () => {
    await new Promise((r) => setTimeout(r, 20));
    taskCompleted = true;
    setActive(0);
  })();

  const unregister = registerGracefulShutdown(server, tracker, db, {
    timeoutMs: 5000,
  });

  try {
    process.emit("SIGTERM");
    // Allow the async shutdown handler to run to completion.
    await new Promise((r) => setTimeout(r, 100));
    await task;

    assert.equal(taskCompleted, true);
    assert.ok(getWaitCalls() >= 1);
    assert.equal(getCloseCalls(), 1);
    assert.equal(getDbCloseCalls(), 1);
    assert.equal(exitCode, 0);
  } finally {
    unregister();
    process.exit = originalExit;
    console.error = originalError;
    console.log = originalLog;
  }
});

test("registerGracefulShutdown - SIGINT triggers graceful shutdown and exits 0", async () => {
  const originalExit = process.exit;
  const originalError = console.error;
  const originalLog = console.log;

  let exitCode: number | undefined;
  // @ts-ignore
  process.exit = (code?: number) => {
    exitCode = code;
    throw new Error(`process.exit called with ${code}`);
  };
  console.error = () => {};
  console.log = () => {};

  const { server, getCloseCalls } = makeFakeServer();
  const { tracker } = makeFakeTracker();
  const { db, getCloseCalls: getDbCloseCalls } = makeFakeDb();

  const unregister = registerGracefulShutdown(server, tracker, db, {
    timeoutMs: 5000,
  });

  try {
    process.emit("SIGINT");
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(getCloseCalls(), 1);
    assert.equal(getDbCloseCalls(), 1);
    assert.equal(exitCode, 0);
  } finally {
    unregister();
    process.exit = originalExit;
    console.error = originalError;
    console.log = originalLog;
  }
});

test("registerGracefulShutdown - exits non-zero when in-flight task exceeds timeout", async () => {
  const originalExit = process.exit;
  const originalError = console.error;
  const originalLog = console.log;

  let exitCode: number | undefined;
  // @ts-ignore
  process.exit = (code?: number) => {
    exitCode = code;
    throw new Error(`process.exit called with ${code}`);
  };
  console.error = () => {};
  console.log = () => {};

  const { server, getCloseCalls } = makeFakeServer();
  const { tracker, setActive } = makeFakeTracker();
  const { db, getCloseCalls: getDbCloseCalls } = makeFakeDb();

  // Simulate a task that never finishes within the timeout window.
  setActive(1);

  const unregister = registerGracefulShutdown(server, tracker, db, {
    timeoutMs: 50,
  });

  try {
    process.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(getCloseCalls(), 1);
    assert.equal(getDbCloseCalls(), 1);
    assert.notEqual(exitCode, 0);
    assert.equal(typeof exitCode, "number");
  } finally {
    setActive(0);
    unregister();
    process.exit = originalExit;
    console.error = originalError;
    console.log = originalLog;
  }
});

test("registerGracefulShutdown - unregister removes signal listeners", async () => {
  const originalError = console.error;
  const originalLog = console.log;
  console.error = () => {};
  console.log = () => {};

  const { server } = makeFakeServer();
  const { tracker } = makeFakeTracker();
  const { db } = makeFakeDb();

  const before = process.listenerCount("SIGTERM");
  const unregister = registerGracefulShutdown(server, tracker, db, {
    timeoutMs: 5000,
  });
  assert.equal(process.listenerCount("SIGTERM"), before + 1);

  try {
    unregister();
    assert.equal(process.listenerCount("SIGTERM"), before);
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
});

function makeMemoryQueueStore() {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    async insert(row: Record<string, unknown>) {
      rows.set(row.id as string, { ...row });
      return { id: row.id };
    },
    async update(id: string, patch: Record<string, unknown>) {
      const existing = rows.get(id);
      if (existing) rows.set(id, { ...existing, ...patch });
    },
    async remove(id: string) {
      rows.delete(id);
    },
    async list() {
      return Array.from(rows.values());
    },
  };
}

test("TaskQueue - persists pending tasks and resumes them after a simulated restart", async () => {
  const store = makeMemoryQueueStore();
  const processed: string[] = [];

  const queue = new TaskQueue<{ jobId: string }>({
    store,
    concurrency: 1,
    maxRetries: 3,
    handler: async (task) => {
      processed.push(task.jobId);
    },
  });

  await queue.enqueue({ jobId: "job-a" });
  await queue.enqueue({ jobId: "job-b" });
  await queue.enqueue({ jobId: "job-c" });

  // Simulate a crash before any task is processed: a new queue instance
  // backed by the same store must pick up the pending tasks.
  const resumed: string[] = [];
  const queueAfterRestart = new TaskQueue<{ jobId: string }>({
    store,
    concurrency: 1,
    maxRetries: 3,
    handler: async (task) => {
      resumed.push(task.jobId);
    },
  });

  await queueAfterRestart.resume();
  await queueAfterRestart.drain();

  assert.deepEqual(resumed.sort(), ["job-a", "job-b", "job-c"]);
  assert.equal(store.rows.size, 0);
});

test("TaskQueue - enforces the configured concurrency limit", async () => {
  const store = makeMemoryQueueStore();
  let active = 0;
  let maxActive = 0;

  const queue = new TaskQueue<{ jobId: string }>({
    store,
    concurrency: 2,
    maxRetries: 1,
    handler: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    },
  });

  for (let i = 0; i < 6; i++) {
    await queue.enqueue({ jobId: `job-${i}` });
  }

  await queue.drain();

  assert.equal(maxActive, 2);
  assert.equal(active, 0);
});

test("TaskQueue - retries failed tasks up to maxRetries then marks them failed", async () => {
  const store = makeMemoryQueueStore();
  let attempts = 0;

  const queue = new TaskQueue<{ jobId: string }>({
    store,
    concurrency: 1,
    maxRetries: 2,
    handler: async () => {
      attempts++;
      throw new Error("boom");
    },
  });

  await queue.enqueue({ jobId: "job-fail" });
  await queue.drain();

  // 1 initial attempt + 2 retries
  assert.equal(attempts, 3);
  const failed = await queue.listFailed();
  assert.equal(failed.length, 1);
  assert.equal(failed[0].attempts, 3);
});

test("TaskQueue - successful tasks are removed from the store", async () => {
  const store = makeMemoryQueueStore();
  const queue = new TaskQueue<{ jobId: string }>({
    store,
    concurrency: 1,
    maxRetries: 1,
    handler: async () => {},
  });

  await queue.enqueue({ jobId: "job-ok" });
  await queue.drain();

  assert.equal(store.rows.size, 0);
});

test("computeDeliverableHash - same bytes produce the same hash", () => {
  const bytes = new TextEncoder().encode("hello deliverable");
  const h1 = computeDeliverableHash(bytes);
  const h2 = computeDeliverableHash(bytes);
  assert.equal(h1, h2);
  assert.equal(typeof h1, "string");
  assert.ok(h1.length > 0);
});

test("computeDeliverableHash - different bytes produce different hashes", () => {
  const a = computeDeliverableHash(new TextEncoder().encode("alpha"));
  const b = computeDeliverableHash(new TextEncoder().encode("beta"));
  assert.notEqual(a, b);
});

test("computeDeliverableHash - matches the SDK client-side helper", async () => {
  const { computeDeliverableHash: sdkHash } = await import(
    "../sdk/src/deliverable.js"
  );
  const bytes = new TextEncoder().encode("reproducible deliverable content");
  assert.equal(computeDeliverableHash(bytes), sdkHash(bytes));
});

test("submitDeliverable - computes hash, stores content and calls the contract", async () => {
  const stored: Array<{ key: string; bytes: Uint8Array }> = [];
  const storage = {
    async put(key: string, bytes: Uint8Array) {
      stored.push({ key, bytes });
      return { key };
    },
  };

  let submitted: { jobId: string; hash: string } | undefined;
  const contract = {
    async submit(jobId: string, hash: string) {
      submitted = { jobId, hash };
      return { txHash: "tx-1" };
    },
  };

  const bytes = new TextEncoder().encode("final deliverable");
  const result = await submitDeliverable(
    { jobId: "job-42" },
    bytes,
    { storage, contract },
  );

  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].bytes, bytes);
  assert.equal(submitted?.jobId, "job-42");
  assert.equal(submitted?.hash, computeDeliverableHash(bytes));
  assert.equal(result.hash, computeDeliverableHash(bytes));
  assert.equal(result.txHash, "tx-1");
});

// ---------------------------------------------------------------------------
// Buyer budget policy
// ---------------------------------------------------------------------------

function makeFakeClock(startIso = "2024-06-01T10:00:00.000Z") {
  let now = new Date(startIso).getTime();
  return {
    now: () => new Date(now),
    advanceMs: (ms: number) => {
      now += ms;
    },
    set: (iso: string) => {
      now = new Date(iso).getTime();
    },
  };
}

function makeFakeFetch(response: { ok?: boolean; status?: number; body?: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const status = response.status ?? (response.ok === false ? 400 : 200);
    const ok = response.ok ?? status < 400;
    return {
      ok,
      status,
      async json() {
        return response.body ?? {};
      },
      async text() {
        return typeof response.body === "string"
          ? response.body
          : JSON.stringify(response.body ?? {});
      },
    } as unknown as Response;
  };
  return { fetchImpl, calls };
}

test("createBudgetPolicy - refuses a job priced above BUDGET_MAX_PER_JOB", async () => {
  const clock = makeFakeClock();
  const policy = createBudgetPolicy({
    maxPerJob: 100,
    dailyCap: 1000,
    now: clock.now,
  });

  await assert.rejects(
    async () => {
      await policy.authorize({ jobId: "job-over", amount: 150 });
    },
    (err: unknown) => {
      assert.ok(err instanceof BudgetExceededError);
      assert.equal(err.reason, "per-job");
      assert.equal(err.amount, 150);
      assert.equal(err.limit, 100);
      return true;
    },
  );

  // Nothing should have been charged against the daily cap.
  assert.equal(policy.getSpentToday(), 0);
});

test("createBudgetPolicy - allows a job priced exactly at BUDGET_MAX_PER_JOB", async () => {
  const clock = makeFakeClock();
  const policy = createBudgetPolicy({
    maxPerJob: 100,
    dailyCap: 1000,
    now: clock.now,
  });

  const decision = await policy.authorize({ jobId: "job-exact", amount: 100 });
  assert.equal(decision.approved, true);
  assert.equal(decision.requiresApproval, false);
  assert.equal(policy.getSpentToday(), 100);
});

test("createBudgetPolicy - enforces the daily cap across multiple jobs", async () => {
  const clock = makeFakeClock();
  const policy = createBudgetPolicy({
    maxPerJob: 100,
    dailyCap: 250,
    now: clock.now,
  });

  await policy.authorize({ jobId: "job-1", amount: 100 });
  await policy.authorize({ jobId: "job-2", amount: 100 });
  assert.equal(policy.getSpentToday(), 200);

  await assert.rejects(
    async () => {
      await policy.authorize({ jobId: "job-3", amount: 100 });
    },
    (err: unknown) => {
      assert.ok(err instanceof BudgetExceededError);
      assert.equal(err.reason, "daily-cap");
      assert.equal(err.amount, 100);
      assert.equal(err.limit, 250);
      return true;
    },
  );

  // The refused job must not be charged.
  assert.equal(policy.getSpentToday(), 200);
});

test("createBudgetPolicy - resets the daily counter at UTC midnight", async () => {
  const clock = makeFakeClock("2024-06-01T23:30:00.000Z");
  const policy = createBudgetPolicy({
    maxPerJob: 100,
    dailyCap: 150,
    now: clock.now,
  });

  await policy.authorize({ jobId: "job-before-midnight", amount: 150 });
  assert.equal(policy.getSpentToday(), 150);

  // Still the same UTC day -> cap is exhausted.
  clock.set("2024-06-01T23:59:59.000Z");
  await assert.rejects(
    async () => {
      await policy.authorize({ jobId: "job-same-day", amount: 10 });
    },
    (err: unknown) => {
      assert.ok(err instanceof BudgetExceededError);
      assert.equal(err.reason, "daily-cap");
      return true;
    },
  );

  // Cross UTC midnight -> counter resets.
  clock.set("2024-06-02T00:00:01.000Z");
  assert.equal(policy.getSpentToday(), 0);

  const decision = await policy.authorize({ jobId: "job-next-day", amount: 150 });
  assert.equal(decision.approved, true);
  assert.equal(policy.getSpentToday(), 150);
});

test("createBudgetPolicy - skips approval when amount is below the approval threshold", async () => {
  const clock = makeFakeClock();
  const { fetchImpl, calls } = makeFakeFetch({ body: { approved: true } });
  const policy = createBudgetPolicy({
    maxPerJob: 1000,
    dailyCap: 5000,
    approvalThreshold: 500,
    approvalWebhookUrl: "https://approvals.example.test/hook",
    fetchImpl,
    now: clock.now,
  });

  const decision = await policy.authorize({ jobId: "job-small", amount: 100 });
  assert.equal(decision.approved, true);
  assert.equal(decision.requiresApproval, false);
  assert.equal(calls.length, 0, "webhook must not be called below threshold");
  assert.equal(policy.getSpentToday(), 100);
});

test("createBudgetPolicy - calls approval webhook and proceeds when approved", async () => {
  const clock = makeFakeClock();
  const { fetchImpl, calls } = makeFakeFetch({ body: { approved: true } });
  const policy = createBudgetPolicy({
    maxPerJob: 1000,
    dailyCap: 5000,
    approvalThreshold: 500,
    approvalWebhookUrl: "https://approvals.example.test/hook",
    fetchImpl,
    now: clock.now,
  });

  const decision = await policy.authorize({
    jobId: "job-large",
    amount: 750,
    prompt: "Build a landing page",
  });

  assert.equal(decision.approved, true);
  assert.equal(decision.requiresApproval, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://approvals.example.test/hook");
  assert.equal(calls[0].init?.method, "POST");

  const sentBody = JSON.parse(String(calls[0].init?.body));
  assert.equal(sentBody.jobId, "job-large");
  assert.equal(sentBody.amount, 750);

  assert.equal(policy.getSpentToday(), 750);
});

test("createBudgetPolicy - refuses the job when the approval webhook denies it", async () => {
  const clock = makeFakeClock();
  const { fetchImpl, calls } = makeFakeFetch({ body: { approved: false } });
  const policy = createBudgetPolicy({
    maxPerJob: 1000,
    dailyCap: 5000,
    approvalThreshold: 500,
    approvalWebhookUrl: "https://approvals.example.test/hook",
    fetchImpl,
    now: clock.now,
  });

  await assert.rejects(
    async () => {
      await policy.authorize({ jobId: "job-denied", amount: 750 });
    },
    (err: unknown) => {
      assert.ok(err instanceof BudgetExceededError);
      assert.equal(err.reason, "approval-denied");
      return true;
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(policy.getSpentToday(), 0);
});

test("createBudgetPolicy - refuses the job when the approval webhook errors", async () => {
  const clock = makeFakeClock();
  const fetchImpl = async () => {
    throw new Error("network down");
  };
  const policy = createBudgetPolicy({
    maxPerJob: 1000,
    dailyCap: 5000,
    approvalThreshold: 500,
    approvalWebhookUrl: "https://approvals.example.test/hook",
    fetchImpl,
    now: clock.now,
  });

  await assert.rejects(
    async () => {
      await policy.authorize({ jobId: "job-err", amount: 750 });
    },
    (err: unknown) => {
      assert.ok(err instanceof BudgetExceededError);
      assert.equal(err.reason, "approval-error");
      return true;
    },
  );

  assert.equal(policy.getSpentToday(), 0);
});

// LLM output parsing helpers (pure functions, no network)
// ---------------------------------------------------------------------------

test("extractJsonObject - extracts a JSON object from surrounding prose", () => {
  const text = 'Sure! Here is the result:\n{"name":"Acme","score":9}\nHope that helps.';
  const extracted = extractJsonObject(text);
  assert.equal(extracted, '{"name":"Acme","score":9}');
});

test("extractJsonObject - extracts a JSON object from a fenced code block", () => {
  const text = '```json\n{"name":"Acme"}\n```';
  assert.equal(extractJsonObject(text), '{"name":"Acme"}');
});

test("extractJsonObject - returns null for empty string", () => {
  assert.equal(extractJsonObject(""), null);
});

test("extractJsonObject - returns null for whitespace-only string", () => {
  assert.equal(extractJsonObject("   \n\t "), null);
});

test("extractJsonObject - returns null for non-JSON input", () => {
  assert.equal(extractJsonObject("I cannot help with that request."), null);
});

test("extractJsonObject - returns null for truncated JSON", () => {
  assert.equal(extractJsonObject('{"name":"Acme","score":'), null);
});

test("parseLlmJson - parses a valid JSON object", () => {
  const result = parseLlmJson('{"name":"Acme","score":9}');
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { name: "Acme", score: 9 });
  assert.equal(result.error, undefined);
});

test("parseLlmJson - parses JSON embedded in prose", () => {
  const result = parseLlmJson('Here you go: {"name":"Acme"} done.');
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { name: "Acme" });
});

test("parseLlmJson - returns controlled error for empty string", () => {
  const result = parseLlmJson("");
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
  assert.equal(result.value, undefined);
});

test("parseLlmJson - returns controlled error for truncated JSON", () => {
  const result = parseLlmJson('{"name":"Acme"');
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
});

test("parseLlmJson - returns controlled error for non-JSON input", () => {
  const result = parseLlmJson("not json at all");
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
});

test("parseLlmJson - returns controlled error for JSON array (not an object)", () => {
  const result = parseLlmJson("[1,2,3]");
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
});

test("parseNamerResponse - parses a valid namer response", () => {
  const raw = JSON.stringify({
    names: ["Acme Labs", "BrightWorks"],
    rationale: "Short, memorable, brandable.",
  });
  const result = parseNamerResponse(raw);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value?.names, ["Acme Labs", "BrightWorks"]);
  assert.equal(result.value?.rationale, "Short, memorable, brandable.");
});

test("parseNamerResponse - ignores extra fields", () => {
  const raw = JSON.stringify({
    names: ["Acme Labs"],
    rationale: "ok",
    extra: { nested: true },
    confidence: 0.9,
  });
  const result = parseNamerResponse(raw);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value?.names, ["Acme Labs"]);
});

test("parseNamerResponse - returns controlled error for empty string", () => {
  const result = parseNamerResponse("");
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
  assert.equal(result.value, undefined);
});

test("parseNamerResponse - returns controlled error for truncated JSON", () => {
  const result = parseNamerResponse('{"names":["Acme"');
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
});

test("parseNamerResponse - returns controlled error for non-JSON input", () => {
  const result = parseNamerResponse("I am unable to comply.");
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
});

test("parseNamerResponse - returns controlled error for wrong types", () => {
  const result = parseNamerResponse(JSON.stringify({ names: "Acme", rationale: 42 }));
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
});

test("parseNamerResponse - returns controlled error when names is empty array", () => {
  const result = parseNamerResponse(JSON.stringify({ names: [], rationale: "none" }));
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
});

test("parseResearcherResponse - parses a valid researcher response", () => {
  const raw = JSON.stringify({
    summary: "The market is growing.",
    findings: ["Finding one", "Finding two"],
    sources: ["https://example.com/a"],
  });
  const result = parseResearcherResponse(raw);
  assert.equal(result.ok, true);
  assert.equal(result.value?.summary, "The market is growing.");
  assert.deepEqual(result.value?.findings, ["Finding one", "Finding two"]);
  assert.deepEqual(result.value?.sources, ["https://example.com/a"]);
});

test("parseResearcherResponse - ignores extra fields", () => {
  const raw = JSON.stringify({
    summary: "ok",
    findings: ["f"],
    sources: [],
    metadata: { model: "x" },
  });
  const result = parseResearcherResponse(raw);
  assert.equal(result.ok, true);
  assert.equal(result.value?.summary, "ok");
});

test("parseResearcherResponse - returns controlled error for empty string", () => {
  const result = parseResearcherResponse("");
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
  assert.equal(result.value, undefined);
});

test("parseResearcherResponse - returns controlled error for truncated JSON", () => {
  const result = parseResearcherResponse('{"summary":"ok","findings":[');
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
});

test("parseResearcherResponse - returns controlled error for non-JSON input", () => {
  const result = parseResearcherResponse("Sorry, no results.");
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
});

test("parseResearcherResponse - returns controlled error for wrong types", () => {
  const result = parseResearcherResponse(
    JSON.stringify({ summary: 123, findings: "not-an-array", sources: "nope" }),
  );
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
});

test("parseResearcherResponse - returns controlled error when summary is missing", () => {
  const result = parseResearcherResponse(
    JSON.stringify({ findings: ["f"], sources: [] }),
  );
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
});

test("parsers - never perform network calls (pure functions)", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  // @ts-ignore
  globalThis.fetch = (..._args: unknown[]) => {
    fetchCalls++;
    throw new Error("network access is not allowed in parser tests");
  };

  try {
    parseLlmJson('{"a":1}');
    parseLlmJson("garbage");
    parseNamerResponse(JSON.stringify({ names: ["A"], rationale: "r" }));
    parseNamerResponse("garbage");
    parseResearcherResponse(
      JSON.stringify({ summary: "s", findings: [], sources: [] }),
    );
    parseResearcherResponse("garbage");
    extractJsonObject("garbage");
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
