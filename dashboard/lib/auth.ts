import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import {
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  Utils,
} from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// SEP-0010 (Stellar Web Authentication) configuration
// ---------------------------------------------------------------------------

/** The home domain advertised in the challenge transaction (e.g. "marc.finance"). */
const HOME_DOMAIN = process.env.STELLAR_HOME_DOMAIN || "localhost";

/** Network passphrase used to build/verify challenge transactions. */
const NETWORK_PASSPHRASE =
  process.env.STELLAR_NETWORK === "PUBLIC"
    ? Networks.PUBLIC
    : process.env.STELLAR_NETWORK === "FUTURENET"
      ? Networks.FUTURENET
      : Networks.TESTNET;

/** How long a challenge transaction remains valid (SEP-0010 time bounds). */
const CHALLENGE_EXPIRY_SECONDS = 5 * 60; // 5 minutes

/** Maximum allowed clock skew when verifying challenge time bounds. */
const MAX_CLOCK_SKEW_SECONDS = 300; // 5 minutes

/** JWT session lifetime: 24 hours. */
const JWT_EXPIRY_SECONDS = 24 * 60 * 60;

const JWT_SECRET: string =
  process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");

if (!process.env.JWT_SECRET) {
  // eslint-disable-next-line no-console
  console.warn(
    "[auth] JWT_SECRET is not set; using an ephemeral secret. Sessions will not survive restarts.",
  );
}

/**
 * Server signing keypair used to sign SEP-0010 challenge transactions.
 * In production this should be a stable key whose public key is published
 * in the stellar.toml SIGNING_KEY field for the home domain.
 */
const serverKeypair: Keypair = process.env.STELLAR_SERVER_SECRET
  ? Keypair.fromSecret(process.env.STELLAR_SERVER_SECRET)
  : Keypair.random();

// ---------------------------------------------------------------------------
// Challenge store (replay protection)
// ---------------------------------------------------------------------------

interface StoredChallenge {
  /** Full challenge transaction XDR (signed by the server). */
  xdr: string;
  /** The account the challenge was issued to. */
  account: string;
  /** When the challenge was issued (ms since epoch). */
  timestamp: number;
}

const challengeStore = new Map<string, StoredChallenge>();

function cleanupExpiredChallenges(now = Date.now()): void {
  const maxAgeMs = (CHALLENGE_EXPIRY_SECONDS + MAX_CLOCK_SKEW_SECONDS) * 1000;
  for (const [account, challenge] of challengeStore.entries()) {
    if (now - challenge.timestamp > maxAgeMs) {
      challengeStore.delete(account);
    }
  }
}

/**
 * Build a SEP-0010 challenge transaction for the given account.
 *
 * The challenge includes:
 *  - a `manageData` operation with name `<home_domain> auth` and a random nonce
 *  - time bounds (minTime / maxTime) limiting validity
 *  - a sequence number of 0 (required by SEP-0010)
 *  - the server's signature
 *
 * @param publicKey - The client account requesting authentication
 * @returns The base64-encoded challenge transaction envelope XDR
 */
export function buildChallenge(publicKey: string): string {
  if (!StrKey.isValidEd25519PublicKey(publicKey)) {
    throw new Error("Invalid Stellar public key");
  }

  cleanupExpiredChallenges();

  const challengeXdr = Utils.buildChallengeTx(
    serverKeypair,
    publicKey,
    HOME_DOMAIN,
    CHALLENGE_EXPIRY_SECONDS,
    NETWORK_PASSPHRASE,
    HOME_DOMAIN,
  );

  challengeStore.set(publicKey, {
    xdr: challengeXdr,
    account: publicKey,
    timestamp: Date.now(),
  });

  return challengeXdr;
}

/**
 * Verify a client-signed SEP-0010 challenge transaction.
 *
 * Uses `Utils.verifyChallengeTx` which validates:
 *  - the transaction structure and manageData operation
 *  - the home domain and server signing key
 *  - time bounds (expiry) and sequence number (replay protection)
 *  - the client's signature
 *
 * On success the challenge is consumed so it cannot be replayed.
 *
 * @param signedXdr - The base64-encoded signed challenge transaction XDR
 * @returns The authenticated client public key, or null if invalid
 */
