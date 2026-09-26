import {
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
  type FeeBumpTransaction,
} from "@stellar/stellar-sdk";
import type { Signer } from "./signer.js";
import { IdentityClient } from "./identity.js";
import { CommerceClient } from "./commerce.js";

/**
 * Error thrown when the Freighter browser extension is not available.
 *
 * The message includes a link to the official install page so callers can
 * surface an actionable prompt to end users.
 */
export class FreighterNotInstalledError extends Error {
  /** Official Freighter install page. */
  readonly installUrl = "https://www.freighter.app/";

  constructor(message?: string) {
    super(
      message ??
        `Freighter wallet extension is not installed. Install it from ${new URL(
          "https://www.freighter.app/",
        ).toString()}`,
    );
    this.name = "FreighterNotInstalledError";
  }
}

/**
 * Minimal shape of the `@stellar/freighter-api` module that this SDK relies on.
 * Declared locally so the browser bundle does not hard-depend on the package
 * types at build time (the module is loaded lazily at runtime).
 */
type FreighterApi = {
  isConnected?: () => Promise<boolean> | boolean;
  getPublicKey?: () => Promise<string>;
  getNetwork?: () => Promise<string>;
  signTransaction?: (
    xdr: string,
    opts?: { network?: string; networkPassphrase?: string; accountToSign?: string },
  ) => Promise<string>;
};

let freighterModule: FreighterApi | null = null;

/**
 * Lazily resolve the Freighter API from the global scope or the installed
 * `@stellar/freighter-api` package. Throws {@link FreighterNotInstalledError}
 * when the extension is absent.
 */
async function loadFreighter(): Promise<FreighterApi> {
  if (freighterModule) return freighterModule;

  const globalFreighter = (globalThis as { freighterApi?: FreighterApi })
    .freighterApi;
  if (globalFreighter) {
    freighterModule = globalFreighter;
    return freighterModule;
  }

  try {
    const mod = (await import("@stellar/freighter-api")) as
      | FreighterApi
      | { default: FreighterApi };
    freighterModule = "default" in mod ? mod.default : mod;
    return freighterModule;
  } catch {
    throw new FreighterNotInstalledError();
  }
}

/**
 * A {@link Signer} implementation backed by the Freighter browser extension.
 *
 * Signing is delegated to the extension so private keys never touch the page.
 * The class mirrors the `Keypair`-based signer surface used elsewhere in the
 * SDK, exposing `publicKey()` and `sign()`.
 */
export class FreighterSigner implements Signer {
  private cachedPublicKey?: string;

  constructor(publicKey?: string) {
    this.cachedPublicKey = publicKey;
  }

  /**
   * Resolve the connected account's public key, prompting Freighter for
   * access if necessary.
   */
  async publicKey(): Promise<string> {
    if (this.cachedPublicKey) return this.cachedPublicKey;
    const freighter = await loadFreighter();
    if (!freighter.getPublicKey) {
      throw new FreighterNotInstalledError();
    }
    this.cachedPublicKey = await freighter.getPublicKey();
    return this.cachedPublicKey;
  }

  /**
   * Sign a transaction (or fee-bump transaction) via Freighter. The extension
   * popup is shown to the user for approval.
   */
  async sign(
    transaction: Transaction | FeeBumpTransaction,
    networkPassphrase?: string,
  ): Promise<Transaction | FeeBumpTransaction> {
    const freighter = await loadFreighter();
    if (!freighter.signTransaction) {
      throw new FreighterNotInstalledError();
    }

    const passphrase = networkPassphrase ?? Networks.TESTNET;
    const signedXdr = await freighter.signTransaction(transaction.toXDR(), {
      networkPassphrase: passphrase,
      accountToSign: await this.publicKey(),
    });

    return TransactionBuilder.fromXDR(signedXdr, passphrase);
  }
}

/**
 * Connect to the Freighter extension and return the active account.
 *
 * Detects a network mismatch between the extension and the expected network
 * passphrase and throws a descriptive error when they differ.
 */
export async function connectFreighter(options?: {
  networkPassphrase?: string;
}): Promise<{ publicKey: string; networkPassphrase?: string }> {
  const freighter = await loadFreighter();
  if (!freighter.getPublicKey) {
    throw new FreighterNotInstalledError();
  }

  const publicKey = await freighter.getPublicKey();
  const expected = options?.networkPassphrase;

  if (expected && freighter.getNetwork) {
    const network = await freighter.getNetwork();
    if (network && network !== expected) {
      throw new Error(
        `Freighter network mismatch: extension is on "${network}" but "${expected}" was expected. Switch networks in Freighter and retry.`,
      );
    }
  }

  return { publicKey, networkPassphrase: expected };
}

/**
 * Browser-friendly {@link IdentityClient} that signs transactions with
 * Freighter instead of an in-memory keypair.
 */
export class BrowserIdentityClient extends IdentityClient {
  constructor(
    networkPassphrase: string,
    options?: { contractId?: string; signer?: FreighterSigner },
  ) {
    super(networkPassphrase, {
      contractId: options?.contractId,
      signer: options?.signer ?? new FreighterSigner(),
    });
  }
}

/**
 * Browser-friendly {@link CommerceClient} that signs transactions with
 * Freighter instead of an in-memory keypair.
 */
export class BrowserCommerceClient extends CommerceClient {
  constructor(
    networkPassphrase: string,
    options?: { contractId?: string; signer?: FreighterSigner },
  ) {
    super(networkPassphrase, {
      contractId: options?.contractId,
      signer: options?.signer ?? new FreighterSigner(),
    });
  }
}

/**
 * Convenience helper mirroring the `Keypair` factory used by the Node SDK.
 */
export function freighterSigner(publicKey?: string): FreighterSigner {
  return new FreighterSigner(publicKey);
}

/** Re-export for callers that need the raw keypair type. */
export { Keypair };
