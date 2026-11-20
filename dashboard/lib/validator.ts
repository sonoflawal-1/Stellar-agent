// dashboard/lib/validator.ts
//
// DeliverableValidator
// --------------------
// Automated inspection & validation pipeline for deliverable URIs submitted
// against agentic-commerce contracts. Deliverables are arbitrary strings, so
// before an evaluator (human or automated) is notified we must ensure the URI
// is safe to render / click / fetch.
//
// Responsibilities:
//   1. Strict scheme allow-listing (https:// and ipfs:// only).
//   2. Malicious URL reputation checks (Google Safe Browsing, optional VirusTotal).
//   3. IPFS CID validation + MIME/size inspection via gateway HEAD/range request.
//   4. SSRF protection (reject private / loopback / link-local / reserved IPs).
//   5. Structured result so the dashboard can render warning badges.

import { promises as dns } from 'node:dns';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type WarningCode =
  | 'INVALID_URI'
  | 'DISALLOWED_SCHEME'
  | 'MALFORMED_URL'
  | 'MALICIOUS_URL'
  | 'REPUTATION_CHECK_FAILED'
  | 'INVALID_CID'
  | 'SSRF_BLOCKED'
  | 'OVERSIZED_DELIVERABLE'
  | 'INVALID_MIME_TYPE'
  | 'FETCH_FAILED'
  | 'UNKNOWN_CONTENT_LENGTH';

export interface ValidationWarning {
  code: WarningCode;
  message: string;
}

export interface DeliverableMetadata {
  /** The original deliverable string as submitted. */
  raw: string;
  /** The normalized scheme, if one could be parsed. */
  scheme?: 'https' | 'ipfs';
  /** For https deliverables: the parsed URL (string form). */
  url?: string;
  /** For https deliverables: the resolved hostname. */
  hostname?: string;
  /** For ipfs deliverables: the validated CID. */
  cid?: string;
  /** For ipfs deliverables: the gateway URL that was inspected. */
  gatewayUrl?: string;
  /** Content-Type reported by the remote server / gateway. */
  contentType?: string;
  /** Content-Length (bytes) reported by the remote server / gateway. */
  contentLength?: number;
  /** Reputation verdicts keyed by provider. */
  reputation?: {
    safeBrowsing?: 'clean' | 'malicious' | 'unknown';
    virusTotal?: 'clean' | 'malicious' | 'unknown';
  };
}

export interface ValidationResult {
  /** True only when there are no blocking errors (warnings may still exist). */
  valid: boolean;
  warnings: ValidationWarning[];
  metadata: DeliverableMetadata;
}

