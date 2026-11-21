#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const deployment = JSON.parse(fs.readFileSync(path.join(root, "deployments/testnet.json"), "utf8"));

const row = /^\|\s*Agent Identity\s*\|\s*`(C[A-Z0-9]{55})`\s*\|/m;
const row2 = /^\|\s*Agentic Commerce\s*\|\s*`(C[A-Z0-9]{55})`\s*\|/m;
const idMatch = readme.match(row);
const commerceMatch = readme.match(row2);

let failed = false;
if (!idMatch || idMatch[1] !== deployment.agent_identity) {
  console.error("agent_identity mismatch between README and deployments/testnet.json");
  failed = true;
}
if (!commerceMatch || commerceMatch[1] !== deployment.agentic_commerce) {
  console.error("agentic_commerce mismatch between README and deployments/testnet.json");
  failed = true;
}
if (failed) process.exit(1);
console.log("README contract table matches deployments/testnet.json");