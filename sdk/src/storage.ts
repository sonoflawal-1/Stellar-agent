/**
 * Storage client for the Agent SDK.
 *
 * Provides persistent pinning of agent metadata and job deliverables to
 * decentralized storage networks (IPFS via Pinata / Web3.Storage, and Arweave
 * via Irys). Uploaded content is verified by fetching it back and comparing
 * SHA-256 hashes, and uploads fall back across multiple gateways if the primary
 * service is unavailable.
 */

import { createHash } from 'crypto';

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

/** Result of a successful upload to a storage provider. */
export interface StorageUploadResult {
  /** Permanent, resolvable URI for the uploaded content (ipfs:// or ar://). */
  uri: string;
  /** Gateway-resolvable HTTP URL for the uploaded content. */
  url: string;
  /** SHA-256 hash (hex) of the uploaded content. */
  sha256: string;
  /** Deterministic content identifier (CIDv1 for IPFS, tx id for Arweave). */
  cid: string;
  /** Provider that performed the upload. */
  provider: string;
  /** Size of the uploaded content in bytes. */
  size: number;
  /** Whether the content was verified by fetching it back. */
  verified: boolean;
}

/** Options accepted by upload methods. */
export interface StorageUploadOptions {
  /** Optional file name / metadata name. */
  name?: string;
  /** Optional MIME type. */
  contentType?: string;
  /** Optional key/value metadata forwarded to the provider. */
  metadata?: Record<string, string>;
  /** Skip the fetch-back verification step. Defaults to false. */
  skipVerification?: boolean;
}

/** Common interface implemented by all storage providers. */
export interface StorageProvider {
  /** Human-readable provider name. */
  readonly name: string;
  /** Upload a JSON-serializable value. */
  uploadJson(data: unknown, options?: StorageUploadOptions): Promise<StorageUploadResult>;
  /** Upload a raw buffer. */
  uploadBuffer(buffer: Buffer | Uint8Array, options?: StorageUploadOptions): Promise<StorageUploadResult>;
}

/** Configuration for the Pinata IPFS provider. */
export interface PinataConfig {
  /** Pinata JWT (preferred) or API key. */
  jwt?: string;
  /** Pinata API key (legacy). */
  apiKey?: string;
  /** Pinata API secret (legacy). */
  apiSecret?: string;
  /** Pinata API base URL. Defaults to https://api.pinata.cloud. */
  apiUrl?: string;
  /** Gateway base URLs used for fetch-back verification and fallback. */
  gateways?: string[];
  /** Request timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number;
  /** Custom fetch implementation (defaults to global fetch). */
  fetch?: typeof fetch;
}

/** Configuration for the Arweave (Irys) provider. */
export interface ArweaveConfig {
  /** Irys private key (base64 or hex encoded). */
  privateKey?: string;
  /** Irys node URL. Defaults to https://node2.irys.xyz. */
  nodeUrl?: string;
  /** Arweave gateway base URLs used for fetch-back verification and fallback. */
  gateways?: string[];
  /** Request timeout in milliseconds. Defaults to 60000. */
  timeoutMs?: number;
  /** Custom fetch implementation (defaults to global fetch). */
  fetch?: typeof fetch;
}

/** Configuration for the multi-provider fallback storage client. */
export interface FallbackStorageConfig {
  /** Ordered list of providers; the first is primary. */
  providers: StorageProvider[];
  /** Whether to verify content after upload. Defaults to true. */
  verify?: boolean;
}

/* -------------------------------------------------------------------------- */
/*                                   Errors                                   */
/* -------------------------------------------------------------------------- */

/** Error thrown when all configured gateways/providers fail. */
export class StorageError extends Error {
  readonly attempts: Array<{ target: string; error: string }>;

