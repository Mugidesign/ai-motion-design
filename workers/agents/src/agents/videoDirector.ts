import { BaseFactoryAgent } from "@factory/agent-kit";
import { schema } from "@factory/db";
import { inArray } from "drizzle-orm";
import { z } from "zod";

const InputSchema = z.object({
  tenantId: z.string().uuid(),
  videoProjectIds: z.array(z.string().uuid()).min(1),
  theme: z.record(z.unknown()).optional(),
});

/**
 * PORTFOLIO_BASE_URL should point at wherever apps/web (or a dedicated
 * portfolio-renderer app, per docs/01 directory layout) serves
 * /p/:slug — swap for your actual production domain.
 */
const PORTFOLIO_BASE_URL = "https://portfolio.yourdomain.example";

export class VideoDirectorAgent extends BaseFactoryAgent {
  protected agentName = "video-director";

  async onRequest(request: Request): Promise<Response> {
    const input = InputSchema.parse(await request.json());

    const output = await this.runWithLogging(input.tenantId, "ポートフォリオ公開", input, async () => {
      const assets = await this.db
        .select()
        .from(schema.videoAssets)
        .where(inArray(schema.videoAssets.videoProjectId, input.videoProjectIds));

      const passedAssets = assets.filter((a) => a.qaStatus !== "flagged");
      if (passedAssets.length === 0) {
        throw new Error("no QA-passed assets available to publish — run the QA agent first");
      }

      const slug = `${input.tenantId.slice(0, 8)}-${Date.now().toString(36)}`;

      const [site] = await this.db
        .insert(schema.portfolioSites)
        .values({
          tenantId: input.tenantId,
          slug,
          publishedUrl: `${PORTFOLIO_BASE_URL}/p/${slug}`,
          videoProjectIds: input.videoProjectIds,
          theme: input.theme ?? {},
          publishedAt: new Date(),
        })
        .returning();

      return { portfolioSiteId: site!.id, publishedUrl: site!.publishedUrl, videoCount: passedAssets.length };
    });

    return Response.json(output);
  }
}
