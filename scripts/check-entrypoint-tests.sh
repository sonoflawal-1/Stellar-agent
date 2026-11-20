#!/usr/bin/env bash
# check-entrypoint-tests.sh
#
# CI guard: fails when any public entrypoint in the agentic-commerce contract
# has no corresponding test.
#
# Extracts `pub fn` names from the #[contractimpl] block in lib.rs, filters out
# an allowlist of getters (and get_* prefixed functions), then verifies each
# remaining name appears in test.rs.
#
# Exit codes:
#   0 - all public entrypoints have tests
#   1 - one or more public entrypoints are untested
#   2 - setup/usage error (missing files, etc.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

LIB_FILE="${REPO_ROOT}/contracts/agentic-commerce/src/lib.rs"
TEST_FILE="${REPO_ROOT}/contracts/agentic-commerce/src/test.rs"

if [[ ! -f "${LIB_FILE}" ]]; then
  echo "error: lib.rs not found at ${LIB_FILE}" >&2
  exit 2
fi

if [[ ! -f "${TEST_FILE}" ]]; then
  echo "error: test.rs not found at ${TEST_FILE}" >&2
  exit 2
fi

# Allowlist of getters / view functions that are exempt from the test
# requirement. Matched as exact names. Additionally, any function whose name
# starts with `get_` is exempt.
ALLOWLIST=(
  "get_job"
  "get_milestones"
  "is_token_allowed"
)

is_allowlisted() {
  local name="$1"
  # Exempt all get_* getters.
  if [[ "${name}" == get_* ]]; then
    return 0
  fi
  local entry
  for entry in "${ALLOWLIST[@]}"; do
    if [[ "${name}" == "${entry}" ]]; then
      return 0
    fi
  done
  return 1
}

# Extract `pub fn <name>` occurrences from lib.rs. We restrict to the
# #[contractimpl] block by tracking brace depth once we enter it.
entrypoints="$(
  awk '
    BEGIN { in_impl = 0; depth = 0; found_impl = 0 }
    {
      line = $0
      # Detect the start of a #[contractimpl] attribute.
      if (line ~ /#\[contractimpl\]/) {
        found_impl = 1
        next
      }
      if (found_impl && !in_impl) {
        # The impl block begins on the next line containing an opening brace.
        if (line ~ /\{/) {
          in_impl = 1
          # Count braces on this line.
          n = gsub(/\{/, "{", line)
          m = gsub(/\}/, "}", line)
          depth = n - m
          next
        }
      }
      if (in_impl) {
        # Capture pub fn names.
        if (match(line, /pub[ \t]+fn[ \t]+[A-Za-z_][A-Za-z0-9_]*/)) {
          name = substr(line, RSTART, RLENGTH)
          sub(/^pub[ \t]+fn[ \t]+/, "", name)
          print name
        }
        # Track brace depth to know when the impl block ends.
        n = gsub(/\{/, "{", line)
        m = gsub(/\}/, "}", line)
        depth += n - m
        if (depth <= 0) {
          in_impl = 0
          found_impl = 0
        }
      }
    }
  ' "${LIB_FILE}" | sort -u
)"

if [[ -z "${entrypoints}" ]]; then
  echo "error: no public entrypoints found in ${LIB_FILE}" >&2
  exit 2
fi

untested=()
while IFS= read -r name; do
  [[ -z "${name}" ]] && continue
  if is_allowlisted "${name}"; then
    continue
  fi
  # Verify the name appears in test.rs. Use word boundaries so that e.g.
  # `create_job` does not match `create_job_extra`.
  if ! grep -Eq "(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)" "${TEST_FILE}"; then
    untested+=("${name}")
  fi
done <<< "${entrypoints}"

if [[ ${#untested[@]} -gt 0 ]]; then
  echo "error: the following public entrypoints have no tests in ${TEST_FILE}:" >&2
  for name in "${untested[@]}"; do
    echo "  - ${name}" >&2
  done
  echo "" >&2
  echo "Add a test for each entrypoint, or add it to the allowlist in" >&2
  echo "scripts/check-entrypoint-tests.sh if it is a getter." >&2
  exit 1
fi

echo "ok: all public entrypoints have tests"
exit 0