#!/usr/bin/env bash
set -euo pipefail

CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --clean)
      CLEAN=1
      ;;
    --help|-h)
      echo "Usage: $0 [--clean]"
      echo
      echo "Builds + optimizes Soroban contracts and builds the SDK (TypeScript)."
      echo "  --clean    Clean previous build artifacts (target/ dirs + SDK dist) before building."
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $arg"
      echo "Usage: $0 [--clean]"
      exit 1
      ;;
  esac
done

if [ "$CLEAN" -eq 1 ]; then
  echo "==> Cleaning build artifacts"
  # Remove Rust/Soroban target dirs (workspace root + any per-crate targets)
  rm -rf target
  find contracts -maxdepth 3 -type d -name target -exec rm -rf {} +
  # Remove SDK TypeScript dist output
  ( cd sdk && npm run clean )
fi

# Verify stellar CLI is installed
if ! command -v stellar &> /dev/null; then
  echo "ERROR: stellar CLI not found. Install with: cargo install stellar-cli --locked"
  exit 1
fi

# Verify wasm32-unknown-unknown target is available
if ! rustup target list | grep -q "wasm32-unknown-unknown (installed)"; then
  echo "==> Installing wasm32-unknown-unknown target..."
  rustup target add wasm32-unknown-unknown
fi

echo "==> Building + optimizing Soroban contracts (wasm32-unknown-unknown, release)"
# `stellar contract build --optimize` supersedes the deprecated
# `stellar contract optimize` command in stellar-cli 25.x.
stellar contract build --optimize

echo "==> Building SDK (TypeScript)"
( cd sdk && npm run build )

echo "==> Done"
