/**
 * motion-generator-mcp — unified MCP interface over Runway / Luma / Pika /
 * Kling / Veo / Higgsfield / OpenAI (docs/02-database-api-mcp.md §3).
 *
 * TRANSPORT NOTE: this uses `agents/mcp`'s McpAgent to host an MCP server
 * on a Durable Object, and `@modelcontextprotocol/sdk`'s McpServer for tool
 * registration. Both packages move quickly — verify `McpAgent.serve()` /
 * `McpAgent.serveSSE()` and `McpServer.tool()` against the current docs
 * (https://developers.cloudflare.com/agents/model-context-protocol/ and
 * https://github.com/modelcontextprotocol/typescript-sdk) before shipping;
 * the tool logic and Zod schemas below are the reviewed, load-bearing part.
 */
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  GenerateVideoInputSchema,
  CheckGenerationStatusInputSchema,
  VideoProviderSchema,
} from "@factory/shared-types";
import { getProviderAdapter, listAvailableProviders, type ProviderEnv } from "./providers";

export interface Env extends ProviderEnv {
  MOTION_GENERATOR_MCP: DurableObjectNamespace;
  MOTION_GENERATOR_DEFAULT_PROVIDER: string;
}

export class MotionGeneratorMcp extends McpAgent<Env> {
  server = new McpServer({ name: "motion-generator-mcp", version: "0.1.0" });

  async init() {
    this.server.tool(
      "generate_video",
      "商品情報とプロンプト仕様から動画生成ジョブを開始する（非同期・ジョブID返却）。qualityTier='draft'は低コストプロバイダに自動ルーティングされる。",
      GenerateVideoInputSchema.shape,
      async (rawInput) => {
        const input = GenerateVideoInputSchema.parse(rawInput);
        const provider =
          input.preferredProvider === "mock" && input.qualityTier === "final"
            ? (this.env.MOTION_GENERATOR_DEFAULT_PROVIDER as z.infer<typeof VideoProviderSchema>)
            : input.preferredProvider;

        const adapter = getProviderAdapter(provider, this.env);
        const job = await adapter.startGeneration(input);
        return { content: [{ type: "text" as const, text: JSON.stringify(job) }] };
      }
    );

    this.server.tool(
      "check_generation_status",
      "動画生成ジョブの進捗をポーリングする",
      CheckGenerationStatusInputSchema.shape,
      async (rawInput) => {
        const input = CheckGenerationStatusInputSchema.parse(rawInput);
        const adapter = getProviderAdapter(input.provider, this.env);
        const status = await adapter.checkStatus(input.jobId);
        return { content: [{ type: "text" as const, text: JSON.stringify(status) }] };
      }
    );

    this.server.tool("list_providers", "利用可能な動画生成プロバイダと設定状況の一覧", {}, async () => {
      return { content: [{ type: "text" as const, text: JSON.stringify(listAvailableProviders(this.env)) }] };
    });

    this.server.tool(
      "estimate_cost",
      "プロバイダ・尺・品質ティアからおおよそのコストを見積もる（コスト最適化ルーティング用）",
      {
        provider: VideoProviderSchema,
        durationVariant: z.enum(["15s", "30s", "60s"]),
        qualityTier: z.enum(["draft", "final"]),
      },
      async ({ provider, durationVariant, qualityTier }) => {
        const adapter = getProviderAdapter(provider, this.env);
        const estimatedCostUsd = adapter.estimateCost(durationVariant, qualityTier);
        return { content: [{ type: "text" as const, text: JSON.stringify({ estimatedCostUsd }) }] };
      }
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      return MotionGeneratorMcp.serve("/mcp").fetch(request, env, ctx);
    }
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "motion-generator-mcp" });
    }
    return new Response("Not found", { status: 404 });
  },
};