export interface DeliverableValidatorOptions {
  /** Google Safe Browsing API key. Falls back to GOOGLE_SAFE_BROWSING_API_KEY. */
  safeBrowsingApiKey?: string;
  /** VirusTotal API key. Falls back to VIRUSTOTAL_API_KEY. Optional. */
  virusTotalApiKey?: string;
  /** IPFS gateway base URL. Falls back to IPFS_GATEWAY or a public default. */
  ipfsGateway?: string;
  /** Max deliverable size in bytes. Defaults to 50MB. */
  maxSizeBytes?: number;
  /** Timeout for outbound requests in ms. Defaults to 10s. */
  requestTimeoutMs?: number;
  /** Injectable fetch implementation (for testing). */
  fetchImpl?: typeof fetch;
  /** Injectable DNS resolver (for testing SSRF checks). */
  resolveHostname?: (hostname: string) => Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Job creation form rules
// ---------------------------------------------------------------------------
//
// These constants are the single source of truth for the client-side job
// creation form (dashboard/public/app.js). The browser cannot import this
// module directly, so the same values are mirrored there — keep them in sync.
// The server-side contract enforces the same bounds; any change here MUST be
// reflected in both the contract and the dashboard form validator.

export interface JobFormRules {
  /** Minimum job budget in whole USDC. */
  budgetMinUsdc: number;
  /** Maximum job budget in whole USDC. */
  budgetMaxUsdc: number;
  /** Maximum number of decimal places allowed for a budget amount. */
  budgetDecimals: number;
  /** Minimum description length (characters, trimmed). */
  descriptionMinLength: number;
  /** Maximum description length (characters, trimmed). */
  descriptionMaxLength: number;
  /** Maximum deliverable URI length (characters, trimmed). */
  deliverableMaxLength: number;
  /** Regex source (string form) for a Stellar account address (G...). */
  stellarAddressPattern: string;
  /** Regex source (string form) for a Soroban contract address (C...). */
  contractAddressPattern: string;
}

export const JOB_FORM_RULES: Readonly<JobFormRules> = Object.freeze({
  budgetMinUsdc: 1,
  budgetMaxUsdc: 1_000_000,
  budgetDecimals: 7,
  descriptionMinLength: 10,
  descriptionMaxLength: 2_000,
  deliverableMaxLength: 2_048,
  stellarAddressPattern: '^G[A-Z2-7]{55}$',
  contractAddressPattern: '^C[A-Z2-7]{55}$',
});

/**
 * Returns true if `value` is a valid Stellar account address (G..., 56 chars,
 * base32 alphabet). Mirrors the contract's address validation.
 */
export function isValidStellarAddress(value: string): boolean {
  return new RegExp(JOB_FORM_RULES.stellarAddressPattern).test(value);
}

/**
 * Returns true if `value` is a valid Soroban contract address (C..., 56 chars,
 * base32 alphabet). Mirrors the contract's address validation.
 */
export function isValidContractAddress(value: string): boolean {
  return new RegExp(JOB_FORM_RULES.contractAddressPattern).test(value);
}

/**
 * Returns true if `value` is a budget amount within the allowed bounds and
 * decimal precision. Accepts a number or a numeric string.
 */
export function isValidBudget(value: number | string): boolean {
  const amount = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(amount)) return false;
  if (amount < JOB_FORM_RULES.budgetMinUsdc) return false;
  if (amount > JOB_FORM_RULES.budgetMaxUsdc) return false;
  const decimals = (String(amount).split('.')[1] ?? '').length;
  return decimals <= JOB_FORM_RULES.budgetDecimals;
}

/**
 * Returns true if `value` is a description within the allowed length bounds
 * (measured after trimming surrounding whitespace).
 */
export function isValidDescription(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length >= JOB_FORM_RULES.descriptionMinLength &&
    trimmed.length <= JOB_FORM_RULES.descriptionMaxLength
  );
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

const SAFE_BROWSING_ENDPOINT =
  'https://safebrowsing.googleapis.com/v4/threatMatches:find';
const VIRUSTOTAL_ENDPOINT = 'https://www.virustotal.com/api/v3/urls';

const ALLOWED_SCHEMES = new Set(['https:', 'ipfs:']);

// CIDv0: base58btc, starts with "Qm", 46 chars total.
const CID_V0_REGEX = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
// CIDv1: multibase base32 (lowercase, "b" prefix) — the common form.
const CID_V1_BASE32_REGEX = /^b[a-z2-7]{20,}$/;
// CIDv1: multibase base58btc ("z" prefix).
const CID_V1_BASE58_REGEX = /^z[1-9A-HJ-NP-Za-km-z]{20,}$/;

