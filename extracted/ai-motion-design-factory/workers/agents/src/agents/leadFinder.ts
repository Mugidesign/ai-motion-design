import type { z } from "zod";
import { BaseFactoryAgent } from "@factory/agent-kit";
import { schema } from "@factory/db";
import {
  LeadFinderInputSchema,
  LeadFinderOutputSchema,
  LeadSourceSchema,
  type CompanyCandidate,
} from "@factory/shared-types";

const SCORING_SYSTEM_PROMPT = `あなたはAI Motion Design Factoryの Lead Finder Agent です。
企業の公開サイトから取得した構造化シグナル(title/description/hasVideoTag/detectedSocialLinks)を見て、
0.0〜1.0の ad_quality_score, video_quality_score, deal_probability と、改善提案テキストを1つ返してください。
出力は必ず次のJSON Schemaのみ:
{ "adQualityScore": number, "videoQualityScore": number, "dealProbability": number, "improvementNotes": string }
シグナルが乏しい場合は保守的に低いスコアを返してください。`;

export class LeadFinderAgent extends BaseFactoryAgent {
  protected agentName = "lead-finder";

  async onRequest(request: Request): Promise<Response> {
    const input = LeadFinderInputSchema.parse(await request.json());

    const output = await this.runWithLogging(input.tenantId, "リード探索", input, async () => {
      // Only sources present in LeadSourceSchema are valid — this rejects
      // e.g. "linkedin_scrape" here even if some future caller tried to
      // pass it, on top of the MCP server's own refusal (docs/05 §3.1).
      const validSources = input.sources.filter((s) => LeadSourceSchema.safeParse(s).success) as z.infer<
        typeof LeadSourceSchema
      >[];
      const skippedSources = input.sources.filter((s) => !validSources.includes(s as any));

      const searchResult = await this.callMcpTool<{ candidates: CompanyCandidate[]; skippedSources: string[] }>(
        "lead-enrichment",
        "search_companies",
        {
          tenantId: input.tenantId,
          sources: validSources,
          query: { industry: input.industry, region: input.region },
          maxResults: input.maxResults,
        }
      );

      const leadIds: string[] = [];
      for (const candidate of searchResult.candidates) {
        let scoring: {
          adQualityScore?: number;
          videoQualityScore?: number;
          dealProbability?: number;
          improvementNotes?: string;
        } = {};

        if (candidate.websiteUrl) {
          try {
            const enrichment = await this.callMcpTool<{ signals: unknown }>("lead-enrichment", "enrich_company", {
              companyName: candidate.companyName,
              websiteUrl: candidate.websiteUrl,
            });
            const response = await this.callLLM({
              system: SCORING_SYSTEM_PROMPT,
              userContent: JSON.stringify(enrichment.signals ?? {}),
              maxTokens: 400,
            });
            const textBlock = response.content.find((b): b is { type: "text"; text: string } => b.type === "text");
            if (textBlock) scoring = JSON.parse(stripFences(textBlock.text));
          } catch {
            // Enrichment/scoring is best-effort — a lead with no score is
            // still useful (manual review), so we don't fail the whole run.
          }
        }

        const [lead] = await this.db
          .insert(schema.leads)
          .values({
            tenantId: input.tenantId,
            companyName: candidate.companyName,
            contactName: candidate.contactName,
            contactEmail: candidate.contactEmail,
            socials: candidate.socials ?? {},
            source: candidate.source,
            sourceProvider: candidate.sourceProvider,
            adQualityScore: scoring.adQualityScore?.toFixed(2),
            videoQualityScore: scoring.videoQualityScore?.toFixed(2),
            dealProbability: scoring.dealProbability?.toFixed(2),
            improvementNotes: scoring.improvementNotes,
            status: "enriched",
          })
          .returning();
        leadIds.push(lead!.id);
      }

      return LeadFinderOutputSchema.parse({
        leadIds,
        skippedSources: [...skippedSources, ...searchResult.skippedSources],
      });
    });

    return Response.json(output);
  }
}

function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? (fenced[1] ?? text) : text).trim();
}
