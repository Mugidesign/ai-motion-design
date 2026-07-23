/**
 * knowledge-mcp — RAG over Notion / GitHub / Google Drive / PDF / Markdown /
 * Web / YouTube / MediaWiki sources (docs/02 §3, docs/03 Knowledge Agent).
 *
 * This scaffold implements the `web` and `markdown` ingestion paths fully
 * (fetch -> chunk -> embed -> store) since they need no OAuth. Notion /
 * GitHub / Google Drive ingestion needs a per-tenant OAuth connection —
 * the ingest_source tool below has the branch points ready
 * (`case "notion":` etc.) with a clear TODO for wiring each provider's SDK.
 *
 * Embeddings default to Workers AI's bge-base-en-v1.5 (768 dims, free,
 * open-weight) — see ./embeddings.ts. OpenAI is available as an opt-in.
 */
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createDb, schema } from "@factory/db";
import { sql, eq } from "drizzle-orm";
import { IngestSourceInputSchema, SearchKnowledgeInputSchema } from "@factory/shared-types";
import { embed, type EmbeddingEnv } from "./embeddings";

export interface Env extends EmbeddingEnv {
  KNOWLEDGE_MCP: DurableObjectNamespace;
  DATABASE_URL: string;
}

function chunkText(text: string, maxChars = 1200): string[] {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  const chunks: string[] = [];
  let buffer = "";
  for (const p of paragraphs) {
    if ((buffer + p).length > maxChars && buffer) {
      chunks.push(buffer.trim());
      buffer = "";
    }
    buffer += p + "\n\n";
  }
  if (buffer.trim()) chunks.push(buffer.trim());
  return chunks;
}

export class KnowledgeMcp extends McpAgent<Env> {
  server = new McpServer({ name: "knowledge-mcp", version: "0.1.0" });

  async init() {
    this.server.tool(
      "ingest_source",
      "RAGソースを取り込み、チャンク化・埋め込み・pgvectorへの格納まで行う",
      IngestSourceInputSchema.shape,
      async (rawInput) => {
        const input = IngestSourceInputSchema.parse(rawInput);
        const db = createDb(this.env.DATABASE_URL);

        const [doc] = await db
          .insert(schema.knowledgeDocuments)
          .values({ tenantId: input.tenantId, sourceType: input.sourceType, sourceUri: input.sourceUri, status: "pending" })
          .returning();

        try {
          let rawText: string;
          switch (input.sourceType) {
            case "web":
            case "markdown": {
              const res = await fetch(input.sourceUri);
              rawText = await res.text();
              break;
            }
            case "notion":
            case "github":
            case "gdrive":
            case "pdf":
            case "youtube":
            case "mediawiki":
              // TODO: wire the provider-specific SDK/OAuth flow for this
              // source type. Each needs a per-tenant connected account
              // (integration_credentials table) except pdf, which should
              // instead accept a direct file upload to R2 and extract text
              // from there. Left unimplemented rather than faked.
              throw new Error(`ingest for source_type "${input.sourceType}" not yet implemented`);
            default:
              throw new Error(`unknown source_type`);
          }

          const chunks = chunkText(rawText);
          for (const content of chunks) {
            const embedding = await embed(this.env, content);
            await db.insert(schema.knowledgeChunks).values({ documentId: doc!.id, content, embedding, metadata: {} });
          }

          await db.update(schema.knowledgeDocuments).set({ status: "indexed" }).where(eq(schema.knowledgeDocuments.id, doc!.id));
          return { content: [{ type: "text" as const, text: JSON.stringify({ documentId: doc!.id, chunksIndexed: chunks.length }) }] };
        } catch (err) {
          await db.update(schema.knowledgeDocuments).set({ status: "failed" }).where(eq(schema.knowledgeDocuments.id, doc!.id));
          throw err;
        }
      }
    );

    this.server.tool(
      "search_knowledge",
      "pgvectorのコサイン類似度でナレッジチャンクを検索する",
      SearchKnowledgeInputSchema.shape,
      async (rawInput) => {
        const input = SearchKnowledgeInputSchema.parse(rawInput);
        const db = createDb(this.env.DATABASE_URL);
        const queryEmbedding = await embed(this.env, input.query);

        // Raw SQL for the vector distance operator — Drizzle's query builder
        // doesn't yet have first-class `<=>` support in every version, so
        // this uses `sql` directly. Also scopes to the tenant's own
        // documents via a join, since knowledge_chunks has no tenant_id
        // column itself (see infra/supabase/rls.sql for the RLS mirror).
        const rows = await db.execute(sql`
          select kc.content, kc.metadata, kd.source_uri,
                 1 - (kc.embedding <=> ${JSON.stringify(queryEmbedding)}::vector) as score
          from knowledge_chunks kc
          join knowledge_documents kd on kd.id = kc.document_id
          where kd.tenant_id = ${input.tenantId}
          order by kc.embedding <=> ${JSON.stringify(queryEmbedding)}::vector
          limit ${input.topK}
        `);

        const results = (rows as unknown as any[]).map((r) => ({
          content: r.content,
          score: Number(r.score),
          sourceUri: r.source_uri ?? undefined,
        }));

        return { content: [{ type: "text" as const, text: JSON.stringify({ results }) }] };
      }
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") return KnowledgeMcp.serve("/mcp").fetch(request, env, ctx);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "knowledge-mcp" });
    return new Response("Not found", { status: 404 });
  },
};
