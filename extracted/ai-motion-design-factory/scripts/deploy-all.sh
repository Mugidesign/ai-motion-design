#!/usr/bin/env bash
# scripts/deploy-all.sh
#
# Deploys every Worker in this repo via `wrangler deploy`, in an order
# that respects the service bindings between them (api-gateway and
# orchestrator both bind to agents-worker; agents-worker calls the 5 MCP
# servers by URL). Wrangler resolves service bindings by name at deploy
# time, so dependencies technically only need to exist by the time
# something that *calls* them is deployed — this order is the simplest
# one that guarantees that on a from-scratch deploy.
#
# Prerequisites this script does NOT do for you (see docs/06-oss-free-stack.md):
#   - infra/docker-compose.yml running somewhere reachable from Cloudflare's
#     network (a public DATABASE_URL, not localhost)
#   - `wrangler secret put DATABASE_URL` (and SUPABASE_JWT_SECRET for
#     api-gateway) already run for every Worker below that needs it
#   - KV namespace / R2 bucket created and wrangler.jsonc placeholder IDs
#     filled in
#
# Usage: bash scripts/deploy-all.sh

set -euo pipefail
cd "$(dirname "$0")/.."

deploy() {
  local dir="$1"
  echo "==> Deploying $dir"
  (cd "$dir" && pnpm exec wrangler deploy)
}

# 1. MCP servers first — nothing else depends on Cloudflare-side deploy
#    ordering for these (agents-worker calls them by public URL, set as
#    plain `vars`, not service bindings), but deploying them first means
#    their URLs are live before anything tries to call them.
deploy workers/mcp-servers/motion-generator
deploy workers/mcp-servers/lead-enrichment
deploy workers/mcp-servers/communication
deploy workers/mcp-servers/knowledge
deploy workers/mcp-servers/crm-finance

# 2. agents-worker — depended on by both api-gateway and orchestrator via
#    service bindings, so it must exist before them.
deploy workers/agents

# 3. Both of these bind to agents-worker; order between the two doesn't matter.
deploy workers/orchestrator
deploy workers/api-gateway

echo ""
echo "All Workers deployed. Remaining manual steps:"
echo "  - Update each MCP server's public URL in workers/agents/wrangler.jsonc"
echo "    vars if they differ from the placeholders, then re-deploy agents-worker"
echo "  - Deploy apps/web to Vercel (or your host of choice) separately —"
echo "    it's a Next.js app, not a Worker, so it's outside this script"
