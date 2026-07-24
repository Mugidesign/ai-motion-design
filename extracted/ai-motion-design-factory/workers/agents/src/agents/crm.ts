import { BaseFactoryAgent } from "@factory/agent-kit";
import { schema } from "@factory/db";
import { eq } from "drizzle-orm";
import { CrmUpdateInputSchema } from "@factory/shared-types";

const INTENT_SYSTEM_PROMPT = `返信メールの本文から意図を分類してください。
出力は必ず次のJSON Schemaのみ:
{ "intent": "interested"|"not_interested"|"question"|"out_of_office"|"unsubscribe", "sentiment": number, "suggestedStage": "prospect"|"negotiation"|"won"|"lost"|null }
sentimentは-1.0〜1.0。判断がつかない場合はsuggestedStageをnullにしてください。`;

export class CrmAgent extends BaseFactoryAgent {
  protected agentName = "crm";

  async onRequest(request: Request): Promise<Response> {
    const input = CrmUpdateInputSchema.parse(await request.json());

    const output = await this.runWithLogging(input.tenantId, `CRM更新 (${input.triggerEvent})`, input, async () => {
      if (input.triggerEvent === "reply_received") {
        const replyBody = String((input.context as { body?: string } | undefined)?.body ?? "");
        const response = await this.callLLM({ system: INTENT_SYSTEM_PROMPT, userContent: replyBody, maxTokens: 300 });
        const textBlock = response.content.find((b): b is { type: "text"; text: string } => b.type === "text");
        const parsed = textBlock ? JSON.parse(stripFences(textBlock.text)) : { intent: "question", sentiment: 0, suggestedStage: null };

        const leadId = (input.context as { leadId?: string } | undefined)?.leadId;
        if (leadId) {
          await this.db.insert(schema.conversations).values({
            leadId,
            direction: "inbound",
            channel: "email",
            body: replyBody,
            intent: parsed.intent,
            sentiment: String(parsed.sentiment),
          });
          if (parsed.intent === "unsubscribe") {
            const [lead] = await this.db.select().from(schema.leads).where(eq(schema.leads.id, leadId));
            if (lead?.contactEmail) {
              await this.db.insert(schema.suppressionList).values({
                tenantId: input.tenantId,
                email: lead.contactEmail,
                reason: "unsubscribed",
              });
            }
            await this.db.update(schema.leads).set({ consentStatus: "opted_out" }).where(eq(schema.leads.id, leadId));
          }
        }

        if (parsed.suggestedStage) {
          await this.callMcpTool("crm-finance", "update_deal_stage", {
            dealId: input.dealId,
            stage: parsed.suggestedStage,
            note: `auto-suggested from reply intent=${parsed.intent}`,
          });
        }
        return { intent: parsed.intent, stageUpdated: Boolean(parsed.suggestedStage) };
      }

      // manual_update / invoice_paid: direct pass-through to crm-finance-mcp
      const stage = input.triggerEvent === "invoice_paid" ? "won" : (input.context as { stage?: string })?.stage;
      if (stage) {
        await this.callMcpTool("crm-finance", "update_deal_stage", { dealId: input.dealId, stage, note: input.triggerEvent });
      }
      return { stageUpdated: Boolean(stage) };
    });

    return Response.json(output);
  }
}

function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? (fenced[1] ?? text) : text).trim();
}
