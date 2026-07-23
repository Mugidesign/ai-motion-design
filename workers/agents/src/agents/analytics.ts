import { BaseFactoryAgent } from "@factory/agent-kit";
import { schema } from "@factory/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { AnalyticsInputSchema, AnalyticsOutputSchema } from "@factory/shared-types";

const SUGGESTIONS_SYSTEM_PROMPT = `以下のKPIサマリーから、事業改善のための具体的な提案を2〜4件、日本語で簡潔に生成してください。
出力は必ず次のJSON Schemaのみ: { "summary": string, "suggestions": string[] }
数字の裏付けがない提案は避け、与えられたサマリーの数値に基づいてください。`;

export class AnalyticsAgent extends BaseFactoryAgent {
  protected agentName = "analytics";

  async onRequest(request: Request): Promise<Response> {
    const input = AnalyticsInputSchema.parse(await request.json());

    const output = await this.runWithLogging(input.tenantId, "分析・改善提案生成", input, async () => {
      const since = new Date(Date.now() - input.rangeDays * 24 * 60 * 60 * 1000);

      const [videoStats] = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(schema.videoProjects)
        .where(and(eq(schema.videoProjects.tenantId, input.tenantId), gte(schema.videoProjects.createdAt, since)));

      const [leadStats] = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(schema.leads)
        .where(and(eq(schema.leads.tenantId, input.tenantId), gte(schema.leads.createdAt, since)));

      const [messageStats] = await this.db
        .select({
          sent: sql<number>`count(*) filter (where status = 'sent' or status = 'replied')`,
          replied: sql<number>`count(*) filter (where status = 'replied')`,
        })
        .from(schema.outreachMessages)
        .innerJoin(schema.outreachCampaigns, eq(schema.outreachMessages.campaignId, schema.outreachCampaigns.id))
        .where(and(eq(schema.outreachCampaigns.tenantId, input.tenantId), gte(schema.outreachMessages.createdAt, since)));

      const [dealStats] = await this.db
        .select({
          won: sql<number>`count(*) filter (where stage = 'won')`,
          total: sql<number>`count(*)`,
          revenue: sql<number>`coalesce(sum(value_usd) filter (where stage = 'won'), 0)`,
        })
        .from(schema.deals)
        .where(and(eq(schema.deals.tenantId, input.tenantId), gte(schema.deals.createdAt, since)));

      const kpi = {
        rangeDays: input.rangeDays,
        videosGenerated: Number(videoStats?.count ?? 0),
        leadsFound: Number(leadStats?.count ?? 0),
        messagesSent: Number(messageStats?.sent ?? 0),
        replyRate: messageStats?.sent ? Number(messageStats.replied) / Number(messageStats.sent) : 0,
        winRate: dealStats?.total ? Number(dealStats.won) / Number(dealStats.total) : 0,
        revenueUsd: Number(dealStats?.revenue ?? 0),
      };

      await this.db
        .insert(schema.analyticsDailyRollups)
        .values({
          tenantId: input.tenantId,
          day: new Date().toISOString().slice(0, 10),
          videosGenerated: kpi.videosGenerated,
          leadsFound: kpi.leadsFound,
          messagesSent: kpi.messagesSent,
          replyRate: kpi.replyRate.toFixed(4),
          winRate: kpi.winRate.toFixed(4),
          revenueUsd: String(kpi.revenueUsd),
        })
        .onConflictDoUpdate({
          target: [schema.analyticsDailyRollups.tenantId, schema.analyticsDailyRollups.day],
          set: {
            videosGenerated: kpi.videosGenerated,
            leadsFound: kpi.leadsFound,
            messagesSent: kpi.messagesSent,
            replyRate: kpi.replyRate.toFixed(4),
            winRate: kpi.winRate.toFixed(4),
            revenueUsd: String(kpi.revenueUsd),
          },
        });

      const response = await this.callLLM({
        system: SUGGESTIONS_SYSTEM_PROMPT,
        userContent: JSON.stringify(kpi),
        maxTokens: 600,
      });
      const textBlock = response.content.find((b): b is { type: "text"; text: string } => b.type === "text");
      const parsed = textBlock ? JSON.parse(stripFences(textBlock.text)) : { summary: "", suggestions: [] };

      return AnalyticsOutputSchema.parse(parsed);
    });

    return Response.json(output);
  }
}

function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}
