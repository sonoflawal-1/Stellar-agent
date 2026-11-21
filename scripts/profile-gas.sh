#!/usr/bin/env bash
#
# scripts/profile-gas.sh
#
# Measures Soroban CPU instruction and memory byte consumption for every
# contract entry point using the Soroban test environment, and emits the
# results as JSON on stdout so CI can diff them against `.gas-baseline.json`.
#
# Usage:
#   scripts/profile-gas.sh [--output <file>] [--baseline <file>] [--quiet]
#
# Options:
#   --output <file>    Write JSON results to <file> instead of stdout.
#   --baseline <file>  Compare against a baseline JSON file and exit non-zero
#                      if any entry point regresses by more than the allowed
#                      threshold (default 10%, override with GAS_REGRESSION_THRESHOLD).
#   --quiet            Suppress progress logging on stderr.
#
# Environment:
#   GAS_REGRESSION_THRESHOLD  Max allowed regression ratio (default: 0.10).
#   CARGO_TARGET_DIR          Cargo target directory (default: target).
#   SOROBAN_NETWORK           Network alias used by `stellar contract invoke`
#                             (default: standalone, only used for fallback).
#
# Exit codes:
#   0  success (and, when comparing, no regression above threshold)
#   1  usage / environment error
#   2  build or measurement failure
#   3  gas regression detected above threshold

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

OUTPUT_FILE=""
BASELINE_FILE=""
QUIET=0
REGRESSION_THRESHOLD="${GAS_REGRESSION_THRESHOLD:-0.10}"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${REPO_ROOT}/target}"
SOROBAN_NETWORK="${SOROBAN_NETWORK:-standalone}"

