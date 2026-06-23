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
