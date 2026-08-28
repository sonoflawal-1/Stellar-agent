#!/usr/bin/env node

/**
 * Development server for the Bear landing page.
 * Serves static files (index.html, style.css, app.js, etc.) and the API endpoint.
 *
 * Usage: npm run dev
 * Then visit http://localhost:3001
 */

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3001;

// MIME types
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".xml": "text/xml",
};

// API route handler — reads from deployments/testnet.json
const FALLBACK_CONTRACTS = {
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
    const deploymentsPath = path.join(__dirname, "..", "deployments", "testnet.json");
    const raw = fs.readFileSync(deploymentsPath, "utf-8");
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

function handleApiRequest(req, res) {
  if (req.url === "/api/contract-addresses" && req.method === "GET") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
    res.setHeader("Content-Type", "application/json");

    const live = loadDeployments();
    const contracts = live || FALLBACK_CONTRACTS;

    const response = {
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
      timestamp: new Date().toISOString(),
      status: "ok",
    };

    res.writeHead(200);
    res.end(JSON.stringify(response, null, 2));
    return true;
  }

  return false;
}

// Create HTTP server
const server = http.createServer((req, res) => {
  // Handle preflight CORS
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.writeHead(200);
    res.end();
    return;
  }

  // Try API route first
  if (handleApiRequest(req, res)) {
    return;
  }

  // Serve static files
  let filePath = path.join(__dirname, req.url === "/" ? "index.html" : req.url);

  // Prevent directory traversal
  const realPath = path.resolve(filePath);
  if (!realPath.startsWith(path.resolve(__dirname))) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // File not found — serve branded 404.html
      const notFoundPath = path.join(__dirname, "404.html");
      fs.readFile(notFoundPath, (notFoundErr, notFoundData) => {
        if (notFoundErr) {
          // Fallback plain text 404 if 404.html doesn't exist
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("404 Not Found");
          return;
        }

        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(notFoundData);
      });
      return;
    }

    const ext = path.extname(filePath);
    const mimeType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mimeType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n🐻 Bear landing page dev server running at http://localhost:${PORT}\n`);
});
