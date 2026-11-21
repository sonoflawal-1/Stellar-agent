const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:3000", "http://localhost:5173"];

const CSP_DIRECTIVES = ["connect-src", "img-src", "script-src"] as const;
export type CspDirective = (typeof CSP_DIRECTIVES)[number];

const CSP_ENV_VARS: Record<CspDirective, string> = {
  "connect-src": "CSP_CONNECT_SRC",
  "img-src": "CSP_IMG_SRC",
  "script-src": "CSP_SCRIPT_SRC",
};

export type CspOrigins = Record<CspDirective, string[]>;

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function parseAllowedOrigins(
  env: Record<string, string | undefined>,
  warn: (message: string) => void = (message) => console.warn(message),
): string[] {
  const configured: Array<{ name: string; value: string }> = [];
  if (Object.hasOwn(env, "ALLOWED_ORIGIN")) {
    configured.push({ name: "ALLOWED_ORIGIN", value: env.ALLOWED_ORIGIN ?? "" });
  }
  if (Object.hasOwn(env, "ALLOWED_ORIGINS")) {
    (env.ALLOWED_ORIGINS ?? "").split(",").forEach((value, index) => {
      configured.push({ name: `ALLOWED_ORIGINS entry ${index + 1}`, value });
    });
  }

  const origins = new Set(DEFAULT_ALLOWED_ORIGINS);
  const invalid: string[] = [];
  for (const entry of configured) {
    const value = entry.value.trim();
    if (!value) {
      invalid.push(entry.name);
      continue;
    }
    const origin = normalizeOrigin(value);
    if (!origin) {
      invalid.push(entry.name);
      continue;
    }
    origins.add(origin);
  }

  for (const entry of invalid) {
    warn(`[cors] Invalid or empty origin configured in ${entry}`);
  }
  if (invalid.length > 0 && env.NODE_ENV === "production") {
    throw new Error("Invalid CORS origin configuration");
  }
  return [...origins];
}

export function parseCspOrigins(
  env: Record<string, string | undefined>,
  warn: (message: string) => void = (message) => console.warn(message),
): CspOrigins {
  const result = {} as CspOrigins;
  const invalid: string[] = [];

  for (const directive of CSP_DIRECTIVES) {
    const name = CSP_ENV_VARS[directive];
    const values = new Set<string>();
    if (Object.hasOwn(env, name)) {
      (env[name] ?? "").split(",").forEach((raw, index) => {
        const value = raw.trim();
        if (!value) {
          invalid.push(`${name} entry ${index + 1}`);
          return;
        }
        const origin = normalizeOrigin(value);
        if (!origin) {
          invalid.push(`${name} entry ${index + 1}`);
          return;
        }
        values.add(origin);
      });
    }
    result[directive] = [...values];
  }

  for (const entry of invalid) {
    warn(`[csp] Invalid or empty origin configured in ${entry}`);
  }
  if (invalid.length > 0 && env.NODE_ENV === "production") {
    throw new Error("Invalid CSP origin configuration");
  }
  return result;
}
