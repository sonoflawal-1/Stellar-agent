#!/usr/bin/env bash
# Mutation testing for agent-identity contract using cargo-mutants.
# Install: cargo install cargo-mutants
# Usage: ./mutation-test.sh [--in-place]
set -euo pipefail

cd "$(dirname "$0")/.."

cargo mutants \
  --package agent-identity \
  --test-tool cargo \
  --output mutation-results-agent-identity \
  "$@"

echo ""
echo "Results written to mutation-results-agent-identity/"
