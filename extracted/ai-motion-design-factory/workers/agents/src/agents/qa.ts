import { BaseFactoryAgent } from "@factory/agent-kit";
import { schema } from "@factory/db";
import { eq, inArray } from "drizzle-orm";
import { QaInputSchema, QaOutputSchema } from "@factory/shared-types";

/** Acceptable drift between the requested duration variant and what the
 *  provider actually rendered, before flagging for regeneration. */
const DURATION_TOLERANCE_SECONDS = 2;

const EXPECTED_SECONDS: Record<string, number> = { "15s": 15, "30s": 30, "60s": 60 };

export class QaAgent extends BaseFactoryAgent {
  protected agentName = "qa";

  async onRequest(request: Request): Promise<Response> {
    const input = QaInputSchema.parse(await request.json());

    const output = await this.runWithLogging(input.tenantId, "動画QAチェック", input, async () => {
      const assets = await this.db
        .select({ asset: schema.videoAssets, project: schema.videoProjects })
        .from(schema.videoAssets)
        .innerJoin(schema.videoProjects, eq(schema.videoAssets.videoProjectId, schema.videoProjects.id))
        .where(inArray(schema.videoAssets.id, input.videoAssetIds));

      const flaggedIds: string[] = [];
      const notes: Record<string, string> = {};

      for (const { asset, project } of assets) {
        const issues: string[] = [];

        // 1. Structural checks (always run, no model call needed)
        if (!asset.r2Key || asset.r2Key.length === 0) issues.push("missing output file");
        const expected = EXPECTED_SECONDS[project.durationVariant];
        const actual = asset.durationSeconds ? Number(asset.durationSeconds) : undefined;
        if (expected && actual !== undefined && Math.abs(actual - expected) > DURATION_TOLERANCE_SECONDS) {
          issues.push(`duration ${actual}s deviates from requested ${project.durationVariant}`);
        }
        if (!asset.captionsR2Key) issues.push("captions missing (should be attached before client delivery)");

        // 2. Content-level checks are a TODO extension point: run the
        //    thumbnail through a Workers AI vision model (e.g.
        //    @cf/llava-hf/llava-1.5-7b-hf or a hosted moderation model) to
        //    catch brand-inconsistent or inappropriate frames before they
        //    reach a portfolio or a lead. Not implemented in this scaffold
        //    — structural checks above are what actually block publish.

        const status = issues.length > 0 ? "flagged" : "passed";
        if (status === "flagged") {
          flaggedIds.push(asset.id);
          notes[asset.id] = issues.join("; ");
        }

        await this.db.update(schema.videoAssets).set({ qaStatus: status, qaNotes: { issues } }).where(eq(schema.videoAssets.id, asset.id));
      }

      return QaOutputSchema.parse({
        status: flaggedIds.length > 0 ? "flagged" : "passed",
        flaggedIds,
        notes,
      });
    });

    return Response.json(output);
  }
}