  constructor(message: string, attempts: Array<{ target: string; error: string }> = []) {
    super(message);
    this.name = 'StorageError';
    this.attempts = attempts;
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

const DEFAULT_IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs',
  'https://cloudflare-ipfs.com/ipfs',
  'https://gateway.pinata.cloud/ipfs',
  'https://dweb.link/ipfs',
];

const DEFAULT_ARWEAVE_GATEWAYS = [
  'https://arweave.net',
  'https://gateway.irys.xyz',
];

/** Compute the SHA-256 hash (hex) of a buffer. */
export function sha256(buffer: Buffer | Uint8Array): string {
  return createHash('sha256').update(Buffer.from(buffer)).digest('hex');
}

/** Normalize a buffer-like input to a Buffer. */
function toBuffer(input: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(input) ? input : Buffer.from(input);
}

/** Serialize JSON deterministically (stable key ordering). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortValue(obj[key]);
    }
    return sorted;
  }
  return value;
}

/** Serialize JSON data to a buffer. */
export function jsonToBuffer(data: unknown): Buffer {
  return Buffer.from(stableStringify(data), 'utf8');
}

/* -------------------------------------------------------------------------- */
/*                          Deterministic CIDv1 (IPFS)                        */
/* -------------------------------------------------------------------------- */

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32 (lowercase, no padding) encoding. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/** Encode a varint (unsigned LEB128). */
function encodeVarint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

/**
 * Compute a deterministic IPFS CIDv1 for the given content.
 *
 * Uses the raw codec (0x55) and sha2-256 multihash (0x12), producing a
 * `bafkrei...` style CIDv1 string. This matches the CID that IPFS would
 * produce for the same bytes when using the raw codec, so it can be computed
 * before upload.
 */
export function computeCidV1(buffer: Buffer | Uint8Array): string {
  const bytes = toBuffer(buffer);
  const digest = createHash('sha256').update(bytes).digest();

  const multihash = [
    ...encodeVarint(0x12), // sha2-256
    ...encodeVarint(digest.length),
    ...digest,
  ];

  const cidBytes = [
    ...encodeVarint(0x01), // CIDv1
    ...encodeVarint(0x55), // raw codec
    ...multihash,
  ];

  return 'b' + base32Encode(Uint8Array.from(cidBytes));
}

/* -------------------------------------------------------------------------- */
/*                              Gateway fallback                              */
/* -------------------------------------------------------------------------- */

/** Build an HTTP URL for an IPFS CID against a gateway base. */
export function ipfsGatewayUrl(cid: string, gateway: string): string {
  const base = gateway.replace(/\/+$/, '');
  return `${base}/${cid}`;
}

/** Build an HTTP URL for an Arweave transaction id against a gateway base. */
export function arweaveGatewayUrl(txId: string, gateway: string): string {
  const base = gateway.replace(/\/+$/, '');
  return `${base}/${txId}`;
}

/**
 * Fetch content from the first gateway that responds successfully.
 * Tries each gateway in order and returns the first successful response body.
 */
export async function fetchWithFallback(
  urls: string[],
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 30000,
): Promise<{ url: string; buffer: Buffer }> {
  const attempts: Array<{ target: string; error: string }> = [];

  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, { signal: controller.signal });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        const arrayBuffer = await res.arrayBuffer();
        return { url, buffer: Buffer.from(arrayBuffer) };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      attempts.push({ target: url, error: (err as Error).message });
    }
  }

  throw new StorageError(
    `Failed to fetch content from any gateway (${attempts.length} attempts)`,
    attempts,
  );
}

/**
 * Verify uploaded content by fetching it back from the given URLs and
 * comparing the SHA-256 hash against the expected value.
 */
export async function verifyUpload(
  urls: string[],
  expectedSha256: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 30000,
): Promise<{ verified: boolean; url: string; actualSha256: string }> {
  const { url, buffer } = await fetchWithFallback(urls, fetchImpl, timeoutMs);
  const actualSha256 = sha256(buffer);
  return {
    verified: actualSha256 === expectedSha256,
    url,
    actualSha256,
  };
}

/* -------------------------------------------------------------------------- */
/*                            Pinata IPFS provider                            */
/* -------------------------------------------------------------------------- */

export class PinataStorageProvider implements StorageProvider {
  readonly name = 'pinata';

