import { BaseFactoryAgent } from "@factory/agent-kit";
import { StoryboardInputSchema, StoryboardOutputSchema } from "@factory/shared-types";

const SYSTEM_PROMPT = `あなたはAI Motion Design Factoryの Storyboard Agent です。
promptSpecを受け取り、尺配分とカット割りのシーン配列を設計してください。
出力は必ず以下のJSON Schemaのみ:
{ "scenes": [ { "order": number, "seconds": number, "shotDescription": string } ] }
シーンの合計secondsは動画全体の尺に一致させてください。`;

export class StoryboardAgent extends BaseFactoryAgent {
  protected agentName = "storyboard";

  async onRequest(request: Request): Promise<Response> {
    const input = StoryboardInputSchema.parse(await request.json());

    const output = await this.runWithLogging(input.tenantId, "絵コンテ設計", input, async () => {
      const response = await this.callLLM({
        system: SYSTEM_PROMPT,
        userContent: JSON.stringify(input.promptSpec),
        maxTokens: 1200,
      });
      const textBlock = response.content.find((b): b is { type: "text"; text: string } => b.type === "text");
      if (!textBlock) throw new Error("Claude returned no text content");
      return StoryboardOutputSchema.parse(JSON.parse(stripFences(textBlock.text)));
    });

    return Response.json(output);
  }
}

function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? (fenced[1] ?? text) : text).trim();
}
