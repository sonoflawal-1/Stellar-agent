import { Keypair, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { createHash } from "crypto";

/**
 * A transaction signer for the MARC SDK clients.
 *
 * Two implementations exist:
 * - `Keypair` — Node/demo flows that hold a secret key locally.
 * - `WalletSigner` — browser flows where a wallet extension (Freighter,
 *   Stellar Wallets Kit, …) holds the key and signs an XDR string.
 *
 * Every state-changing client method (`register`, `createJob`, `submit`, …)
 * accepts either form via the `Signer` union, so the same SDK code runs in
 * Node and in the browser.
 */
export interface WalletSigner {
  /** Stellar public key (G…) of the signing account. */
  readonly publicKey: string;

  /**
   * Sign a prepared (simulated) transaction XDR and return the signed XDR
   * as a base64 string.
   *
   * Wallet extensions implement this by delegating to their
   * `signTransaction(xdr, { networkPassphrase })` API.
   */
  signTransaction(xdr: string, opts: { networkPassphrase: string }): Promise<string>;
}

/**
 * A remote signer that produces Stellar signatures without ever holding the
 * raw Ed25519 secret seed in process memory.
 *
 * Implementations (`AwsKmsSigner`, `VaultSigner`) delegate the actual signing
 * operation to a hardware-backed key management service. The private key
 * material never leaves the HSM/KMS boundary; only the transaction hash is
 * sent out and a signature comes back.
 *
 * Structurally identical to `WalletSigner` so it can be used anywhere a
 * `WalletSigner` is accepted.
 */
export interface RemoteSigner extends WalletSigner {
  /** Stellar public key (G…) corresponding to the remote key. */
  readonly publicKey: string;

  /**
   * Sign a prepared (simulated) transaction XDR and return the signed XDR
   * as a base64 string.
   */
  signTransaction(xdr: string, opts: { networkPassphrase: string }): Promise<string>;
}

/** Anything the client methods accept as a signer. */
export type Signer = Keypair | WalletSigner | RemoteSigner;

/**
 * Adapts a `Keypair` to the `WalletSigner` contract. Used internally by
 * `toSigner`; also handy for callers that want a single stable object type.
 */
export class KeypairSigner implements WalletSigner {
  constructor(private readonly kp: Keypair) {}

  get publicKey(): string {
    return this.kp.publicKey();
  }

  async signTransaction(xdr: string, opts: { networkPassphrase: string }): Promise<string> {
    const tx = TransactionBuilder.fromXDR(xdr, opts.networkPassphrase);
    tx.sign(this.kp);
    return tx.toXDR();
  }
}

/**
 * Normalize a `Signer` (Keypair or WalletSigner) to the `WalletSigner`
 * contract. Duck-typed on `signTransaction` so a Keypair originating from a
 * *different* copy of `@stellar/stellar-sdk` (e.g. a consumer app's own
 * node_modules) is still recognized — `instanceof` would miss those.
 */
export function toSigner(signer: Signer): WalletSigner {
  if (typeof (signer as WalletSigner).signTransaction === "function") {
    return signer as WalletSigner;
  }
  return new KeypairSigner(signer as Keypair);
}

/** Get the public key from either signer form. */
export function signerPublicKey(signer: Signer): string {
  if (typeof (signer as WalletSigner).publicKey === "string") {
    return (signer as WalletSigner).publicKey;
  }
  return (signer as Keypair).publicKey();
}

/**
 * Checks whether a string is a validly-formatted Ed25519 Stellar secret seed
 * (i.e. starts with `S` and passes the StrKey checksum), without attempting
 * to construct a `Keypair` from it.
 */
export function isValidSecretKey(secretKey: string): boolean {
  if (typeof secretKey !== "string" || secretKey.length === 0) return false;
  return StrKey.isValidEd25519SecretSeed(secretKey);
}

/**
 * Builds a `Keypair` from a secret seed string, validating the format first
 * so callers get a clean, descriptive error instead of an SDK-internal one.
 *
 * @throws {Error} "Invalid Stellar secret key format" when `secretKey` isn't
 * a valid Ed25519 secret seed.
 */
export function createKeypairFromSecret(secretKey: string): Keypair {
  if (!isValidSecretKey(secretKey)) {
    throw new Error("Invalid Stellar secret key format");
  }
  return Keypair.fromSecret(secretKey);
}

/** Convenience wrapper around `Keypair.random()` for a fresh, funded-later account. */
export function generateRandomKeypair(): Keypair {
  return Keypair.random();
}

// ---------------------------------------------------------------------------
// Remote signing (issue #727)
// ---------------------------------------------------------------------------

/**
 * Minimal shape of the AWS KMS client we depend on. Declared structurally so
 * the SDK does not take a hard dependency on `@aws-sdk/client-kms`; callers
 * pass a real `KMSClient` (or a mock in tests).
 */
export interface AwsKmsClientLike {
  send(command: unknown): Promise<unknown>;
}

/** Minimal shape of the AWS KMS `SignCommand` constructor we depend on. */
export interface AwsKmsSignCommandLike {
  new (input: {
    KeyId: string;
    Message: Uint8Array;
    MessageType: "RAW" | "DIGEST";
    SigningAlgorithm: string;
  }): unknown;
}

export interface AwsKmsSignerOptions {
  /** AWS KMS client instance (e.g. `new KMSClient({ region })`). */
  client: AwsKmsClientLike;
  /** KMS key id, ARN, or alias for an asymmetric Ed25519 key. */
  keyId: string;
  /** Stellar public key (G…) that corresponds to the KMS key. */
  publicKey: string;
  /** KMS `SignCommand` constructor (e.g. `import { SignCommand } from "@aws-sdk/client-kms"`). */
  SignCommand: AwsKmsSignCommandLike;
  /** Signing algorithm; defaults to `"ED25519_SHA_512"` (AWS KMS Ed25519). */
  signingAlgorithm?: string;
}

/**
 * Signs Stellar transactions using an Ed25519 key held in AWS KMS.
 *
 * The transaction hash is computed locally, sent to KMS via the `Sign` API,
 * and the returned raw signature is attached to the transaction. The private
 * key never enters process memory.
 *
 * @example
 * ```ts
 * import { KMSClient, SignCommand } from "@aws-sdk/client-kms";
 * const signer = new AwsKmsSigner({
 *   client: new KMSClient({ region: "us-east-1" }),
 *   keyId: "alias/stellar-agent",
 *   publicKey: process.env.AGENT_PUBLIC_KEY!,
 *   SignCommand,
 * });
 * ```
 */
export class AwsKmsSigner implements RemoteSigner {
  readonly publicKey: string;
  private readonly client: AwsKmsClientLike;
  private readonly keyId: string;
  private readonly SignCommand: AwsKmsSignCommandLike;
  private readonly signingAlgorithm: string;

  constructor(opts: AwsKmsSignerOptions) {
    if (!opts || !opts.client || !opts.keyId || !opts.publicKey || !opts.SignCommand) {
      throw new Error("AwsKmsSigner requires client, keyId, publicKey and SignCommand");
    }
    if (!StrKey.isValidEd25519PublicKey(opts.publicKey)) {
      throw new Error("AwsKmsSigner: publicKey is not a valid Stellar public key");
    }
    this.client = opts.client;
    this.keyId = opts.keyId;
    this.publicKey = opts.publicKey;
    this.SignCommand = opts.SignCommand;
    this.signingAlgorithm = opts.signingAlgorithm ?? "ED25519_SHA_512";
  }

  async signTransaction(xdr: string, opts: { networkPassphrase: string }): Promise<string> {
    const tx = TransactionBuilder.fromXDR(xdr, opts.networkPassphrase);
    const hash = tx.hash();

    let signature: Uint8Array;
    try {
      const response = (await this.client.send(
        new this.SignCommand({
          KeyId: this.keyId,
          Message: hash,
          MessageType: "DIGEST",
          SigningAlgorithm: this.signingAlgorithm,
        }),
      )) as { Signature?: Uint8Array };

      if (!response || !response.Signature) {
        throw new Error("empty response");
      }
      signature = response.Signature;
    } catch (err) {
      // Never surface the raw error object: KMS errors can echo request
      // metadata. Emit a stable, secret-free message instead.
      const name = (err as { name?: string })?.name ?? "KmsError";
      throw new Error(`AwsKmsSigner: KMS signing failed (${name})`);
    }

    // Attach the raw 64-byte Ed25519 signature to the transaction envelope.
    // `addSignature` expects the base64-encoded signature.
    const b64 = Buffer.from(signature).toString("base64");
    (tx as unknown as { addSignature(publicKey: string, sig: string): void }).addSignature(
      this.publicKey,
      b64,
    );
    return tx.toXDR();
  }
}

/**
 * Minimal shape of the HashiCorp Vault client we depend on. Declared
 * structurally so the SDK does not take a hard dependency on `node-vault`.
 */
export interface VaultClientLike {
  write(path: string, data: Record<string, unknown>): Promise<unknown>;
}

export interface VaultSignerOptions {
  /** Vault client instance (e.g. `vault({ endpoint, token })`). */
  client: VaultClientLike;
  /** Transit engine mount path; defaults to `"transit"`. */
  mountPath?: string;
  /** Name of the Transit key (must be an `ed25519` key). */
  keyName: string;
  /** Stellar public key (G…) that corresponds to the Vault key. */
  publicKey: string;
}

/**
 * Signs Stellar transactions using a HashiCorp Vault Transit `ed25519` key.
 *
 * The transaction hash is base64-encoded and sent to
 * `transit/sign/<key>`, and the returned signature is attached to the
 * transaction. The private key never leaves Vault.
 */
export class VaultSigner implements RemoteSigner {
  readonly publicKey: string;
  private readonly client: VaultClientLike;
  private readonly mountPath: string;
  private readonly keyName: string;

  constructor(opts: VaultSignerOptions) {
    if (!opts || !opts.client || !opts.keyName || !opts.publicKey) {
      throw new Error("VaultSigner requires client, keyName and publicKey");
    }
    if (!StrKey.isValidEd25519PublicKey(opts.publicKey)) {
      throw new Error("VaultSigner: publicKey is not a valid Stellar public key");
    }
    this.client = opts.client;
    this.mountPath = opts.mountPath ?? "transit";
    this.keyName = opts.keyName;
    this.publicKey = opts.publicKey;
  }

  async signTransaction(xdr: string, opts: { networkPassphrase: string }): Promise<string> {
    const tx = TransactionBuilder.fromXDR(xdr, opts.networkPassphrase);
    const hash = tx.hash();
    const input = Buffer.from(hash).toString("base64");

    let signature: Uint8Array;
    try {
      const response = (await this.client.write(`${this.mountPath}/sign/${this.keyName}`, {
        input,
        hash_algorithm: "none",
        signature_algorithm: "ed25519",
      })) as { data?: { signature?: string } };

      const sig = response?.data?.signature;
      if (!sig) {
        throw new Error("empty response");
      }
      // Vault returns `vault:v1:<base64>`; strip the prefix.
      const raw = sig.startsWith("vault:") ? sig.split(":").slice(2).join(":") : sig;
      signature = Buffer.from(raw, "base64");
    } catch (err) {
      const name = (err as { name?: string })?.name ?? "VaultError";
      throw new Error(`VaultSigner: Vault signing failed (${name})`);
    }

    const b64 = Buffer.from(signature).toString("base64");
    (tx as unknown as { addSignature(publicKey: string, sig: string): void }).addSignature(
      this.publicKey,
      b64,
    );
    return tx.toXDR();
  }
}

/**
 * Computes the SHA-256 hash of a Stellar transaction envelope XDR. Exposed
 * for remote signers that need to sign the digest directly.
 */
export function transactionHash(xdr: string, networkPassphrase: string): Buffer {
  const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  return Buffer.from(tx.hash());
}

/** @internal re-exported for tests that need a stable hash helper. */
export const _sha256 = (data: Uint8Array): Buffer => createHash("sha256").update(data).digest();
