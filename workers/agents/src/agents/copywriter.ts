import { BaseFactoryAgent } from "@factory/agent-kit";
import { schema } from "@factory/db";
import { eq } from "drizzle-orm";
import { z } from "zod";

const InputSchema = z.object({
  tenantId: z.string().uuid(),
  productId: z.string().uuid(),
  tone: z.enum(["direct", "playful", "premium", "urgent"]).default("direct"),
});

const OutputSchema = z.object({
  headlines: z.array(z.string()).length(3),
  captions: z.array(z.string()).length(3),
  ctaOptions: z.array(z.string()).min(3),
});

const SYSTEM_PROMPT = `あなたはAI Motion Design Factoryの Copywriter Agent です。
商品分析結果とトーン指定から、広告見出し・字幕キャプション・CTA案を生成してください。
出力は必ず次のJSON Schemaのみ: { "headlines": string[3], "captions": string[3], "ctaOptions": string[3+] }
誇大広告・事実と異なる効能表現は避け、検証可能な訴求のみにしてください。`;

export class CopywriterAgent extends BaseFactoryAgent {
  protected agentName = "copywriter";

  async onRequest(request: Request): Promise<Response> {
    const input = InputSchema.parse(await request.json());

    const output = await this.runWithLogging(input.tenantId, "コピー生成", input, async () => {
      const [product] = await this.db.select().from(schema.products).where(eq(schema.products.id, input.productId));
      if (!product) throw new Error(`product ${input.productId} not found`);

      const response = await this.callLLM({
        system: SYSTEM_PROMPT,
        userContent: JSON.stringify({ tone: input.tone, analyzedData: product.analyzedData }),
        maxTokens: 800,
      });
      const textBlock = response.content.find((b): b is { type: "text"; text: string } => b.type === "text");
      if (!textBlock) throw new Error("Claude returned no text content");
      return OutputSchema.parse(JSON.parse(stripFences(textBlock.text)));
    });

    return Response.json(output);
  }
}

function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}