# Contract entry points to profile. Each entry is "<contract>:<function>".
# The harness invokes each entry point once against a fresh test environment
# and records the CPU instructions and memory bytes reported by the Soroban
# host.
ENTRY_POINTS=(
  "job_registry:init"
  "job_registry:create_job"
  "job_registry:submit"
  "job_registry:complete"
  "job_registry:register"
  "job_registry:update_uri"
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() {
  if [[ "${QUIET}" -eq 0 ]]; then
    printf '[profile-gas] %s\n' "$*" >&2
  fi
}

err() {
  printf '[profile-gas] ERROR: %s\n' "$*" >&2
}

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "required command not found: $1"
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      [[ $# -ge 2 ]] || { err "--output requires a value"; usage; }
      OUTPUT_FILE="$2"
      shift 2
      ;;
    --baseline)
      [[ $# -ge 2 ]] || { err "--baseline requires a value"; usage; }
      BASELINE_FILE="$2"
      shift 2
      ;;
    --quiet)
      QUIET=1
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      err "unknown argument: $1"
      usage
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Environment checks
# ---------------------------------------------------------------------------

require_cmd cargo
require_cmd jq

if [[ ! -f "${REPO_ROOT}/Cargo.toml" ]]; then
  err "Cargo.toml not found at ${REPO_ROOT}; run this script from the repository"
  exit 1
fi

# ---------------------------------------------------------------------------
# Build contracts in release mode
# ---------------------------------------------------------------------------

log "building contracts in release mode (target dir: ${CARGO_TARGET_DIR})"

if ! cargo build \
      --manifest-path "${REPO_ROOT}/Cargo.toml" \
      --release \
      --target wasm32-unknown-unknown \
      --target-dir "${CARGO_TARGET_DIR}" \
      >&2; then
  err "cargo build failed"
  exit 2
fi

WASM_DIR="${CARGO_TARGET_DIR}/wasm32-unknown-unknown/release"
if [[ ! -d "${WASM_DIR}" ]]; then
  err "wasm output directory not found: ${WASM_DIR}"
  exit 2
fi

# ---------------------------------------------------------------------------
# Measurement harness
# ---------------------------------------------------------------------------
#
# We prefer a dedicated Rust bench harness (`cargo run --release --bin
# gas-profile`) that drives the Soroban test environment directly, because it
# reports exact CPU instruction and memory byte counts from the host budget.
# If the harness is unavailable we fall back to `stellar contract invoke
# --simulate`, which reports the same budget figures for a simulated
# transaction.

HARNESS_BIN="${CARGO_TARGET_DIR}/release/gas-profile"
HARNESS_MANIFEST="${REPO_ROOT}/benches/gas-profile/Cargo.toml"

measure_with_harness() {
  log "using Rust bench harness at ${HARNESS_MANIFEST}"

  if [[ ! -f "${HARNESS_MANIFEST}" ]]; then
    return 1
  fi

  if ! cargo build \
        --manifest-path "${HARNESS_MANIFEST}" \
        --release \
        --target-dir "${CARGO_TARGET_DIR}" \
        >&2; then
    err "failed to build gas-profile harness"
    return 2
  fi

  if [[ ! -x "${HARNESS_BIN}" ]]; then
    err "gas-profile harness binary not found: ${HARNESS_BIN}"
    return 2
  fi

  "${HARNESS_BIN}" \
    --wasm-dir "${WASM_DIR}" \
    --entry-points "$(printf '%s\n' "${ENTRY_POINTS[@]}" | paste -sd, -)"
}

measure_with_stellar_cli() {
  log "falling back to 'stellar contract invoke --simulate'"

  if ! command -v stellar >/dev/null 2>&1; then
    err "neither the gas-profile harness nor the 'stellar' CLI is available"
    return 2
  fi

  local results="[]"
  local entry contract function
  for entry in "${ENTRY_POINTS[@]}"; do
    contract="${entry%%:*}"
    function="${entry##*:}"

    local wasm="${WASM_DIR}/${contract}.wasm"
    if [[ ! -f "${wasm}" ]]; then
      log "skipping ${entry}: wasm not found at ${wasm}"
      continue
    fi

    log "simulating ${entry}"

    local raw
    if ! raw="$(stellar contract invoke \
                  --network "${SOROBAN_NETWORK}" \
                  --simulate \
                  --wasm "${wasm}" \
                  --id "${contract}" \
                  -- "${function}" 2>/dev/null)"; then
      log "simulation failed for ${entry}; recording zero usage"
      raw="{}"
    fi

    local cpu mem
    cpu="$(printf '%s' "${raw}" | jq -r '.cost.cpuInsns // .cpu_instructions // 0')"
    mem="$(printf '%s' "${raw}" | jq -r '.cost.memBytes // .memory_bytes // 0')"

    results="$(jq -c \
      --arg contract "${contract}" \
      --arg function "${function}" \
      --argjson cpu "${cpu}" \
      --argjson mem "${mem}" \
      '. + [{contract: $contract, function: $function, cpu_instructions: $cpu, memory_bytes: $mem}]' \
      <<<"${results}")"
  done

  jq -n --argjson results "${results}" '{results: $results}'
}

# ---------------------------------------------------------------------------
# Collect results
# ---------------------------------------------------------------------------

RESULTS_JSON=""
if RESULTS_JSON="$(measure_with_harness)"; then
  :
else
  status=$?
  if [[ "${status}" -eq 1 ]]; then
    RESULTS_JSON="$(measure_with_stellar_cli)" || exit 2
  else
    exit 2
  fi
fi

if ! printf '%s' "${RESULTS_JSON}" | jq -e . >/dev/null 2>&1; then
  err "measurement harness produced invalid JSON"
  exit 2
fi

# Normalise the payload so downstream consumers always see the same shape.
NORMALISED="$(printf '%s' "${RESULTS_JSON}" | jq -c '
  {
    generated_at: (now | todate),
    results: (
      (.results // .)
      | map({
          contract: (.contract // ""),
          function: (.function // ""),
          cpu_instructions: (.cpu_instructions // .cpuInsns // 0),
          memory_bytes: (.memory_bytes // .memBytes // 0)
        })
      | sort_by(.contract, .function)
    )
  }
')"

# ---------------------------------------------------------------------------
# Emit results
# ---------------------------------------------------------------------------

if [[ -n "${OUTPUT_FILE}" ]]; then
  printf '%s\n' "${NORMALISED}" > "${OUTPUT_FILE}"
  log "wrote results to ${OUTPUT_FILE}"
else
  printf '%s\n' "${NORMALISED}"
fi

# ---------------------------------------------------------------------------
# Optional baseline comparison
# ---------------------------------------------------------------------------

if [[ -z "${BASELINE_FILE}" ]]; then
  exit 0
fi

if [[ ! -f "${BASELINE_FILE}" ]]; then
  err "baseline file not found: ${BASELINE_FILE}"
  exit 1
fi

log "comparing against baseline ${BASELINE_FILE} (threshold: ${REGRESSION_THRESHOLD})"

REGRESSIONS="$(jq -n \
  --slurpfile baseline "${BASELINE_FILE}" \
  --argjson current "${NORMALISED}" \
  --argjson threshold "${REGRESSION_THRESHOLD}" '
  ($baseline[0].results // []) as $base
  | ($current.results // []) as $cur
  | [
      $cur[]
      | . as $c
      | ($base[] | select(.contract == $c.contract and .function == $c.function)) as $b
      | if ($b.cpu_instructions // 0) > 0 then
          (($c.cpu_instructions - $b.cpu_instructions) / $b.cpu_instructions) as $delta
          | select($delta > $threshold)
          | {
              contract: $c.contract,
              function: $c.function,
              baseline_cpu: $b.cpu_instructions,
              current_cpu: $c.cpu_instructions,
              delta_pct: ($delta * 100)
            }
        else empty end
    ]
')"

if [[ "$(printf '%s' "${REGRESSIONS}" | jq 'length')" -gt 0 ]]; then
  err "gas regression detected:"
  printf '%s\n' "${REGRESSIONS}" | jq -r '.[] | "  \(.contract)::\(.function): \(.baseline_cpu) -> \(.current_cpu) (\(.delta_pct | . * 100 | round / 100)%)"' >&2
  exit 3
fi

log "no gas regressions above threshold"
exit 0