// MIME types we consider safe to render / download for review.
const ALLOWED_MIME_PREFIXES = [
  'image/',
  'video/',
  'audio/',
  'text/',
  'application/pdf',
  'application/json',
  'application/zip',
  'application/octet-stream',
  'application/gzip',
  'application/x-tar',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isIpfsCid(value: string): boolean {
  return (
    CID_V0_REGEX.test(value) ||
    CID_V1_BASE32_REGEX.test(value) ||
    CID_V1_BASE58_REGEX.test(value)
  );
}

function isAllowedMimeType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const normalized = contentType.split(';')[0].trim().toLowerCase();
  return ALLOWED_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Returns true if the given IP address is in a private, loopback, link-local,
 * or otherwise reserved range that must never be contacted (SSRF guard).
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 0) {
    // Not an IP literal — treat as unsafe (caller should have resolved it).
    return true;
  }

  if (version === 4) {
    const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
    const [a, b] = parts;

    // 0.0.0.0/8
    if (a === 0) return true;
    // 10.0.0.0/8
    if (a === 10) return true;
    // 127.0.0.0/8 (loopback)
    if (a === 127) return true;
    // 169.254.0.0/16 (link-local, includes cloud metadata 169.254.169.254)
    if (a === 169 && b === 254) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 100.64.0.0/10 (carrier-grade NAT)
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 192.0.0.0/24, 192.0.2.0/24 (documentation), 198.18.0.0/15 (benchmark)
    if (a === 192 && b === 0) return true;
    if (a === 192 && b === 2) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    // 224.0.0.0/4 (multicast), 240.0.0.0/4 (reserved), 255.255.255.255
    if (a >= 224) return true;

    return false;
  }

  // IPv6
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  // IPv4-mapped (::ffff:a.b.c.d) — extract and re-check.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateOrReservedIp(mapped[1]);
  // Unique local addresses fc00::/7
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  // Link-local fe80::/10
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  // Multicast ff00::/8
  if (/^ff[0-9a-f]{2}:/.test(lower)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// DeliverableValidator
// ---------------------------------------------------------------------------

export class DeliverableValidator {
  private readonly safeBrowsingApiKey?: string;
  private readonly virusTotalApiKey?: string;
  private readonly ipfsGateway: string;
  private readonly maxSizeBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveHostname: (hostname: string) => Promise<string[]>;

  constructor(options: DeliverableValidatorOptions = {}) {
    this.safeBrowsingApiKey =
      options.safeBrowsingApiKey ??
      process.env.GOOGLE_SAFE_BROWSING_API_KEY ??
      undefined;
    this.virusTotalApiKey =
      options.virusTotalApiKey ?? process.env.VIRUSTOTAL_API_KEY ?? undefined;

    const gateway =
      options.ipfsGateway ??
      process.env.IPFS_GATEWAY ??
      DEFAULT_IPFS_GATEWAY;
    this.ipfsGateway = gateway.endsWith('/') ? gateway : `${gateway}/`;

    this.maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.resolveHostname =
      options.resolveHostname ??
      (async (hostname: string) => {
        const records = await dns.lookup(hostname, { all: true });
        return records.map((r) => r.address);
      });
  }

  // -------------------------------------------------------------------------
  // Public entry point
  // -------------------------------------------------------------------------

  async validate(deliverable: string): Promise<ValidationResult> {
    const warnings: ValidationWarning[] = [];
    const metadata: DeliverableMetadata = { raw: deliverable };

    // --- 1. Basic parse & scheme allow-listing -----------------------------
    const trimmed = typeof deliverable === 'string' ? deliverable.trim() : '';
    if (!trimmed) {
      warnings.push({
        code: 'INVALID_URI',
        message: 'Deliverable is empty.',
      });
      return { valid: false, warnings, metadata };
    }

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      warnings.push({
        code: 'MALFORMED_URL',
        message: 'Deliverable is not a well-formed URI.',
      });
      return { valid: false, warnings, metadata };
    }

    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
      warnings.push({
        code: 'DISALLOWED_SCHEME',
        message: `Scheme "${parsed.protocol}" is not allowed. Only https:// and ipfs:// are permitted.`,
      });
      return { valid: false, warnings, metadata };
    }

    // --- 1b. Length bound (mirrors JOB_FORM_RULES.deliverableMaxLength) ----
    if (trimmed.length > JOB_FORM_RULES.deliverableMaxLength) {
      warnings.push({
        code: 'INVALID_URI',
        message: `Deliverable exceeds the ${JOB_FORM_RULES.deliverableMaxLength}-character limit.`,
      });
      return { valid: false, warnings, metadata };
    }

    // --- 2. Dispatch by scheme --------------------------------------------
    if (parsed.protocol === 'https:') {
      metadata.scheme = 'https';
      await this.validateHttps(parsed, warnings, metadata);
    } else {
      metadata.scheme = 'ipfs';
      await this.validateIpfs(parsed, warnings, metadata);
    }

    const valid = !warnings.some((w) =>
      [
        'INVALID_URI',
        'DISALLOWED_SCHEME',
        'MALFORMED_URL',
        'MALICIOUS_URL',
        'INVALID_CID',
        'SSRF_BLOCKED',
        'OVERSIZED_DELIVERABLE',
        'INVALID_MIME_TYPE',
      ].includes(w.code),
    );

    return { valid, warnings, metadata };
  }

  // -------------------------------------------------------------------------
  // https:// deliverables
  // -------------------------------------------------------------------------

  private async validateHttps(
    url: URL,
    warnings: ValidationWarning[],
    metadata: DeliverableMetadata,
  ): Promise<void> {
    metadata.url = url.toString();
    metadata.hostname = url.hostname;

    // --- SSRF guard: resolve hostname, reject private ranges --------------
    const ssrfSafe = await this.assertHostIsPublic(url.hostname, warnings);
    if (!ssrfSafe) return;

    // --- Reputation checks ------------------------------------------------
    metadata.reputation = {};

    const safeBrowsingVerdict = await this.checkSafeBrowsing(
      url.toString(),
      warnings,
    );
    metadata.reputation.safeBrowsing = safeBrowsingVerdict;

    if (this.virusTotalApiKey) {
      const vtVerdict = await this.checkVirusTotal(url.toString(), warnings);
      metadata.reputation.virusTotal = vtVerdict;
    }
  }

  // -------------------------------------------------------------------------
  // ipfs:// deliverables
  // -------------------------------------------------------------------------

  private async validateIpfs(
    url: URL,
    warnings: ValidationWarning[],
    metadata: DeliverableMetadata,
  ): Promise<void> {
    // ipfs://<cid>[/path] — URL parsing puts the CID in the hostname.
    const cid = url.hostname;
    if (!cid || !isIpfsCid(cid)) {
      warnings.push({
        code: 'INVALID_CID',
        message: 'Deliverable does not contain a valid IPFS CID.',
      });
      return;
    }
    metadata.cid = cid;

    const path = url.pathname && url.pathname !== '/' ? url.pathname : '';
    const gatewayUrl = `${this.ipfsGateway}${cid}${path}`;
    metadata.gatewayUrl = gatewayUrl;

    // --- SSRF guard on the gateway host -----------------------------------
    let gatewayHost: string;
    try {
      gatewayHost = new URL(gatewayUrl).hostname;
    } catch {
      warnings.push({
        code: 'FETCH_FAILED',
        message: 'Configured IPFS gateway URL is invalid.',
      });
      return;
    }

    const ssrfSafe = await this.assertHostIsPublic(gatewayHost, warnings);
    if (!ssrfSafe) return;

    // --- HEAD / range request to inspect MIME + size ----------------------
    await this.inspectRemoteContent(gatewayUrl, warnings, metadata);
  }

  // -------------------------------------------------------------------------
  // Remote content inspection (HEAD, falling back to ranged GET)
  // -------------------------------------------------------------------------

  private async inspectRemoteContent(
    targetUrl: string,
    warnings: ValidationWarning[],
    metadata: DeliverableMetadata,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(targetUrl, {
          method: 'HEAD',
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch {
        // Some gateways do not support HEAD; fall back to a 1-byte range GET.
        response = await this.fetchImpl(targetUrl, {
          method: 'GET',
          headers: { Range: 'bytes=0-0' },
          redirect: 'manual',
          signal: controller.signal,
        });
      }

      // Reject redirects to unexpected locations (defense in depth).
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          let redirectUrl: URL;
          try {
            redirectUrl = new URL(location, targetUrl);
          } catch {
            warnings.push({
              code: 'FETCH_FAILED',
              message: 'Remote server returned an invalid redirect.',
            });
            return;
          }
          if (redirectUrl.protocol !== 'https:') {
            warnings.push({
              code: 'DISALLOWED_SCHEME',
              message: 'Remote server redirected to a non-https location.',
            });
            return;
          }
          const redirectSafe = await this.assertHostIsPublic(
            redirectUrl.hostname,
            warnings,
          );
          if (!redirectSafe) return;
        }
      }

      if (!response.ok && !(response.status === 206)) {
        warnings.push({
          code: 'FETCH_FAILED',
          message: `Remote server responded with status ${response.status}.`,
        });
        return;
      }

      // --- MIME type -----------------------------------------------------
      const contentType = response.headers.get('content-type') ?? undefined;
      metadata.contentType = contentType;
      if (!isAllowedMimeType(contentType)) {
        warnings.push({
          code: 'INVALID_MIME_TYPE',
          message: `Content-Type "${contentType ?? 'unknown'}" is not an allowed deliverable format.`,
        });
      }

      // --- Size ----------------------------------------------------------
      const contentLengthHeader = response.headers.get('content-length');
      if (contentLengthHeader) {
        const contentLength = Number.parseInt(contentLengthHeader, 10);
        if (Number.isFinite(contentLength)) {
          metadata.contentLength = contentLength;
          if (contentLength > this.maxSizeBytes) {
            warnings.push({
              code: 'OVERSIZED_DELIVERABLE',
              message: `Deliverable is ${contentLength} bytes, exceeding the ${this.maxSizeBytes}-byte limit.`,
            });
          }
        }
      } else {
        // No Content-Length: we cannot guarantee size before full fetch.
        warnings.push({
          code: 'UNKNOWN_CONTENT_LENGTH',
          message:
            'Remote server did not report a Content-Length; size cannot be verified before download.',
        });
      }
    } catch (err) {
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? 'Remote content inspection timed out.'
          : 'Failed to inspect remote content.';
      warnings.push({ code: 'FETCH_FAILED', message });
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // SSRF guard
  // -------------------------------------------------------------------------

  private async assertHostIsPublic(
    hostname: string,
    warnings: ValidationWarning[],
  ): Promise<boolean> {
    // Reject IP literals directly.
    if (net.isIP(hostname)) {
      if (isPrivateOrReservedIp(hostname)) {
        warnings.push({
          code: 'SSRF_BLOCKED',
          message: `Host "${hostname}" resolves to a private or reserved address.`,
        });
        return false;
      }
      return true;
    }

    // Reject obviously local hostnames.
    const lower = hostname.toLowerCase();
    if (
      lower === 'localhost' ||
      lower.endsWith('.localhost') ||
      lower.endsWith('.local') ||
      lower.endsWith('.internal')
    ) {
      warnings.push({
        code: 'SSRF_BLOCKED',
        message: `Host "${hostname}" is a local/internal hostname.`,
      });
      return false;
    }

    let addresses: string[];
    try {
      addresses = await this.resolveHostname(hostname);
    } catch {
      warnings.push({
        code: 'SSRF_BLOCKED',
        message: `Could not resolve host "${hostname}".`,
      });
      return false;
    }

    if (addresses.length === 0) {
      warnings.push({
        code: 'SSRF_BLOCKED',
        message: `Host "${hostname}" did not resolve to any address.`,
      });
      return false;
    }

    for (const address of addresses) {
      if (isPrivateOrReservedIp(address)) {
        warnings.push({
          code: 'SSRF_BLOCKED',
          message: `Host "${hostname}" resolves to a private or reserved address (${address}).`,
        });
        return false;
      }
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Google Safe Browsing
  // -------------------------------------------------------------------------

  private async checkSafeBrowsing(
    url: string,
    warnings: ValidationWarning[],
  ): Promise<'clean' | 'malicious' | 'unknown'> {
    if (!this.safeBrowsingApiKey) {
      return 'unknown';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const body = {
        client: {
          clientId: 'agentic-commerce-dashboard',
          clientVersion: '1.0.0',
        },
        threatInfo: {
          threatTypes: [
            'MALWARE',
            'SOCIAL_ENGINEERING',
            'UNWANTED_SOFTWARE',
            'POTENTIALLY_HARMFUL_APPLICATION',
          ],
          platformTypes: ['ANY_PLATFORM'],
          threatEntryTypes: ['URL'],
          threatEntries: [{ url }],
        },
      };

      const response = await this.fetchImpl(
        `${SAFE_BROWSING_ENDPOINT}?key=${encodeURIComponent(this.safeBrowsingApiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        warnings.push({
          code: 'REPUTATION_CHECK_FAILED',
          message: `Google Safe Browsing lookup failed with status ${response.status}.`,
        });
        return 'unknown';
      }

      const data = (await response.json()) as { matches?: unknown[] };
      if (Array.isArray(data.matches) && data.matches.length > 0) {
        warnings.push({
          code: 'MALICIOUS_URL',
          message: 'Google Safe Browsing flagged this URL as malicious.',
        });
        return 'malicious';
      }
      return 'clean';
    } catch (err) {
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? 'Google Safe Browsing lookup timed out.'
          : 'Google Safe Browsing lookup failed.';
      warnings.push({ code: 'REPUTATION_CHECK_FAILED', message });
      return 'unknown';
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // VirusTotal (optional)
  // -------------------------------------------------------------------------

  private async checkVirusTotal(
    url: string,
    warnings: ValidationWarning[],
  ): Promise<'clean' | 'malicious' | 'unknown'> {
    if (!this.virusTotalApiKey) return 'unknown';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      // Submit the URL for analysis (idempotent; VT de-dupes by URL).
      const submitResponse = await this.fetchImpl(VIRUSTOTAL_ENDPOINT, {
        method: 'POST',
        headers: {
          'x-apikey': this.virusTotalApiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ url }).toString(),
        signal: controller.signal,
      });

      if (!submitResponse.ok) {
        warnings.push({
          code: 'REPUTATION_CHECK_FAILED',
          message: `VirusTotal lookup failed with status ${submitResponse.status}.`,
        });
        return 'unknown';
      }

      const submitData = (await submitResponse.json()) as {
        data?: { id?: string };
      };
      const analysisId = submitData.data?.id;
      if (!analysisId) return 'unknown';

      const analysisResponse = await this.fetchImpl(
        `https://www.virustotal.com/api/v3/analyses/${encodeURIComponent(analysisId)}`,
        {
          method: 'GET',
          headers: { 'x-apikey': this.virusTotalApiKey },
          signal: controller.signal,
        },
      );

      if (!analysisResponse.ok) {
        warnings.push({
          code: 'REPUTATION_CHECK_FAILED',
          message: `VirusTotal analysis fetch failed with status ${analysisResponse.status}.`,
        });
        return 'unknown';
      }

      const analysisData = (await analysisResponse.json()) as {
        data?: { attributes?: { stats?: Record<string, number> } };
      };
      const stats = analysisData.data?.attributes?.stats ?? {};
      const maliciousCount =
        (stats.malicious ?? 0) + (stats.suspicious ?? 0);

      if (maliciousCount > 0) {
        warnings.push({
          code: 'MALICIOUS_URL',
          message: `VirusTotal flagged this URL (${maliciousCount} engine(s)).`,
        });
        return 'malicious';
      }
      return 'clean';
    } catch (err) {
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? 'VirusTotal lookup timed out.'
          : 'VirusTotal lookup failed.';
      warnings.push({ code: 'REPUTATION_CHECK_FAILED', message });
      return 'unknown';
    } finally {
      clearTimeout(timer);
    }
  }
}

export default DeliverableValidator;

// ---------------------------------------------------------------------------
// Agent metadata schema validation
// ---------------------------------------------------------------------------
//
// Agent metadata is a free-form JSON blob attached to an agent profile. The
// canonical shape is defined in `docs/agent-metadata-schema-v1.json`. We
// validate it with ajv so the agent detail page can render a warning badge
// instead of crashing when the metadata is malformed.

export interface MetadataValidationError {
  /** JSON pointer to the offending field (e.g. "/name"). */
  instancePath: string;
  /** ajv keyword that failed (e.g. "required", "type"). */
  keyword: string;
  /** Human-readable message suitable for rendering in the UI. */
  message: string;
  /** Additional keyword-specific context (e.g. missing property name). */
  params?: Record<string, unknown>;
}

export interface MetadataValidationResult {
  /** True only when the metadata fully conforms to the schema. */
  valid: boolean;
  errors: MetadataValidationError[];
}

export interface AgentMetadataValidatorOptions {
  /** Override the schema object (useful for testing). */
  schema?: object;
  /** Override the path to the schema file. */
  schemaPath?: string;
}

const DEFAULT_SCHEMA_PATH = path.resolve(
  process.cwd(),
  'docs',
  'agent-metadata-schema-v1.json',
);

// Minimal fallback schema used when the on-disk schema cannot be loaded, so
// that a missing/broken schema file degrades to a warning rather than a crash.
const FALLBACK_SCHEMA: object = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    version: { type: 'string' },
  },
  required: ['name'],
  additionalProperties: true,
};