export function verifyChallenge(signedXdr: string): string | null {
  try {
    cleanupExpiredChallenges();

    const clientPublicKey = Utils.verifyChallengeTx(
      signedXdr,
      serverKeypair.publicKey(),
      NETWORK_PASSPHRASE,
      HOME_DOMAIN,
      HOME_DOMAIN,
      MAX_CLOCK_SKEW_SECONDS,
    );

    if (!clientPublicKey) {
      return null;
    }

    // Ensure this challenge was actually issued by us and hasn't been used.
    const stored = challengeStore.get(clientPublicKey);
    if (!stored || stored.xdr !== signedXdr) {
      return null;
    }

    // Consume the challenge to prevent replay.
    challengeStore.delete(clientPublicKey);

    return clientPublicKey;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// JWT session tokens
// ---------------------------------------------------------------------------

export interface SessionClaims {
  /** The authenticated Stellar account (G...). */
  publicKey: string;
  /** Unique token id for server-side revocation. */
  jti?: string;
  /** Refresh-token family id (rotation / reuse detection). */
  family?: string;
  /** Issued-at (seconds since epoch). */
  iat: number;
  /** Expiration (seconds since epoch). */
  exp: number;
}

const revokedJtis = new Map<string, number>();
const refreshFamilies = new Map<string, { publicKey: string; activeJti: string }>();
const revokedFamilies = new Set<string>();

function pruneRevokedJtis(nowSec = Math.floor(Date.now() / 1000)): void {
  for (const [jti, exp] of revokedJtis.entries()) {
    if (exp <= nowSec) revokedJtis.delete(jti);
  }
}

function decodeJti(token: string): { jti?: string; exp?: number; family?: string; publicKey?: string } | null {
  const decoded = jwt.decode(token) as SessionClaims | null;
  if (!decoded || typeof decoded !== "object") return null;
  return {
    jti: typeof decoded.jti === "string" ? decoded.jti : undefined,
    exp: typeof decoded.exp === "number" ? decoded.exp : undefined,
    family: typeof decoded.family === "string" ? decoded.family : undefined,
    publicKey: typeof decoded.publicKey === "string" ? decoded.publicKey : undefined,
  };
}

/**
 * Issue a signed JWT session token (24-hour expiry) for an authenticated wallet.
 */
export function createSession(publicKey: string, familyId?: string): string {
  const jti = randomUUID();
  const family = familyId ?? randomUUID();
  refreshFamilies.set(family, { publicKey, activeJti: jti });
  return jwt.sign({ publicKey, jti, family }, JWT_SECRET, {
    expiresIn: JWT_EXPIRY_SECONDS,
    algorithm: "HS256",
  });
}

/**
 * Verify a JWT session token and return the authenticated public key.
 * Returns null if the token is malformed, has an invalid signature, or is expired.
 */
export function verifySession(token: string): string | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ["HS256"],
    }) as SessionClaims;

    if (!decoded || typeof decoded.publicKey !== "string") {
      return null;
    }

    if (!StrKey.isValidEd25519PublicKey(decoded.publicKey)) {
      return null;
    }

    pruneRevokedJtis();
    if (decoded.jti && revokedJtis.has(decoded.jti)) {
      return null;
    }
    if (decoded.family && revokedFamilies.has(decoded.family)) {
      return null;
    }

    return decoded.publicKey;
  } catch {
    return null;
  }
}

/**
 * Invalidate a session token.
 *
 * JWTs are stateless, so this is a no-op retained for API compatibility.
 * Clients should discard the token; short-lived tokens limit exposure.
 */
export function invalidateSession(token: string): void {
  const meta = decodeJti(token);
  if (meta?.jti) {
    revokedJtis.set(meta.jti, meta.exp ?? Math.floor(Date.now() / 1000) + JWT_EXPIRY_SECONDS);
  }
}

/**
 * Refresh a session token with rotation. Reuse of a replaced refresh token revokes the family.
 */
export function refreshSession(token: string): string | null {
  const meta = decodeJti(token);
  if (!meta?.publicKey || !meta.family || !meta.jti) return null;

  if (revokedFamilies.has(meta.family)) return null;

  const family = refreshFamilies.get(meta.family);
  if (!family) {
    return createSession(meta.publicKey, meta.family);
  }

  if (family.activeJti !== meta.jti) {
    revokedFamilies.add(meta.family);
    refreshFamilies.delete(meta.family);
    return null;
  }

  const publicKey = verifySession(token);
  if (!publicKey) return null;

  const next = createSession(publicKey, meta.family);
  const nextMeta = decodeJti(next);
  if (nextMeta?.jti) {
    revokedJtis.set(meta.jti, meta.exp ?? Math.floor(Date.now() / 1000) + JWT_EXPIRY_SECONDS);
    refreshFamilies.set(meta.family, { publicKey, activeJti: nextMeta.jti });
  }
  return next;
}

