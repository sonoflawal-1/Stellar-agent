import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { Keypair, TransactionBuilder, Networks, StrKey } from "@stellar/stellar-sdk";

/**
 * In-memory nonce storage for challenge-response auth.
 * In production, use Redis or a database with expiration.
 */
const nonceStore = new Map<string, { nonce: string; timestamp: number }>();
const NONCE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CLOCK_SKEW_SECONDS = 300; // Allow 5 minutes clock skew for signature timestamps

/**
 * Generate a random nonce for wallet authentication.
 * Client signs this nonce to prove ownership of their wallet.
 */
export function generateNonce(publicKey: string): string {
  const nonce = crypto.randomBytes(32).toString("hex");
  nonceStore.set(publicKey, { nonce, timestamp: Date.now() });
  // Clean up expired nonces
  for (const [key, value] of nonceStore.entries()) {
    if (Date.now() - value.timestamp > NONCE_EXPIRY_MS) {
      nonceStore.delete(key);
    }
  }
  return nonce;
}

/**
 * Verify a signature proving wallet ownership.
 * The client should sign the nonce with their Freighter wallet.
 *
 * @param publicKey - The signer's public key
 * @param nonce - The challenge nonce (from generateNonce)
 * @param signature - The XDR of a transaction signed by the nonce
 * @returns true if signature is valid and nonce hasn't expired
 */
export function verifyNonceSignature(publicKey: string, nonce: string, signature: string): boolean {
  try {
    // Verify public key format
    if (!StrKey.isValidEd25519PublicKey(publicKey)) {
      return false;
    }

    const storedNonce = nonceStore.get(publicKey);
    if (!storedNonce) {
      return false;
    }

    // Check nonce hasn't expired
    if (Date.now() - storedNonce.timestamp > NONCE_EXPIRY_MS) {
      nonceStore.delete(publicKey);
      return false;
    }

    // Verify nonce matches
    if (storedNonce.nonce !== nonce) {
      return false;
    }

    // Verify the signature by checking if the provided XDR was signed by this publicKey
    try {
      const tx = TransactionBuilder.fromXDR(signature, Networks.TESTNET_NETWORK_PASSPHRASE);
      const keypair = Keypair.fromPublicKey(publicKey);

      // Check if the transaction is signed by the claimed public key
      // by attempting to verify the signature
      const txHash = tx.hash();
      let isValidSignature = false;

      for (const sig of tx.signatures) {
        try {
          // Verify signature using the public key
          if (keypair.verify(txHash, sig.signature())) {
            isValidSignature = true;
            break;
          }
        } catch {
          // Continue to next signature
        }
      }

      if (isValidSignature) {
        // Invalidate this nonce so it can't be reused
        nonceStore.delete(publicKey);
        return true;
      }
    } catch {
      return false;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Session token for authenticated users.
 * Tracks verified wallet ownership.
 */
interface AuthSession {
  publicKey: string;
  timestamp: number;
  expiresAt: number;
}

const SESSION_DURATION_MS = 30 * 60 * 1000; // 30 minutes
const sessionStore = new Map<string, AuthSession>();

/**
 * Create an authenticated session after successful wallet verification.
 */
export function createSession(publicKey: string): string {
  const token = crypto.randomBytes(32).toString("hex");
  sessionStore.set(token, {
    publicKey,
    timestamp: Date.now(),
    expiresAt: Date.now() + SESSION_DURATION_MS,
  });
  return token;
}

/**
 * Verify and get the public key from a session token.
 */
export function verifySession(token: string): string | null {
  const session = sessionStore.get(token);
  if (!session) {
    return null;
  }

  if (Date.now() > session.expiresAt) {
    sessionStore.delete(token);
    return null;
  }

  return session.publicKey;
}

/**
 * Invalidate a session token.
 */
export function invalidateSession(token: string): void {
  sessionStore.delete(token);
}

/**
 * Middleware: Require valid authentication token.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace("Bearer ", "");
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
