#!/usr/bin/env bash
set -a; source demo/.env; set +a

# Kill any existing processes
pkill -f "tsx index.ts" 2>/dev/null
pkill -f "tsx server.ts" 2>/dev/null
sleep 2

echo "Starting agent registry..."
(cd agents/registry && npm start) &

sleep 2

echo "Starting seller agents..."
(cd agents/seller-webbuilder && SELLER_SECRET=$SELLER_SECRET_1 npm start) &
(cd agents/seller-copywriter && SELLER_SECRET=$SELLER_SECRET_2 npm start) &
(cd agents/seller-namer      && SELLER_SECRET=$SELLER_SECRET_3 npm start) &
(cd agents/seller-researcher && SELLER_SECRET=$SELLER_SECRET_4 npm start) &

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
