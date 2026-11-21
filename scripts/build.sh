#!/usr/bin/env bash
set -euo pipefail

CLEAN=0
OFFLINE=0
WASM_TARGET="${WASM_TARGET:-wasm32-unknown-unknown}"
for arg in "$@"; do
  case "$arg" in
    --clean)
      CLEAN=1
      ;;
    --offline)
      OFFLINE=1
      ;;
    --target=*)
      WASM_TARGET="${arg#--target=}"
      ;;
    --target)
      echo "ERROR: --target requires a value (e.g. --target=wasm32-unknown-unknown)"
      exit 1
      ;;
    --help|-h)
      echo "Usage: $0 [--clean] [--offline] [--target=<triple>]"
      echo
      echo "Builds + optimizes Soroban contracts and builds the SDK (TypeScript)."
      echo "  --clean            Clean previous build artifacts (target/ dirs + SDK dist) before building."
      echo "  --offline          Build without contacting the network (for the local docker sandbox)."
      echo "  --target=<triple>  WASM target triple (default: wasm32-unknown-unknown)."
      echo
      echo "Environment:"
      echo "  WASM_TARGET        Same as --target=<triple>."
      echo "  OFFLINE=1          Same as --offline."
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $arg"
      echo "Usage: $0 [--clean] [--offline] [--target=<triple>]"
      exit 1
      ;;
  esac
done

# Allow the offline mode to be requested purely via environment variable.
if [ "${OFFLINE:-0}" = "1" ]; then
  OFFLINE=1
fi

if [ "$CLEAN" -eq 1 ]; then
  echo "==> Cleaning build artifacts"
  # Remove Rust/Soroban target dirs (workspace root + any per-crate targets)
  rm -rf target
  find contracts -maxdepth 3 -type d -name target -exec rm -rf {} +
  # Remove SDK TypeScript dist output
  ( cd sdk && npm run clean )
fi

# Verify stellar CLI is installed (fail fast for the docker init container).
if ! command -v stellar &> /dev/null; then
  echo "ERROR: stellar CLI not found. Install with: cargo install stellar-cli --locked" >&2
  exit 1
fi

# Verify the requested wasm target is available.
if ! rustup target list | grep -q "${WASM_TARGET} (installed)"; then
  if [ "$OFFLINE" -eq 1 ]; then
    echo "ERROR: wasm target '${WASM_TARGET}' is not installed and --offline was requested." >&2
    echo "       Install it beforehand with: rustup target add ${WASM_TARGET}" >&2
    exit 1
  fi
  echo "==> Installing ${WASM_TARGET} target..."
  if ! rustup target add "${WASM_TARGET}"; then
    echo "ERROR: failed to install wasm target '${WASM_TARGET}'." >&2
    exit 1
  fi
fi

echo "==> Building + optimizing Soroban contracts (${WASM_TARGET}, release)"
# `stellar contract build --optimize` supersedes the deprecated
# `stellar contract optimize` command in stellar-cli 25.x.
STELLAR_BUILD_ARGS=(contract build --optimize)
if [ "$OFFLINE" -eq 1 ]; then
  STELLAR_BUILD_ARGS+=(--offline)
fi
if ! stellar "${STELLAR_BUILD_ARGS[@]}"; then
  echo "ERROR: 'stellar contract build --optimize' failed." >&2
  exit 1
fi

echo "==> Generating Python client from Soroban contract specs"
if ! command -v python3 &> /dev/null; then
  echo "WARNING: python3 not found; skipping Python client generation."
  echo "         Install Python 3 to regenerate python/marc_stellar/ clients."
elif [ ! -f scripts/generate-python-client.py ]; then
  echo "WARNING: scripts/generate-python-client.py not found; skipping Python client generation."
else
  if python3 scripts/generate-python-client.py; then
    echo "==> Python client generated successfully"
  else
    echo "WARNING: Python client generation failed; continuing build."
    echo "         Ensure the generator's dependencies are installed (e.g. pip install -r python/requirements.txt)."
  fi
fi

echo "==> Building SDK (TypeScript)"
if ! ( cd sdk && npm run build ); then
  echo "ERROR: SDK build failed." >&2
  exit 1
fi

echo "==> Done"