function toValidationErrors(errors: ErrorObject[] | null | undefined): MetadataValidationError[] {
  if (!errors) return [];
  return errors.map((err) => ({
    instancePath: err.instancePath ?? '',
    keyword: err.keyword,
    message: err.message ?? `Failed "${err.keyword}" validation.`,
    params: err.params as Record<string, unknown> | undefined,
  }));
}

export class AgentMetadataValidator {
  private readonly validateFn: ValidateFunction;

  constructor(options: AgentMetadataValidatorOptions = {}) {
    const ajv = new Ajv({ allErrors: true, strict: false });

    let schema: object;
    if (options.schema) {
      schema = options.schema;
    } else {
      const schemaPath = options.schemaPath ?? DEFAULT_SCHEMA_PATH;
      try {
        schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
      } catch {
        schema = FALLBACK_SCHEMA;
      }
    }

    this.validateFn = ajv.compile(schema);
  }

  /**
   * Validate agent metadata. Accepts either a parsed object or a raw JSON
   * string. Never throws: malformed JSON or schema violations are reported as
   * structured errors so callers can render a warning.
   */
  validate(metadata: unknown): MetadataValidationResult {
    let value: unknown = metadata;

    if (typeof metadata === 'string') {
      try {
        value = JSON.parse(metadata);
      } catch {
        return {
          valid: false,
          errors: [
            {
              instancePath: '',
              keyword: 'parse',
              message: 'Metadata is not valid JSON.',
            },
          ],
        };
      }
    }

    const valid = this.validateFn(value) as boolean;
    return {
      valid,
      errors: valid ? [] : toValidationErrors(this.validateFn.errors),
    };
  }
}

