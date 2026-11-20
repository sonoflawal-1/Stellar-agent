#!/usr/bin/env bash
set -euo pipefail

# Deploys agent_identity + agentic_commerce to Stellar testnet.
#
# Prereqs:
#   - stellar CLI 25.x
#   - A configured identity named "deployer" on testnet, funded by friendbot:
#       stellar keys generate deployer --network testnet --fund
#
# Output:
#   - target/wasm32v1-none/release/{agent_identity,agentic_commerce}.wasm (optimized in place)
#   - deployments/testnet.json with the deployed contract addresses

# Network name and RPC URL are parameterizable so the docker-compose init
# service can target the local standalone network, e.g.:
#   scripts/deploy-testnet.sh --network local --rpc-url http://soroban-rpc:8000/soroban/rpc
# Defaults preserve the original testnet behaviour.
NETWORK="testnet"
RPC_URL=""
IDENTITY="deployer"
OUT_DIR="deployments"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network)
      NETWORK="$2"
      shift 2
      ;;
    --rpc-url)
      RPC_URL="$2"
      shift 2
      ;;
    --identity)
      IDENTITY="$2"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="$2"
      shift 2
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

OUT_FILE="$OUT_DIR/$NETWORK.json"

# Build the common `--network` / `--rpc-url` flags for stellar CLI invocations.
NETWORK_FLAGS=(--network "$NETWORK")
if [[ -n "$RPC_URL" ]]; then
  NETWORK_FLAGS+=(--rpc-url "$RPC_URL")
fi

IDENTITY_WASM="target/wasm32v1-none/release/agent_identity.wasm"
COMMERCE_WASM="target/wasm32v1-none/release/agentic_commerce.wasm"

mkdir -p "$OUT_DIR"

echo "==> Building + optimizing contracts (stellar contract build --optimize)"
# 25.x: `build --optimize` builds, optimizes, and writes the wasm in-place.
# The deprecated `stellar contract optimize` command is NOT used here —
# see CLAUDE.md "Gotchas learned".
stellar contract build --optimize

if [[ ! -f "$IDENTITY_WASM" ]]; then
  echo "ERROR: expected optimized wasm at $IDENTITY_WASM" >&2
  exit 1
fi
if [[ ! -f "$COMMERCE_WASM" ]]; then
  echo "ERROR: expected optimized wasm at $COMMERCE_WASM" >&2
  exit 1
fi

ADMIN=$(stellar keys address "$IDENTITY")
echo "==> Deployer address: $ADMIN"

IDENTITY_HASH=$(sha256sum "$IDENTITY_WASM" | awk '{print $1}')
COMMERCE_HASH=$(sha256sum "$COMMERCE_WASM" | awk '{print $1}')
echo "    agent_identity.wasm sha256   = $IDENTITY_HASH"
echo "    agentic_commerce.wasm sha256 = $COMMERCE_HASH"

IDENTITY_ADDR=""
COMMERCE_ADDR=""
if [[ -f "$OUT_FILE" ]]; then
  IDENTITY_ADDR=$(jq -r '.agent_identity // empty' "$OUT_FILE")
  COMMERCE_ADDR=$(jq -r '.agentic_commerce // empty' "$OUT_FILE")
  EXISTING_ID_HASH=$(jq -r '.wasm_hashes.agent_identity // empty' "$OUT_FILE")
  EXISTING_CM_HASH=$(jq -r '.wasm_hashes.agentic_commerce // empty' "$OUT_FILE")
  if [[ -n "$IDENTITY_ADDR" && -n "$COMMERCE_ADDR" && "$EXISTING_ID_HASH" == "$IDENTITY_HASH" && "$EXISTING_CM_HASH" == "$COMMERCE_HASH" ]]; then
    echo "==> Existing deployment matches WASM hashes; skipping redeploy"
  else
    IDENTITY_ADDR=""
    COMMERCE_ADDR=""
  fi
fi

if [[ -z "$IDENTITY_ADDR" ]]; then
  echo "==> Deploying agent_identity"
  IDENTITY_ADDR=$(stellar contract deploy \
    --source-account "$IDENTITY" \
    "${NETWORK_FLAGS[@]}" \
    --wasm "$IDENTITY_WASM")
  echo "    agent_identity   = $IDENTITY_ADDR"
fi

if [[ -z "$COMMERCE_ADDR" ]]; then
  echo "==> Deploying agentic_commerce"
  COMMERCE_ADDR=$(stellar contract deploy \
    --source-account "$IDENTITY" \
    "${NETWORK_FLAGS[@]}" \
    --wasm "$COMMERCE_WASM")
  echo "    agentic_commerce = $COMMERCE_ADDR"
fi

echo "==> Initializing agentic_commerce (admin=treasury=$ADMIN)"
stellar contract invoke \
  --source-account "$IDENTITY" \
  "${NETWORK_FLAGS[@]}" \
  --id "$COMMERCE_ADDR" \
  -- init --admin "$ADMIN" --treasury "$ADMIN"

cat > "$OUT_FILE" <<EOF
{
  "network": "$NETWORK",
  "rpc_url": "$RPC_URL",
  "deployer": "$ADMIN",
  "agent_identity": "$IDENTITY_ADDR",
  "agentic_commerce": "$COMMERCE_ADDR",
  "wasm_hashes": {
    "agent_identity": "$IDENTITY_HASH",
    "agentic_commerce": "$COMMERCE_HASH"
  },
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
echo "==> Wrote $OUT_FILE"

# When targeting the local standalone network, also export the deployed
# addresses to .env.docker so the dashboard and agents can consume them.
if [[ "$NETWORK" == "local" ]]; then
  ENV_FILE=".env.docker"
  echo "==> Updating $ENV_FILE with local deployment addresses"
  touch "$ENV_FILE"
  # Drop any previous values so re-runs stay idempotent.
  if [[ -s "$ENV_FILE" ]]; then
    grep -v -E '^(AGENT_IDENTITY_CONTRACT|AGENTIC_COMMERCE_CONTRACT|SOROBAN_RPC_URL|STELLAR_NETWORK)=' \
      "$ENV_FILE" > "$ENV_FILE.tmp" || true
    mv "$ENV_FILE.tmp" "$ENV_FILE"
  fi
  {
    echo "STELLAR_NETWORK=$NETWORK"
    echo "SOROBAN_RPC_URL=${RPC_URL:-http://soroban-rpc:8000/soroban/rpc}"
    echo "AGENT_IDENTITY_CONTRACT=$IDENTITY_ADDR"
    echo "AGENTIC_COMMERCE_CONTRACT=$COMMERCE_ADDR"
  } >> "$ENV_FILE"
  echo "==> Wrote local deployment addresses to $ENV_FILE"
fi

echo "==> Done."
