import { BaseFactoryAgent } from "@factory/agent-kit";
import { IngestSourceInputSchema } from "@factory/shared-types";
import { z } from "zod";

const AskInputSchema = z.object({
  tenantId: z.string().uuid(),
  question: z.string(),
});

const RAG_SYSTEM_PROMPT = `与えられた検索結果チャンクのみを根拠に、質問に日本語で簡潔に回答してください。
チャンクに答えがない場合は「ナレッジベースに該当情報が見つかりませんでした」と答えてください。`;

export class KnowledgeAgent extends BaseFactoryAgent {
  protected agentName = "knowledge";

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = await request.json();

    if (url.pathname.endsWith("/ingest")) {
      const input = IngestSourceInputSchema.parse(body);
      const output = await this.runWithLogging(input.tenantId, `ナレッジ取り込み: ${input.sourceType}`, input, () =>
        this.callMcpTool("knowledge", "ingest_source", input)
      );
      return Response.json(output);
    }

    // default: ask a question via retrieval-augmented generation
    const input = AskInputSchema.parse(body);
    const output = await this.runWithLogging(input.tenantId, "RAG質問応答", input, async () => {
      const search = await this.callMcpTool<{ results: { content: string; score: number; sourceUri?: string }[] }>(
        "knowledge",
        "search_knowledge",
        { tenantId: input.tenantId, query: input.question, topK: 5 }
      );
      const response = await this.callLLM({
        system: RAG_SYSTEM_PROMPT,
        userContent: JSON.stringify({ question: input.question, chunks: search.results }),
        maxTokens: 800,
      });
      const textBlock = response.content.find((b): b is { type: "text"; text: string } => b.type === "text");
      return { answer: textBlock?.text ?? "", sources: search.results.map((r) => r.sourceUri).filter(Boolean) };
    });

    return Response.json(output);
  }
}
