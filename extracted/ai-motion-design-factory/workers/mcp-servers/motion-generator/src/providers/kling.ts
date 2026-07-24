import type { VideoProviderAdapter } from "./types";
import { durationVariantToSeconds } from "./types";
import type { GenerateVideoInput, GenerateVideoOutput, CheckGenerationStatusOutput } from "@factory/shared-types";

/**
 * Kling adapter — second reference implementation (see runway.ts for the
 * full verification checklist; the same caveats apply here: endpoint
 * shape is a best-effort mapping onto Kling's documented async pattern,
 * unverified against a live key in this environment).
 */
export class KlingProvider implements VideoProviderAdapter {
  private baseUrl = "https://api-singapore.klingai.com/v1";

  constructor(private apiKey: string) {}

  async startGeneration(input: GenerateVideoInput): Promise<GenerateVideoOutput> {
    const res = await fetch(`${this.baseUrl}/videos/image2video`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        image: input.sourceImageUrl,
        prompt: input.promptSpec.composition,
        duration: String(durationVariantToSeconds(input.durationVariant)),
      }),
    });
    if (!res.ok) throw new Error(`Kling generation request failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { data: { task_id: string } };
    return { jobId: data.data.task_id, provider: "kling", status: "queued" };
  }

  async checkStatus(jobId: string): Promise<CheckGenerationStatusOutput> {
    const res = await fetch(`${this.baseUrl}/videos/image2video/${jobId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    const data = (await res.json()) as {
      data: { task_status: string; task_result?: { videos: { url: string }[] } };
    };
    const statusMap: Record<string, CheckGenerationStatusOutput["status"]> = {
      submitted: "queued",
      processing: "processing",
      succeed: "succeeded",
      failed: "failed",
    };
    return {
      jobId,
      status: statusMap[data.data.task_status] ?? "processing",
      outputUrl: data.data.task_result?.videos?.[0]?.url,
    };
  }

  estimateCost(durationVariant: "15s" | "30s" | "60s", qualityTier: "draft" | "final"): number {
    const perSecondUsd = 0.035; // placeholder heuristic, confirm against current published pricing
    const base = durationVariantToSeconds(durationVariant) * perSecondUsd;
    return qualityTier === "final" ? Number((base * 1.6).toFixed(4)) : Number(base.toFixed(4));
  }
}
