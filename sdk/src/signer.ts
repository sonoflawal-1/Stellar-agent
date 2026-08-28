import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";

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
  signTransaction(
    xdr: string,
    opts: { networkPassphrase: string },
  ): Promise<string>;
}

/** Anything the client methods accept as a signer. */
export type Signer = Keypair | WalletSigner;

/**
 * Adapts a `Keypair` to the `WalletSigner` contract. Used internally by
 * `toSigner`; also handy for callers that want a single stable object type.
 */
export class KeypairSigner implements WalletSigner {
  constructor(private readonly kp: Keypair) {}

  get publicKey(): string {
    return this.kp.publicKey();
  }

  async signTransaction(
    xdr: string,
    opts: { networkPassphrase: string },
  ): Promise<string> {
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