export default DeliverableValidator;
```

```typescript
// dashboard/lib/validator.test.ts
//
// Unit tests for DeliverableValidator.
// Covers: malicious payloads (dangerous schemes, flagged URLs),
// SSRF attempts, and valid IPFS hashes.

import { describe, it, expect, vi } from 'vitest';
import {
  DeliverableValidator,
  isPrivateOrReservedIp,
} from './validator';

// A resolver that maps every hostname to a public IP by default.
const publicResolver = async () => ['93.184.216.34'];
// A resolver that maps every hostname to a private IP.
const privateResolver = async () => ['10.0.0.5'];

function makeResponse(
  init: {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Response {
  const status = init.status ?? 200;
  const headers = new Headers(init.headers ?? {});
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => init.body ?? {},
  } as unknown as Response;
}

describe('DeliverableValidator — scheme allow-listing', () => {
  const validator = new DeliverableValidator({
    resolveHostname: publicResolver,
    fetchImpl: vi.fn() as unknown as typeof fetch,
  });

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'ftp://example.com/file',
    'http://example.com',
    'vbscript:msgbox(1)',
  ])('rejects dangerous scheme: %s', async (payload) => {
    const result = await validator.validate(payload);
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.code === 'DISALLOWED_SCHEME')).toBe(
      true,
    );
  });

  it('rejects empty deliverables', async () => {
    const result = await validator.validate('   ');
    expect(result.valid).toBe(false);
    expect(result.warnings[0].code).toBe('INVALID_URI');
  });

  it('rejects malformed URIs', async () => {
    const result = await validator.validate('not a url');
    expect(result.valid).toBe(false);
    expect(result.warnings[0].code).toBe('MALFORMED_URL');
  });
});

