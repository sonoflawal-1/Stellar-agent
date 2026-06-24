export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options?: { maxAttempts?: number; baseDelayMs?: number; label?: string },
): Promise<T> {
  const { maxAttempts = 5, baseDelayMs = 1000, label = "" } = options ?? {};
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 200;
      const prefix = label ? `[${label}] ` : "";
      console.error(`${prefix}attempt ${attempt}/${maxAttempts} failed, retrying in ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

export async function startHeartbeat(
  agentId: string,
  registryUrl: string,
  options?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    intervalMs?: number;
    apiKey?: string;
  },
) {
  const {
    maxAttempts = 6,
    baseDelayMs = 2000,
    intervalMs = 60_000,
    apiKey,
  } = options ?? {};

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  async function sendHeartbeat(): Promise<void> {
    const res = await fetch(`${registryUrl}/heartbeat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agentId }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`heartbeat failed (${res.status}): ${text}`);
    }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await sendHeartbeat();
      console.log(`[${agentId}] Heartbeat established with ${registryUrl}`);
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === maxAttempts) {
        console.warn(`[${agentId}] Heartbeat startup failed after ${maxAttempts} attempts: ${message}`);
      } else {
        const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 200;
        console.warn(`[${agentId}] Heartbeat attempt ${attempt}/${maxAttempts} failed: ${message}. Retrying in ${Math.round(delay)}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  setInterval(async () => {
    try {
      await sendHeartbeat();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[${agentId}] Heartbeat retry failed: ${message}`);
    }
  }, intervalMs);
}
