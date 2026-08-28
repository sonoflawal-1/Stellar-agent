// Serverless function: GET /api/contract-addresses
// Returns live contract addresses and acts as a simple health check.
// Deployed as a Vercel serverless function alongside the static landing page.
//
// Reads from deployments/testnet.json at runtime.  Falls back to hardcoded
// values if the file is missing (e.g. in a standalone deployment).

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const FALLBACK = {
  agent_identity: {
    address: "CAMPXYFZJTIPEVOPOAZPRG5OHXKNBDPGTPRCOIO4LVPGEM4TONPY65A5",
    explorer:
      "https://stellar.expert/explorer/testnet/contract/CAMPXYFZJTIPEVOPOAZPRG5OHXKNBDPGTPRCOIO4LVPGEM4TONPY65A5",
  },
  agentic_commerce: {
    address: "CD2KWU7IE74Z2QKVP3FQ67J46XHNMGIDTNKXVWE7ZNVRC7T6UH46GQXE",
    explorer:
      "https://stellar.expert/explorer/testnet/contract/CD2KWU7IE74Z2QKVP3FQ67J46XHNMGIDTNKXVWE7ZNVRC7T6UH46GQXE",
  },
};

function loadDeployments() {
  try {
    const deploymentsPath = join(__dirname, "..", "..", "deployments", "testnet.json");
    const raw = readFileSync(deploymentsPath, "utf-8");
    const data = JSON.parse(raw);
    const out = {};
    for (const [key, addr] of Object.entries(data)) {
      if (typeof addr !== "string") continue;
      out[key] = {
        address: addr,
        explorer: `https://stellar.expert/explorer/testnet/contract/${addr}`,
      };
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** @type {import('http').IncomingMessage} req
 *  @type {import('http').ServerResponse} res */
export default function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  // Allow the landing page (same origin) and any deployed frontend to fetch
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
  res.setHeader("Content-Type", "application/json");

  const live = loadDeployments();
  const contracts = live || FALLBACK;

  res.status(200).json({
    network: "testnet",
    contracts: {
      agent_identity: {
        address: "CAMPXYFZJTIPEVOPOAZPRG5OHXKNBDPGTPRCOIO4LVPGEM4TONPY65A5",
        explorer:
          "https://stellar.expert/explorer/testnet/contract/CAMPXYFZJTIPEVOPOAZPRG5OHXKNBDPGTPRCOIO4LVPGEM4TONPY65A5",
      },
      agentic_commerce: {
        address: "CD2KWU7IE74Z2QKVP3FQ67J46XHNMGIDTNKXVWE7ZNVRC7T6UH46GQXE",
        explorer:
          "https://stellar.expert/explorer/testnet/contract/CD2KWU7IE74Z2QKVP3FQ67J46XHNMGIDTNKXVWE7ZNVRC7T6UH46GQXE",
      },
      usdc_sac: {
        address: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        explorer:
          "https://stellar.expert/explorer/testnet/contract/CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      },
    },
    // ISO 8601 timestamp so callers can detect stale responses
    timestamp: new Date().toISOString(),
    status: "ok",
  });
}
