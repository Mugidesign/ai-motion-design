#!/usr/bin/env bash
# scripts/health-check.sh
#
# Curls one or more /health URLs and fails (non-zero exit) if any of them
# don't respond with HTTP 200 and `"ok":true` in the body. Used by
# .github/workflows/deploy.yml as an automated post-deploy smoke test,
# and just as usefully run by hand any time you want to check the current
# state of a deployment without waiting on CI.
#
# Usage:
#   bash scripts/health-check.sh https://api-gateway.your-subdomain.workers.dev/health
#   bash scripts/health-check.sh url1/health url2/health url3/health   # check several at once
#
# Or check every Worker in one go by passing your account's workers.dev
# subdomain (the account-wide one, e.g. "my-account" from
# my-account.workers.dev — find it in the Cloudflare dashboard under
# Workers & Pages, or via `wrangler whoami`):
#   bash scripts/health-check.sh --subdomain my-account
#
# Exit code is 0 only if every check passed.

set -uo pipefail

WORKERS=(
  api-gateway
  agents-worker
  orchestrator
  motion-generator-mcp
  lead-enrichment-mcp
  communication-mcp
  knowledge-mcp
  crm-finance-mcp
)

urls=()

if [ "${1:-}" = "--subdomain" ]; then
  subdomain="${2:?Usage: health-check.sh --subdomain <your-workers-dev-subdomain>}"
  for w in "${WORKERS[@]}"; do
    urls+=("https://${w}.${subdomain}.workers.dev/health")
  done
else
  if [ "$#" -eq 0 ]; then
    echo "Usage:"
    echo "  health-check.sh <url1> [url2] [url3] ..."
    echo "  health-check.sh --subdomain <your-workers-dev-subdomain>"
    exit 2
  fi
  urls=("$@")
fi

fail_count=0

for url in "${urls[@]}"; do
  # -sS: silent but still show errors. -w: append the HTTP status code on
  # its own line so we can separate it from the body without a second request.
  response="$(curl -sS -m 10 -w $'\n%{http_code}' "$url" 2>&1)"
  curl_exit=$?
  http_code="$(echo "$response" | tail -n1)"
  body="$(echo "$response" | sed '$d')"

  if [ "$curl_exit" -ne 0 ]; then
    echo "FAIL  $url  (curl error: $body)"
    fail_count=$((fail_count + 1))
    continue
  fi

  if [ "$http_code" != "200" ]; then
    echo "FAIL  $url  (HTTP $http_code) $body"
    fail_count=$((fail_count + 1))
    continue
  fi

  if ! echo "$body" | grep -qE '"ok"[[:space:]]*:[[:space:]]*true'; then
    echo "FAIL  $url  (HTTP 200 but not ok:true) $body"
    fail_count=$((fail_count + 1))
    continue
  fi

  echo "OK    $url"
done

echo ""
if [ "$fail_count" -eq 0 ]; then
  echo "All ${#urls[@]} health checks passed."
  exit 0
else
  echo "$fail_count of ${#urls[@]} health checks failed."
  exit 1
fi