describe('DeliverableValidator — malicious URL reputation', () => {
  it('flags URLs reported by Google Safe Browsing', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('safebrowsing')) {
        return makeResponse({ body: { matches: [{ threatType: 'MALWARE' }] } });
      }
      return makeResponse();
    });

    const validator = new DeliverableValidator({
      safeBrowsingApiKey: 'test-key',
      resolveHostname: publicResolver,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await validator.validate('https://evil.example.com/payload');
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.code === 'MALICIOUS_URL')).toBe(true);
    expect(result.metadata.reputation?.safeBrowsing).toBe('malicious');
  });

  it('passes clean URLs', async () => {
    const fetchImpl = vi.fn(async () => makeResponse({ body: {} }));
    const validator = new DeliverableValidator({
      safeBrowsingApiKey: 'test-key',
      resolveHostname: publicResolver,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await validator.validate('https://example.com/report.pdf');
    expect(result.valid).toBe(true);
    expect(result.metadata.reputation?.safeBrowsing).toBe('clean');
  });
});

describe('DeliverableValidator — SSRF protection', () => {
  it('blocks hostnames resolving to private IPs', async () => {
    const validator = new DeliverableValidator({
      resolveHostname: privateResolver,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    const result = await validator.validate('https://internal.example.com/x');
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.code === 'SSRF_BLOCKED')).toBe(true);
  });

  it('blocks loopback IP literals', async () => {
    const validator = new DeliverableValidator({
      resolveHostname: publicResolver,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    const result = await validator.validate('https://127.0.0.1/secret');
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.code === 'SSRF_BLOCKED')).toBe(true);
  });

  it('blocks cloud metadata endpoint', async () => {
    const validator = new DeliverableValidator({
      resolveHostname: publicResolver,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    const result = await validator.validate(
      'https://169.254.169.254/latest/meta-data/',
    );
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.code === 'SSRF_BLOCKED')).toBe(true);
  });

  it('blocks localhost hostnames', async () => {
    const validator = new DeliverableValidator({
      resolveHostname: publicResolver,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    const result = await validator.validate('https://localhost/admin');
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.code === 'SSRF_BLOCKED')).toBe(true);
  });

  it('classifies reserved IP ranges correctly', () => {
    expect(isPrivateOrReservedIp('10.1.2.3')).toBe(true);
    expect(isPrivateOrReservedIp('172.16.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('192.168.1.1')).toBe(true);
    expect(isPrivateOrReservedIp('127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedIp('::1')).toBe(true);
    expect(isPrivateOrReservedIp('fd00::1')).toBe(true);
    expect(isPrivateOrReservedIp('fe80::1')).toBe(true);
    expect(isPrivateOrReservedIp('93.184.216.34')).toBe(false);
    expect(isPrivateOrReservedIp('8.8.8.8')).toBe(false);
  });
});

describe('DeliverableValidator — IPFS deliverables', () => {
  const validCidV0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
  const validCidV1 =
    'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

  it('accepts a valid CIDv0 with a safe MIME type and size', async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse({
        headers: {
          'content-type': 'application/pdf',
          'content-length': '1024',
        },
      }),
    );

    const validator = new DeliverableValidator({
      resolveHostname: publicResolver,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await validator.validate(`ipfs://${validCidV0}`);
    expect(result.valid).toBe(true);
    expect(result.metadata.cid).toBe(validCidV0);
    expect(result.metadata.contentType).toBe('application/pdf');
    expect(result.metadata.contentLength).toBe(1024);
  });

  it('accepts a valid CIDv1', async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse({
        headers: {
          'content-type': 'image/png',
          'content-length': '2048',
        },
      }),
    );

    const validator = new DeliverableValidator({
      resolveHostname: publicResolver,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await validator.validate(`ipfs://${validCidV1}`);
    expect(result.valid).toBe(true);
    expect(result.metadata.cid).toBe(validCidV1);
  });

  it('rejects an invalid CID', async () => {
    const validator = new DeliverableValidator({
      resolveHostname: publicResolver,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    const result = await validator.validate('ipfs://not-a-real-cid');
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.code === 'INVALID_CID')).toBe(true);
  });

  it('rejects oversized deliverables', async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse({
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(60 * 1024 * 1024), // 60 MB
        },
      }),
    );

    const validator = new DeliverableValidator({
      resolveHostname: publicResolver,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await validator.validate(`ipfs://${validCidV0}`);
    expect(result.valid).toBe(false);
    expect(
      result.warnings.some((w) => w.code === 'OVERSIZED_DELIVERABLE'),
    ).toBe(true);
  });

  it('rejects disallowed MIME types', async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse({
        headers: {
          'content-type': 'application/x-msdownload',
          'content-length': '1024',
        },
      }),
    );

    const validator = new DeliverableValidator({
      resolveHostname: publicResolver,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await validator.validate(`ipfs://${validCidV0}`);
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.code === 'INVALID_MIME_TYPE')).toBe(
      true,
    );
  });

  it('warns when Content-Length is missing', async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse({ headers: { 'content-type': 'image/jpeg' } }),
    );

    const validator = new DeliverableValidator({
      resolveHostname: publicResolver,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await validator.validate(`ipfs://${validCidV0}`);
    expect(
      result.warnings.some((w) => w.code === 'UNKNOWN_CONTENT_LENGTH'),
    ).toBe(true);
  });

  it('blocks IPFS gateways that resolve to private IPs', async () => {
    const validator = new DeliverableValidator({
      ipfsGateway: 'https://internal-gateway.example.com/ipfs/',
      resolveHostname: privateResolver,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    const result = await validator.validate(`ipfs://${validCidV0}`);
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.code === 'SSRF_BLOCK