  private readonly jwt?: string;
  private readonly apiKey?: string;
  private readonly apiSecret?: string;
  private readonly apiUrl: string;
  private readonly gateways: string[];
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: PinataConfig = {}) {
    this.jwt = config.jwt ?? process.env.PINATA_JWT;
    this.apiKey = config.apiKey ?? process.env.PINATA_API_KEY;
    this.apiSecret = config.apiSecret ?? process.env.PINATA_API_SECRET;
    this.apiUrl = (config.apiUrl ?? 'https://api.pinata.cloud').replace(/\/+$/, '');
    this.gateways = config.gateways ?? DEFAULT_IPFS_GATEWAYS;
    this.timeoutMs = config.timeoutMs ?? 30000;
    this.fetchImpl = config.fetch ?? fetch;

    if (!this.jwt && !(this.apiKey && this.apiSecret)) {
      throw new StorageError(
        'PinataStorageProvider requires a JWT (PINATA_JWT) or API key/secret (PINATA_API_KEY/PINATA_API_SECRET)',
      );
    }
  }

  async uploadJson(data: unknown, options: StorageUploadOptions = {}): Promise<StorageUploadResult> {
    const buffer = jsonToBuffer(data);
    return this.uploadBuffer(buffer, {
      contentType: 'application/json',
      name: options.name ?? 'metadata.json',
      ...options,
    });
  }

  async uploadBuffer(
    input: Buffer | Uint8Array,
    options: StorageUploadOptions = {},
  ): Promise<StorageUploadResult> {
    const buffer = toBuffer(input);
    const hash = sha256(buffer);
    const cid = computeCidV1(buffer);

    const form = new FormData();
    const blob = new Blob([buffer], {
      type: options.contentType ?? 'application/octet-stream',
    });
    form.append('file', blob, options.name ?? `${cid}.bin`);

    const pinataMetadata = {
      name: options.name ?? cid,
      ...(options.metadata ? { keyvalues: options.metadata } : {}),
    };
    form.append('pinataMetadata', JSON.stringify(pinataMetadata));
    form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiUrl}/pinning/pinFileToIPFS`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: form,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new StorageError(`Pinata upload failed: HTTP ${res.status} ${text}`);
    }

    const json = (await res.json()) as { IpfsHash?: string };
    const returnedCid = json.IpfsHash ?? cid;
    const uri = `ipfs://${returnedCid}`;
    const urls = this.gateways.map((g) => ipfsGatewayUrl(returnedCid, g));

    let verified = false;
    let url = urls[0] ?? ipfsGatewayUrl(returnedCid, DEFAULT_IPFS_GATEWAYS[0]);
    if (!options.skipVerification) {
      try {
        const result = await verifyUpload(urls, hash, this.fetchImpl, this.timeoutMs);
        verified = result.verified;
        url = result.url;
        if (!result.verified) {
          throw new StorageError(
            `Pinata verification failed: expected ${hash}, got ${result.actualSha256}`,
          );
        }
      } catch (err) {
        if (err instanceof StorageError) throw err;
        throw new StorageError(`Pinata verification failed: ${(err as Error).message}`);
      }
    }

    return {
      uri,
      url,
      sha256: hash,
      cid: returnedCid,
      provider: this.name,
      size: buffer.length,
      verified,
    };
  }

  private authHeaders(): Record<string, string> {
    if (this.jwt) {
      return { Authorization: `Bearer ${this.jwt}` };
    }
    return {
      pinata_api_key: this.apiKey as string,
      pinata_secret_api_key: this.apiSecret as string,
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                          Arweave (Irys) provider                           */
/* -------------------------------------------------------------------------- */

export class ArweaveStorageProvider implements StorageProvider {
  readonly name = 'arweave';

  private readonly privateKey?: string;
  private readonly nodeUrl: string;
  private readonly gateways: string[];
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ArweaveConfig = {}) {
    this.privateKey = config.privateKey ?? process.env.IRYS_PRIVATE_KEY ?? process.env.ARWEAVE_PRIVATE_KEY;
    this.nodeUrl = (config.nodeUrl ?? 'https://node2.irys.xyz').replace(/\/+$/, '');
    this.gateways = config.gateways ?? DEFAULT_ARWEAVE_GATEWAYS;
    this.timeoutMs = config.timeoutMs ?? 60000;
    this.fetchImpl = config.fetch ?? fetch;

    if (!this.privateKey) {
      throw new StorageError(
        'ArweaveStorageProvider requires a private key (IRYS_PRIVATE_KEY or ARWEAVE_PRIVATE_KEY)',
      );
    }
  }

  async uploadJson(data: unknown, options: StorageUploadOptions = {}): Promise<StorageUploadResult> {
    const buffer = jsonToBuffer(data);
    return this.uploadBuffer(buffer, {
      contentType: 'application/json',
      name: options.name ?? 'metadata.json',
      ...options,
    });
  }

  async uploadBuffer(
    input: Buffer | Uint8Array,
    options: StorageUploadOptions = {},
  ): Promise<StorageUploadResult> {
    const buffer = toBuffer(input);
    const hash = sha256(buffer);
    const cid = computeCidV1(buffer);

    const tags = [
      { name: 'Content-Type', value: options.contentType ?? 'application/octet-stream' },
      { name: 'App-Name', value: 'agent-sdk' },
      ...(options.name ? [{ name: 'File-Name', value: options.name }] : []),
      ...Object.entries(options.metadata ?? {}).map(([name, value]) => ({ name, value })),
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.nodeUrl}/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          Authorization: `Bearer ${this.privateKey}`,
          'X-Irys-Tags': Buffer.from(JSON.stringify(tags), 'utf8').toString('base64'),
        },
        body: buffer,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new StorageError(`Arweave upload failed: HTTP ${res.status} ${text}`);
    }

    const json = (await res.json()) as { id?: string };
    const txId = json.id;
    if (!txId) {
      throw new StorageError('Arweave upload failed: missing transaction id in response');
    }

    const uri = `ar://${txId}`;
    const urls = this.gateways.map((g) => arweaveGatewayUrl(txId, g));

    let verified = false;
    let url = urls[0] ?? arweaveGatewayUrl(txId, DEFAULT_ARWEAVE_GATEWAYS[0]);
    if (!options.skipVerification) {
      try {
        const result = await verifyUpload(urls, hash, this.fetchImpl, this.timeoutMs);
        verified = result.verified;
        url = result.url;
        if (!result.verified) {
          throw new StorageError(
            `Arweave verification failed: expected ${hash}, got ${result.actualSha256}`,
          );
        }
      } catch (err) {
        if (err instanceof StorageError) throw err;
        throw new StorageError(`Arweave verification failed: ${(err as Error).message}`);
      }
    }

    return {
      uri,
      url,
      sha256: hash,
      cid: txId,
      provider: this.name,
      size: buffer.length,
      verified,
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                        Multi-provider fallback client                      */
/* -------------------------------------------------------------------------- */

/**
 * Storage client that tries each configured provider in order until one
 * succeeds, providing fallback between multiple pinning services.
 */
export class FallbackStorageProvider implements StorageProvider {
  readonly name = 'fallback';

  private readonly providers: StorageProvider[];
  private readonly verify: boolean;

  constructor(config: FallbackStorageConfig) {
    if (!config.providers || config.providers.length === 0) {
      throw new StorageError('FallbackStorageProvider requires at least one provider');
    }
    this.providers = config.providers;
    this.verify = config.verify ?? true;
  }

  async uploadJson(data: unknown, options: StorageUploadOptions = {}): Promise<StorageUploadResult> {
    return this.run((p) => p.uploadJson(data, options));
  }

  async uploadBuffer(
    input: Buffer | Uint8Array,
    options: StorageUploadOptions = {},
  ): Promise<StorageUploadResult> {
    return this.run((p) => p.uploadBuffer(input, options));
  }

  private async run(
    fn: (provider: StorageProvider) => Promise<StorageUploadResult>,
  ): Promise<StorageUploadResult> {
    const attempts: Array<{ target: string; error: string }> = [];
    for (const provider of this.providers) {
      try {
        return await fn(provider);
      } catch (err) {
        attempts.push({ target: provider.name, error: (err as Error).message });
      }
    }
    throw new StorageError(
      `All storage providers failed (${attempts.length} attempts)`,
      attempts,
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                              Factory helper                                */
/* -------------------------------------------------------------------------- */

/** Options for {@link createStorageProvider}. */
export interface CreateStorageProviderOptions {
  /** Provider type. */
  type: 'pinata' | 'arweave' | 'fallback';
  /** Pinata configuration (when type is 'pinata'). */
  pinata?: PinataConfig;
  /** Arweave configuration (when type is 'arweave'). */
  arweave?: ArweaveConfig;
  /** Providers for fallback mode (when type is 'fallback'). */
  providers?: StorageProvider[];
}

/**
 * Create a storage provider from configuration. When `type` is 'fallback',
 * the provided `providers` list is used; otherwise a single provider is built.
 */
export function createStorageProvider(options: CreateStorageProviderOptions): StorageProvider {
  switch (options.type) {
    case 'pinata':
      return new PinataStorageProvider(options.pinata);
    case 'arweave':
      return new ArweaveStorageProvider(options.arweave);
    case 'fallback':
      return new FallbackStorageProvider({ providers: options.providers ?? [] });
    default:
      throw new StorageError(`Unknown storage provider type: ${(options as { type: string }).type}`);
  }
}