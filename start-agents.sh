#!/usr/bin/env bash
set -a; source demo/.env; set +a

# ANSI color codes for per-agent log prefixes
RESET="\033[0m"
BOLD="\033[1m"

C_REGISTRY="\033[1;36m"    # Bold Cyan
C_WEBBUILDER="\033[1;32m"  # Bold Green
C_COPYWRITER="\033[1;33m"  # Bold Yellow
C_NAMER="\033[1;35m"       # Bold Magenta
C_RESEARCHER="\033[1;34m"  # Bold Blue

# prefix_color COLOR TAG — wraps stdin lines with a colorized [TAG] prefix
prefix_color() {
  local color="$1"
  local tag="$2"
  while IFS= read -r line; do
    printf "${color}${BOLD}[%-12s]${RESET} %s\n" "$tag" "$line"
  done
}

# Kill any existing processes
pkill -f "tsx index.ts" 2>/dev/null
pkill -f "tsx server.ts" 2>/dev/null
sleep 2

echo "Starting agent registry..."
(cd agents/registry && npm start 2>&1) | prefix_color "$C_REGISTRY" "REGISTRY" &

sleep 2

echo "Starting seller agents..."
(cd agents/seller-webbuilder && SELLER_SECRET=$SELLER_SECRET_1 npm start 2>&1) | prefix_color "$C_WEBBUILDER" "WEBBUILDER" &
(cd agents/seller-copywriter && SELLER_SECRET=$SELLER_SECRET_2 npm start 2>&1) | prefix_color "$C_COPYWRITER" "COPYWRITER" &
(cd agents/seller-namer      && SELLER_SECRET=$SELLER_SECRET_3 npm start 2>&1) | prefix_color "$C_NAMER"      "NAMER"      &
(cd agents/seller-researcher && SELLER_SECRET=$SELLER_SECRET_4 npm start 2>&1) | prefix_color "$C_RESEARCHER" "RESEARCHER" &

echo "All agents starting..."
sleep 3

# npm start backgrounded with `&` always returns immediately, so a crashed
# agent would otherwise go unnoticed until the buyer's first request fails.
# Poll each agent's /health endpoint before declaring success.
declare -A AGENT_PORTS=(
  [registry]=4500
  [seller-webbuilder]=4501
  [seller-copywriter]=4502
  [seller-namer]=4503
  [seller-researcher]=4504
)

echo ""
echo "Checking agent health..."
failed=()
for name in registry seller-webbuilder seller-copywriter seller-namer seller-researcher; do
  port="${AGENT_PORTS[$name]}"
  healthy=""
  for attempt in 1 2 3 4 5; do
    if curl -sf "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep 1
  done
  if [ -n "$healthy" ]; then
    echo "  OK   $name (:$port)"
  else
    echo "  FAIL $name (:$port) did not respond to /health"
    failed+=("$name")
  fi
done

if [ "${#failed[@]}" -gt 0 ]; then
  echo ""
  echo "ERROR: ${#failed[@]} agent(s) failed to start: ${failed[*]}"
  echo "Check the output above (or each agent's npm start logs) for the crash reason."
  exit 1
fi

echo ""
echo "Now start the buyer:"
echo "  cd agents/buyer && npm start"
