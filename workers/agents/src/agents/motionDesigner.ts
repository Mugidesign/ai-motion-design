import { BaseFactoryAgent } from "@factory/agent-kit";
import { schema } from "@factory/db";
import { eq } from "drizzle-orm";
import {
  MotionDesignerInputSchema,
  type GenerateVideoOutput,
  type CheckGenerationStatusOutput,
} from "@factory/shared-types";

const POLL_INTERVAL_MS = 4000;
const MAX_POLLS = 45; // ~3 minutes; long final-quality renders should move to a Queue-based poller instead (docs/05 §1)

export class MotionDesignerAgent extends BaseFactoryAgent {
  protected agentName = "motion-designer";

  async onRequest(request: Request): Promise<Response> {
    const input = MotionDesignerInputSchema.parse(await request.json());

    const output = await this.runWithLogging(
      input.tenantId,
      `動画生成 (${input.durationVariant}, ${input.qualityTier})`,
      input,
      async () => {
        const [project] = await this.db
          .insert(schema.videoProjects)
          .values({
            tenantId: input.tenantId,
            productId: input.productId,
            status: "generating",
            durationVariant: input.durationVariant,
            qualityTier: input.qualityTier,
            promptSpec: input.promptSpec,
          })
          .returning();

        const job = await this.callMcpTool<GenerateVideoOutput>("motion-generator", "generate_video", {
          productId: input.productId,
          durationVariant: input.durationVariant,
          promptSpec: input.promptSpec,
          qualityTier: input.qualityTier,
        });

        await this.db.update(schema.videoProjects).set({ provider: job.provider }).where(eq(schema.videoProjects.id, project!.id));

        const finalStatus = await this.pollUntilDone(job.jobId, job.provider);

        if (finalStatus.status !== "succeeded") {
          await this.db.update(schema.videoProjects).set({ status: "failed" }).where(eq(schema.videoProjects.id, project!.id));
          throw new Error(`generation failed: ${finalStatus.error ?? "unknown error"}`);
        }

        const [asset] = await this.db
          .insert(schema.videoAssets)
          .values({
            videoProjectId: project!.id,
            r2Key: finalStatus.outputUrl ?? "",
            thumbnailR2Key: finalStatus.thumbnailUrl,
            durationSeconds: finalStatus.durationSeconds ? String(finalStatus.durationSeconds) : undefined,
          })
          .returning();

        await this.db.update(schema.videoProjects).set({ status: "review" }).where(eq(schema.videoProjects.id, project!.id));

        return { videoProjectId: project!.id, videoAssetId: asset!.id, jobId: job.jobId, provider: job.provider };
      }
    );

    return Response.json(output);
  }

  /**
   * Simple in-request polling loop — fine for `mock`/draft-tier jobs that
   * resolve in seconds. For final-quality renders on real providers that
   * can take minutes, move this to a Cloudflare Queue consumer instead of
   * holding the agent (and its DO) busy-waiting; the Orchestrator Workflow
   * step already has its own retry/timeout policy for this reason
   * (docs/03 §3.1, the `generate-video-variants` step).
   */
  private async pollUntilDone(jobId: string, provider: string): Promise<CheckGenerationStatusOutput> {
    for (let i = 0; i < MAX_POLLS; i++) {
      const status = await this.callMcpTool<CheckGenerationStatusOutput>(
        "motion-generator",
        "check_generation_status",
        { jobId, provider }
      );
      if (status.status === "succeeded" || status.status === "failed") return status;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    return { jobId, status: "failed", error: "timed out waiting for generation" };
  }
}
