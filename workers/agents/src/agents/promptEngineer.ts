import { BaseFactoryAgent } from "@factory/agent-kit";
import { schema } from "@factory/db";
import { eq } from "drizzle-orm";
import { PromptEngineerInputSchema, PromptSpecSchema, type PromptEngineerOutputSchema } from "@factory/shared-types";
import { z } from "zod";

const SYSTEM_PROMPT = `あなたはAI Motion Design Factoryの Prompt Engineer Agent です。
商品のLP/画像解析結果とブランド情報から、動画生成AIに渡す構成仕様(promptSpec)を設計します。
出力は必ず以下のJSON Schemaに合致するJSONのみを返してください。説明文やMarkdownのコードブロックは不要です。
{
  "composition": string,   // 全体の構図・トーン
  "cameraWork": string,    // カメラワーク指示
  "colorPalette": string[],
  "bgmMood": string,
  "captionsLocale": string, // 既定 "ja"
  "cta": string
}`;

export class PromptEngineerAgent extends BaseFactoryAgent {
  protected agentName = "prompt-engineer";

  async onRequest(request: Request): Promise<Response> {
    const input = PromptEngineerInputSchema.parse(await request.json());

    const output = await this.runWithLogging(input.tenantId, "商品分析→promptSpec生成", input, async () => {
      const [product] = await this.db.select().from(schema.products).where(eq(schema.products.id, input.productId));
      if (!product) throw new Error(`product ${input.productId} not found`);

      const response = await this.callLLM({
        system: SYSTEM_PROMPT,
        userContent: JSON.stringify({
          sourceType: product.sourceType,
          sourceUrl: product.sourceUrl,
          analyzedData: product.analyzedData,
        }),
        maxTokens: 1000,
      });

      const textBlock = response.content.find((b): b is { type: "text"; text: string } => b.type === "text");
      if (!textBlock) throw new Error("Claude returned no text content");

      const promptSpec = PromptSpecSchema.parse(JSON.parse(extractJson(textBlock.text)));

      await this.db
        .update(schema.products)
        .set({ analyzedData: { ...(product.analyzedData as object), promptSpec } })
        .where(eq(schema.products.id, product.id));

      const result: z.infer<typeof PromptEngineerOutputSchema> = { promptSpec };
      return result;
    });

    return Response.json(output);
  }
}

/** Claude sometimes wraps JSON in ```json fences despite instructions —
 *  strip them defensively rather than trusting raw output. */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}
