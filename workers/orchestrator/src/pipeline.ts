/**
 * The step logic for the product -> video -> portfolio -> leads ->
 * outreach pipeline (docs/03 §3.1), as a small state machine driven by
 * workers/orchestrator/src/index.ts's Cron Trigger handler.
 *
 * This replaces a Cloudflare Workflows-based implementation — Workflows'
 * free-tier status was unclear enough (unlike SQLite-backed Durable
 * Objects, which are confirmed free-tier eligible) that a Postgres state
 * machine felt like the more honestly-free choice, and it has the side
 * benefit of keeping the whole orchestration layer inspectable with plain
 * SQL (`select * from pipeline_runs`) instead of a proprietary dashboard.
 * See docs/06-oss-free-stack.md.
 *
 * Each case below is one "step.do" would have been in the old Workflows
 * version — same idea (do the work, checkpoint the result), just
 * persisted to a row instead of the Workflows engine's internal state.
 */
import { createDb, schema } from "@factory/db";
import { callAgent, type AgentCallEnv } from "./agentClient";
import type { PromptSpec } from "@factory/shared-types";

export interface Env extends AgentCallEnv {
  DATABASE_URL: string;
}

export interface PipelineParams {
  tenantId: string;
  productId: string;
  autoFindLeads?: boolean;
  leadSearch?: { sources: string[]; industry?: string; region?: string; maxResults?: number };
}

export const STEP_ORDER = [
  "analyze-product",
  "build-storyboard",
  "generate-video-variants",
  "qa-check",
  "publish-portfolio",
  "find-leads",
  "draft-outreach",
  "done",
] as const;

type VariantResult = { durationVariant: "15s" | "30s" | "60s"; videoProjectId: string; videoAssetId: string };

export interface PipelineRunRow {
  id: string;
  params: unknown;
  stepState: unknown;
  currentStep: string;
}

export interface StepResult {
  nextStep: (typeof STEP_ORDER)[number];
  stepStatePatch: Record<string, unknown>;
}

export async function runStep(env: Env, run: PipelineRunRow): Promise<StepResult> {
  const { tenantId, productId, autoFindLeads = false, leadSearch } = run.params as PipelineParams;
  const state = (run.stepState ?? {}) as Record<string, unknown>;

  switch (run.currentStep) {
    case "analyze-product": {
      const result = await callAgent<{ promptSpec: PromptSpec }>(env, "prompt-engineer", tenantId, { tenantId, productId });
      return { nextStep: "build-storyboard", stepStatePatch: { promptSpec: result.promptSpec } };
    }

    case "build-storyboard": {
      await callAgent(env, "storyboard", tenantId, { tenantId, promptSpec: state.promptSpec });
      return { nextStep: "generate-video-variants", stepStatePatch: {} };
    }

    case "generate-video-variants": {
      const durations: Array<"15s" | "30s" | "60s"> = ["15s", "30s", "60s"];
      const variants = await Promise.all(
        durations.map((durationVariant) =>
          callAgent<{ videoProjectId: string; videoAssetId: string }>(env, "motion-designer", tenantId, {
            tenantId,
            productId,
            promptSpec: state.promptSpec,
            durationVariant,
            qualityTier: "draft",
          }).then((r) => ({ durationVariant, ...r }) as VariantResult)
        )
      );
      return { nextStep: "qa-check", stepStatePatch: { variants } };
    }

    case "qa-check": {
      const variants = state.variants as VariantResult[];
      const qa = await callAgent<{ status: string; flaggedIds: string[] }>(env, "qa", tenantId, {
        tenantId,
        videoAssetIds: variants.map((v) => v.videoAssetId),
      });

      if (qa.status === "flagged" && qa.flaggedIds.length > 0) {
        const flagged = variants.filter((v) => qa.flaggedIds.includes(v.videoAssetId));
        const regenerated = await Promise.all(
          flagged.map((v) =>
            callAgent<{ videoProjectId: string; videoAssetId: string }>(env, "motion-designer", tenantId, {
              tenantId,
              productId,
              promptSpec: state.promptSpec,
              durationVariant: v.durationVariant,
              qualityTier: "draft",
            }).then((r) => ({ durationVariant: v.durationVariant, ...r }) as VariantResult)
          )
        );
        const merged = variants.map((v) => regenerated.find((r) => r.durationVariant === v.durationVariant) ?? v);
        return { nextStep: "publish-portfolio", stepStatePatch: { variants: merged } };
      }
      return { nextStep: "publish-portfolio", stepStatePatch: {} };
    }

    case "publish-portfolio": {
      const variants = state.variants as VariantResult[];
      const portfolio = await callAgent<{ publishedUrl: string }>(env, "video-director", tenantId, {
        tenantId,
        videoProjectIds: variants.map((v) => v.videoProjectId),
      });
      return {
        nextStep: autoFindLeads ? "find-leads" : "done",
        stepStatePatch: { portfolio },
      };
    }

    case "find-leads": {
      const leadResult = await callAgent<{ leadIds: string[] }>(env, "lead-finder", tenantId, {
        tenantId,
        sources: leadSearch?.sources ?? ["google_maps", "own_site"],
        industry: leadSearch?.industry,
        region: leadSearch?.region,
        maxResults: leadSearch?.maxResults ?? 25,
      });
      return { nextStep: "draft-outreach", stepStatePatch: { leadIds: leadResult.leadIds } };
    }

    case "draft-outreach": {
      const db = createDb(env.DATABASE_URL);
      const [campaign] = await db
        .insert(schema.outreachCampaigns)
        .values({ tenantId, name: `Auto campaign ${new Date().toISOString()}`, channel: "email", requiresHumanApproval: true })
        .returning();

      const draft = await callAgent<{ draftedMessageIds: string[] }>(env, "sales", tenantId, {
        tenantId,
        leadIds: state.leadIds,
        campaignId: campaign!.id,
      });

      // Pipeline's job ends here — it produced reviewable drafts. Approval
      // and actual sending happen via POST /campaigns/:id/approve
      // (api-gateway) and the job_queue consumer (index.ts's scheduled
      // handler), not by this pipeline waiting around for a human.
      return {
        nextStep: "done",
        stepStatePatch: { campaignId: campaign!.id, outreachDrafted: draft.draftedMessageIds.length },
      };
    }

    default:
      throw new Error(`unknown pipeline step "${run.currentStep}"`);
  }
}
