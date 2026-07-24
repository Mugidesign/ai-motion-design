/**
 * lead-enrichment-mcp
 *
 * Deliberately does NOT implement LinkedIn / Instagram / X scraping —
 * see docs/05-ops-security-compliance-cost.md §3.1. `LeadSourceSchema` in
 * @factory/shared-types does not even include those as valid enum values,
 * so this is enforced at the type level, not just left to convention.
 *
 * TRANSPORT NOTE: same caveat as motion-generator-mcp/src/index.ts —
 * verify McpAgent/McpServer wiring against current docs before shipping.
 */
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createDb, schema } from "@factory/db";
import { eq, and } from "drizzle-orm";
import {
  SearchCompaniesInputSchema,
  EnrichCompanyInputSchema,
  CheckSuppressionInputSchema,
} from "@factory/shared-types";
import { searchGoogleMaps } from "./providers/google-places";
import { fetchSiteSignals } from "./providers/own-site";

export interface Env {
  LEAD_ENRICHMENT_MCP: DurableObjectNamespace;
  DATABASE_URL: string;
  GOOGLE_PLACES_API_KEY?: string;
  CRUNCHBASE_API_KEY?: string;
  PRODUCT_HUNT_API_TOKEN?: string;
}

const COMPLIANT_SOURCES_WITH_ADAPTERS = ["google_maps", "own_site"] as const;

export class LeadEnrichmentMcp extends McpAgent<Env> {
  server = new McpServer({ name: "lead-enrichment-mcp", version: "0.1.0" });

  async init() {
    this.server.tool(
      "search_companies",
      "コンプライアンス済みソース（公式API/自社サイト）からのみ企業候補を検索する。LinkedIn/Instagram/Xの直接スクレイピングは実装しない（docs/05参照）。",
      SearchCompaniesInputSchema.shape,
      async (rawInput: unknown) => {
        const input = SearchCompaniesInputSchema.parse(rawInput);
        const candidates = [];
        const skipped: string[] = [];

        for (const source of input.sources) {
          if (source === "google_maps" && this.env.GOOGLE_PLACES_API_KEY) {
            candidates.push(...(await searchGoogleMaps(this.env.GOOGLE_PLACES_API_KEY, input.query, input.maxResults)));
          } else if (!COMPLIANT_SOURCES_WITH_ADAPTERS.includes(source as any)) {
            // shopify / kickstarter / product_hunt / crunchbase / search_engine /
            // csv_import: valid, compliant sources per the schema, but no
            // adapter wired up yet in this scaffold. csv_import is handled
            // via a direct bulk-insert REST endpoint instead of this tool.
            skipped.push(source);
          }
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ candidates, skippedSources: skipped }) }],
        };
      }
    );

    this.server.tool(
      "enrich_company",
      "企業の公開サイトから構造化シグナルを取得する（動画有無・SNSリンク・OG情報など）。品質スコアリングそのものはLead Finder AgentがClaudeに判断させる（このツールは生データの取得のみ）。",
      EnrichCompanyInputSchema.shape,
      async (rawInput: unknown) => {
        const input = EnrichCompanyInputSchema.parse(rawInput);
        if (!input.websiteUrl) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ signals: null }) }] };
        }
        const signals = await fetchSiteSignals(input.websiteUrl);
        return { content: [{ type: "text" as const, text: JSON.stringify({ signals }) }] };
      }
    );

    this.server.tool(
      "check_suppression",
      "送信抑制リストと突合する。communication-mcpのsend_emailも内部で必ずこれを呼ぶため、Agentが個別に呼ぶのは事前チェック用途。",
      CheckSuppressionInputSchema.shape,
      async (rawInput: unknown) => {
        const input = CheckSuppressionInputSchema.parse(rawInput);
        const db = createDb(this.env.DATABASE_URL);
        const rows = await db
          .select()
          .from(schema.suppressionList)
          .where(
            and(
              eq(schema.suppressionList.email, input.email)
              // tenant_id null = global suppression, matched separately below
            )
          );
        const match = rows.find((r) => r.tenantId === input.tenantId || r.tenantId === null);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ isSuppressed: Boolean(match), reason: match?.reason }),
            },
          ],
        };
      }
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") return LeadEnrichmentMcp.serve("/mcp").fetch(request, env, ctx);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "lead-enrichment-mcp" });
    return new Response("Not found", { status: 404 });
  },
};
