#!/usr/bin/env bash
# Mutation testing for agentic-commerce contract using cargo-mutants.
# Verifies that tests catch real bugs by introducing controlled mutations (#319).
# Install: cargo install cargo-mutants
# Usage: ./mutation-test.sh [--in-place]
set -euo pipefail

cd "$(dirname "$0")/.."

cargo mutants \
  --package agentic-commerce \
  --test-tool cargo \
  --output mutation-results-agentic-commerce \
  "$@"

echo ""
echo "Results written to mutation-results-agentic-commerce/"
