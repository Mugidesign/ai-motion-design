import { BaseFactoryAgent } from "@factory/agent-kit";
import { schema } from "@factory/db";
import { eq } from "drizzle-orm";
import { SalesDraftInputSchema, SalesDraftOutputSchema } from "@factory/shared-types";

const SYSTEM_PROMPT = `あなたはAI Motion Design Factoryの Sales Agent です。
リード企業向けのパーソナライズされた営業メール文面を作成してください。
厳守事項:
- 誇大表現・虚偽の実績を書かない
- 相手企業の実際の情報（会社名・サイトから読み取れる事実）にのみ言及する
- 件名は40文字以内、本文は300〜500文字程度、CTAは1つだけ
- 返信を強要する表現は使わない
出力は必ず次のJSON Schemaのみ: { "subject": string, "bodyText": string, "bodyHtml": string }`;

/**
 * IMPORTANT: this agent only ever writes rows with status
 * "pending_approval" — it has no code path to communication-mcp's
 * send_email tool. Sending happens from workers/api-gateway's
 * POST /campaigns/:id/approve route, which is the only caller allowed to
 * flip a message to "approved" and enqueue it (docs/03 §3.2, docs/05 §3.2).
 * This split exists so "can draft" and "can send" are enforced by which
 * code can reach which binding, not by convention alone.
 */
export class SalesAgent extends BaseFactoryAgent {
  protected agentName = "sales";

  async onRequest(request: Request): Promise<Response> {
    const input = SalesDraftInputSchema.parse(await request.json());

    const output = await this.runWithLogging(input.tenantId, "営業文下書き生成", input, async () => {
      const [campaign] = await this.db
        .select()
        .from(schema.outreachCampaigns)
        .where(eq(schema.outreachCampaigns.id, input.campaignId));
      if (!campaign) throw new Error(`campaign ${input.campaignId} not found`);

      const draftedMessageIds: string[] = [];
      const skipped: { leadId: string; reason: string }[] = [];

      for (const leadId of input.leadIds) {
        const [lead] = await this.db.select().from(schema.leads).where(eq(schema.leads.id, leadId));
        if (!lead) {
          skipped.push({ leadId, reason: "lead_not_found" });
          continue;
        }
        if (lead.consentStatus === "opted_out" || lead.consentStatus === "do_not_contact") {
          skipped.push({ leadId, reason: "consent_status_blocks_outreach" });
          continue;
        }
        if (!lead.contactEmail) {
          skipped.push({ leadId, reason: "no_contact_email" });
          continue;
        }

        const suppression = await this.callMcpTool<{ isSuppressed: boolean }>(
          "lead-enrichment",
          "check_suppression",
          { tenantId: input.tenantId, email: lead.contactEmail }
        );
        if (suppression.isSuppressed) {
          skipped.push({ leadId, reason: "suppressed" });
          continue;
        }

        const response = await this.callLLM({
          system: SYSTEM_PROMPT,
          userContent: JSON.stringify({
            companyName: lead.companyName,
            improvementNotes: lead.improvementNotes,
            videoQualityScore: lead.videoQualityScore,
          }),
          maxTokens: 700,
        });
        const textBlock = response.content.find((b): b is { type: "text"; text: string } => b.type === "text");
        if (!textBlock) {
          skipped.push({ leadId, reason: "claude_returned_no_text" });
          continue;
        }
        const draft = JSON.parse(stripFences(textBlock.text)) as { subject: string; bodyText: string; bodyHtml: string };

        const [message] = await this.db
          .insert(schema.outreachMessages)
          .values({
            campaignId: input.campaignId,
            leadId,
            channel: campaign.channel,
            generatedBody: JSON.stringify(draft),
            status: "pending_approval", // never anything else, see class doc comment
            complianceCheck: {
              suppressionOk: !suppression.isSuppressed,
              jurisdiction: campaign.jurisdiction,
              checkedAt: new Date().toISOString(),
            },
          })
          .returning();
        draftedMessageIds.push(message!.id);
      }

      this.markAwaitingApproval(`${draftedMessageIds.length}件の下書きが承認待ち`);
      return SalesDraftOutputSchema.parse({ draftedMessageIds, skipped });
    });

    return Response.json(output);
  }
}

function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? (fenced[1] ?? text) : text).trim();
}
