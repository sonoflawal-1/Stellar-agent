#!/usr/bin/env bash
# Compare local WASM SHA-256 hashes against deployments/*.json or on-chain hash via stellar CLI.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

IDENTITY_WASM="target/wasm32v1-none/release/agent_identity.wasm"
COMMERCE_WASM="target/wasm32v1-none/release/agentic_commerce.wasm"
DEPLOY_FILE="${1:-deployments/testnet.json}"

hash_file() {
  sha256sum "$1" | awk '{print $1}'
}

if [[ ! -f "$IDENTITY_WASM" || ! -f "$COMMERCE_WASM" ]]; then
  echo "Build WASM first: stellar contract build --optimize" >&2
  exit 1
fi

echo "agent_identity.wasm   $(hash_file "$IDENTITY_WASM")"
echo "agentic_commerce.wasm $(hash_file "$COMMERCE_WASM")"

if [[ -f "$DEPLOY_FILE" ]]; then
  for key in agent_identity agentic_commerce; do
    expected=$(jq -r ".wasm_hashes.${key} // empty" "$DEPLOY_FILE")
    wasm_path="target/wasm32v1-none/release/${key//_/-}.wasm"
    [[ "$key" == "agentic_commerce" ]] && wasm_path="$COMMERCE_WASM"
    [[ "$key" == "agent_identity" ]] && wasm_path="$IDENTITY_WASM"
    if [[ -n "$expected" ]]; then
      actual=$(hash_file "$wasm_path")
      if [[ "$actual" != "$expected" ]]; then
        echo "MISMATCH $key: expected $expected got $actual" >&2
        exit 1
      fi
      echo "OK $key hash matches $DEPLOY_FILE"
    fi
  done
fi