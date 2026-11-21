#!/usr/bin/env bash
# One-shot demo seeder: waits for registry + dashboard, logs sample job URLs.
set -euo pipefail
REGISTRY_URL="${REGISTRY_URL:-http://registry:4500}"
DASHBOARD_URL="${DASHBOARD_URL:-http://dashboard:3000}"

echo "[demo-seed] waiting for registry at $REGISTRY_URL ..."
until curl -sf "$REGISTRY_URL/health" >/dev/null 2>&1; do sleep 2; done
echo "[demo-seed] waiting for dashboard at $DASHBOARD_URL ..."
until curl -sf "$DASHBOARD_URL/readyz" >/dev/null 2>&1; do sleep 2; done

echo "[demo-seed] registry agents:"
curl -sf "$REGISTRY_URL/agents" | head -c 2000 || true
echo
echo "[demo-seed] open the dashboard at http://localhost:3000 (sample agents are registered by seller services)."
echo "[demo-seed] teardown: docker compose --profile demo down -v"