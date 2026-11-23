/**
 * Minimal re-export shim for marc-stellar-sdk.
 *
 * The full SDK index pulls in marcPaywall / x402 dependencies that are not
 * installed in this package. This shim imports only the modules the dashboard
 * actually uses, keeping startup fast and dependency-free.
 */

// Import directly from the built dist files via the symlink in node_modules.
// Using relative path resolves through the symlink without hitting index.js.
export { IdentityClient } from "marc-stellar-sdk/dist/identity.js";
export { CommerceClient } from "marc-stellar-sdk/dist/commerce.js";
export type { Agent, Job, MarcConfig } from "marc-stellar-sdk/dist/types.js";

/** Testnet defaults (mirrors the hard-coded fallback in types.ts). */
export const TESTNET = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  identityContract: "CAMPXYFZJTIPEVOPOAZPRG5OHXKNBDPGTPRCOIO4LVPGEM4TONPY65A5",
  commerceContract: "CD2KWU7IE74Z2QKVP3FQ67J46XHNMGIDTNKXVWE7ZNVRC7T6UH46GQXE",
  usdcToken: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
};
