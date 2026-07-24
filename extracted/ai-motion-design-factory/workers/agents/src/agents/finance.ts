import { BaseFactoryAgent } from "@factory/agent-kit";
import { schema } from "@factory/db";
import { eq } from "drizzle-orm";
import { FinanceInputSchema, type CreateInvoiceOutputSchema } from "@factory/shared-types";
import type { z } from "zod";

const UPSELL_SYSTEM_PROMPT = `既存顧客の商談・納品履歴から、根拠のあるアップセル提案を1〜2件、日本語で簡潔に提案してください。
出力は必ず次のJSON Schemaのみ: { "suggestions": string[] }
実績を誇張せず、相手の実際の利用状況に基づく提案のみにしてください。`;

export class FinanceAgent extends BaseFactoryAgent {
  protected agentName = "finance";

  async onRequest(request: Request): Promise<Response> {
    const input = FinanceInputSchema.parse(await request.json());

    const output = await this.runWithLogging(input.tenantId, `Finance: ${input.action}`, input, async () => {
      const [deal] = await this.db.select().from(schema.deals).where(eq(schema.deals.id, input.dealId));
      if (!deal) throw new Error(`deal ${input.dealId} not found`);

      switch (input.action) {
        case "create_invoice": {
          if (!deal.valueUsd) throw new Error("deal has no value_usd set");
          const idempotencyKey = `deal-${deal.id}-invoice-${new Date().toISOString().slice(0, 10)}`;
          const result = await this.callMcpTool<z.infer<typeof CreateInvoiceOutputSchema>>(
            "crm-finance",
            "create_invoice",
            { dealId: deal.id, amountUsd: Number(deal.valueUsd), idempotencyKey }
          );
          return result;
        }
        case "record_payment": {
          // In production this is primarily driven by the Stripe webhook
          // (see workers/api-gateway/src/routes — a webhook handler is the
          // reliable path; this tool-invoked version exists for manual
          // reconciliation from the CRM UI).
          await this.callMcpTool("crm-finance", "update_deal_stage", { dealId: deal.id, stage: "won", note: "payment recorded" });
          return { recorded: true };
        }
        case "propose_upsell": {
          const response = await this.callLLM({
            system: UPSELL_SYSTEM_PROMPT,
            userContent: JSON.stringify({ dealStage: deal.stage, valueUsd: deal.valueUsd }),
            maxTokens: 400,
          });
          const textBlock = response.content.find((b): b is { type: "text"; text: string } => b.type === "text");
          return textBlock ? JSON.parse(stripFences(textBlock.text)) : { suggestions: [] };
        }
      }
    });

    return Response.json(output);
  }
}

function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? (fenced[1] ?? text) : text).trim();
}
