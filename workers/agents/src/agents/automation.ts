import { BaseFactoryAgent } from "@factory/agent-kit";
import { schema } from "@factory/db";
import { eq } from "drizzle-orm";
import { AutomationEventInputSchema } from "@factory/shared-types";

/**
 * The end-to-end happy path (product -> video -> portfolio -> leads ->
 * outreach) is driven by the Orchestrator's Postgres-backed state machine
 * (workers/orchestrator/src/pipeline.ts), not by this agent — see
 * docs/06-oss-free-stack.md for why that replaced Cloudflare Workflows.
 *
 * This agent exists for the *irregular* events a linear pipeline handles
 * awkwardly: a provider webhook firing whenever it feels like it, a
 * Stripe payment event, a QA failure needing a human decision, etc. It
 * dispatches each event type to the right next step and is intentionally
 * small — most of the real logic lives in the agent/tool it delegates to.
 */
export class AutomationAgent extends BaseFactoryAgent {
  protected agentName = "automation";

  async onRequest(request: Request): Promise<Response> {
    const input = AutomationEventInputSchema.parse(await request.json());

    const output = await this.runWithLogging(input.tenantId, `イベント処理: ${input.eventType}`, input, async () => {
      switch (input.eventType) {
        case "video_generation_failed":
          // Escalate rather than silently retry forever — surfaces in
          // Control Room as an error state for a human to look at.
          this.markAwaitingApproval(`動画生成失敗: ${JSON.stringify(input.payload)}`);
          return { escalated: true };

        case "stripe_payment_succeeded": {
          const dealId = (input.payload as { dealId?: string }).dealId;
          if (dealId) {
            await this.callMcpTool("crm-finance", "update_deal_stage", { dealId, stage: "won", note: "stripe webhook" });
          }
          return { handled: Boolean(dealId) };
        }

        case "campaign_approved": {
          // Enqueues each approved-but-unsent message onto job_queue,
          // staggered 45s apart per recipient so orchestrator's Cron
          // consumer doesn't burst the SMTP connection (docs/06 §rate
          // limiting notes) — a crude but effective substitute for a real
          // rate-limited mail queue at this scale.
          const campaignId = (input.payload as { campaignId?: string }).campaignId;
          if (!campaignId) return { queued: 0 };

          const approved = await this.db
            .select()
            .from(schema.outreachMessages)
            .where(eq(schema.outreachMessages.campaignId, campaignId));
          const toSend = approved.filter((m) => m.status === "approved");

          const STAGGER_SECONDS = 45;
          for (const [i, message] of toSend.entries()) {
            await this.db.insert(schema.jobQueue).values({
              tenantId: input.tenantId,
              jobType: "send_outreach_message",
              payload: { outreachMessageId: message.id },
              runAfter: new Date(Date.now() + i * STAGGER_SECONDS * 1000),
            });
          }
          return { queued: toSend.length };
        }

        default:
          return { handled: false, reason: `no handler for eventType "${input.eventType}"` };
      }
    });

    return Response.json(output);
  }
}