// ---------------------------------------------------------------------------
// Token transport & CSRF protection (#961)
// ---------------------------------------------------------------------------
//
// SECURITY MODEL: bearer-only token transport.
//
// Session tokens are issued by `/api/auth/token` and MUST be sent in the
// `Authorization: Bearer <token>` header. They are never read from cookies.
// Because the browser does not automatically attach the Authorization header
// to cross-site requests, this model is inherently immune to CSRF.
//
// Cookie-based authentication is explicitly rejected. If a client (or a
// legacy flow) presents an auth cookie, `requireAuth` refuses the request so
// that a misconfigured deployment cannot silently fall back to a transport
// that would be vulnerable to cross-site form POSTs.
//
// For defence in depth, `csrfProtection` can be mounted on mutating routes
// (`/api/jobs/create`, `/api/dispute-job`, `/api/claim-refund`,
// `/api/build/submit`). It rejects any request that carries an auth cookie
// unless a valid double-submit CSRF token is also supplied, and otherwise
// requires bearer-token authentication.

/** Name of the cookie that would carry an auth token, if cookies were used. */
export const AUTH_COOKIE_NAME = "token";

/** Header used for the double-submit CSRF token. */
export const CSRF_HEADER_NAME = "x-csrf-token";

/** Cookie used to store the double-submit CSRF token. */
export const CSRF_COOKIE_NAME = "csrf_token";

/** HTTP methods considered safe (non-mutating) and therefore exempt from CSRF checks. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Parse the request's `Cookie` header into a name/value map.
 */
function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};

  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

/**
 * Returns true if the request carries an authentication cookie.
 *
 * Auth is bearer-only, so the presence of such a cookie indicates either a
 * misconfigured client or an attempted CSRF. Callers should reject the request.
 */
export function hasAuthCookie(req: Request): boolean {
  const cookies = parseCookies(req);
  return Boolean(cookies[AUTH_COOKIE_NAME]);
}

/**
 * Reject cookie-based authentication.
 *
 * Responds with 401 and returns true if an auth cookie was present, so the
 * caller can short-circuit. Returns false when no auth cookie is present.
 */
export function rejectAuthCookie(req: Request, res: Response): boolean {
  if (!hasAuthCookie(req)) return false;
  res.status(401).json({
    error:
      "Cookie-based authentication is not supported. Send the session token in the Authorization: Bearer header.",
  });
  return true;
}

/**
 * Constant-time string comparison to avoid timing side channels.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Middleware factory: CSRF protection for mutating routes.
 *
 * Behaviour:
 *  - Safe methods (GET/HEAD/OPTIONS) pass through untouched.
 *  - If an auth cookie is present, the request is rejected unless a
 *    double-submit CSRF token is supplied: the `x-csrf-token` header must be
 *    present and match the `csrf_token` cookie (constant-time comparison).
 *  - Requests without an auth cookie must authenticate via bearer token;
 *    this is enforced by `requireAuth`, which should be mounted alongside.
 *
 * Usage:
 *   router.post("/api/jobs/create", csrfProtection(), requireAuth, handler);
 */
export function csrfProtection() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    if (hasAuthCookie(req)) {
      const cookies = parseCookies(req);
      const cookieToken = cookies[CSRF_COOKIE_NAME];
      const headerToken = req.headers[CSRF_HEADER_NAME];

      if (
        typeof headerToken !== "string" ||
        !cookieToken ||
        !safeEqual(headerToken, cookieToken)
      ) {
        res.status(403).json({ error: "CSRF token missing or invalid" });
        return;
      }
    }

    next();
  };
}

/**
 * Middleware: Require a valid JWT session token.
 *
 * Tokens are accepted ONLY via the `Authorization: Bearer` header. Requests
 * carrying an auth cookie are rejected (see the security model above).
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (rejectAuthCookie(req, res)) {
    return;
  }

  const authHeader = req.headers.authorization;
  const token =
    typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : undefined;

  if (!token) {
    res.status(401).json({ error: "Missing authentication token" });
    return;
  }

  const publicKey = verifySession(token);
  if (!publicKey) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  // Attach public key to request for later use
  (req as any).walletAddress = publicKey;
  next();
}

/**
 * Middleware: Verify that the wallet in the request matches the authenticated session.
 * Only allows authenticated users to act on their own wallets.
 */
export function requireMatchingWallet(req: Request, res: Response, next: NextFunction): void {
  const walletAddress = (req as any).walletAddress;
  if (!walletAddress) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const requestedWallet = req.body.publicKey || req.body.wallet;
  if (requestedWallet && requestedWallet !== walletAddress) {
    res.status(403).json({ error: "Cannot act on behalf of another wallet" });
    return;
  }

  next();
}
