import type { VideoProviderAdapter } from "./types";
import { durationVariantToSeconds } from "./types";
import type {
  GenerateVideoInput,
  GenerateVideoOutput,
  CheckGenerationStatusOutput,
} from "@factory/shared-types";

/**
 * Runway adapter — reference implementation of the "real provider" shape.
 *
 * IMPORTANT: the endpoint paths, header names, and request/response fields
 * below are a best-effort mapping onto Runway's documented async
 * create-task -> poll-status pattern. They have NOT been verified against
 * a live account in this environment (no network access here). Before
 * enabling RUNWAY_API_KEY in production:
 *   1. Confirm current base URL / endpoint paths / required version header
 *      at https://docs.dev.runwayml.com
 *   2. Confirm request and response field names match what's read below
 *   3. Add a contract test that hits a real Runway sandbox key in CI
 *
 * Use this file as the template for the luma / pika / veo / higgsfield /
 * openai adapters referenced in ./index.ts — same shape, different vendor.
 */
export class RunwayProvider implements VideoProviderAdapter {
  private baseUrl = "https://api.dev.runwayml.com/v1";

  constructor(private apiKey: string) {}

  async startGeneration(input: GenerateVideoInput): Promise<GenerateVideoOutput> {
    const res = await fetch(`${this.baseUrl}/image_to_video`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "X-Runway-Version": "2024-11-06", // verify current version string
      },
      body: JSON.stringify({
        promptImage: input.sourceImageUrl,
        promptText: buildRunwayPrompt(input),
        duration: durationVariantToSeconds(input.durationVariant),
        ratio: "768:1280", // vertical, ad-format default — make configurable per brand_config
      }),
    });

    if (!res.ok) {
      throw new Error(`Runway generation request failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { id: string };
    return { jobId: data.id, provider: "runway", status: "queued" };
  }

  async checkStatus(jobId: string): Promise<CheckGenerationStatusOutput> {
    const res = await fetch(`${this.baseUrl}/tasks/${jobId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}`, "X-Runway-Version": "2024-11-06" },
    });
    if (!res.ok) {
      return { jobId, status: "failed", error: `status check failed: ${res.status}` };
    }
    const data = (await res.json()) as {
      status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
      output?: string[];
      failure?: string;
    };

    const statusMap: Record<string, CheckGenerationStatusOutput["status"]> = {
      PENDING: "queued",
      RUNNING: "processing",
      SUCCEEDED: "succeeded",
      FAILED: "failed",
    };

    return {
      jobId,
      status: statusMap[data.status] ?? "processing",
      outputUrl: data.output?.[0],
      error: data.failure,
    };
  }

  estimateCost(durationVariant: "15s" | "30s" | "60s", qualityTier: "draft" | "final"): number {
    // Placeholder heuristic, NOT Runway's published pricing — replace with
    // real per-second rates once confirmed, and prefer estimating from
    // Runway's account usage API where available.
    const perSecondUsd = 0.05;
    const base = durationVariantToSeconds(durationVariant) * perSecondUsd;
    return qualityTier === "final" ? Number((base * 1.8).toFixed(4)) : Number(base.toFixed(4));
  }
}

function buildRunwayPrompt(input: GenerateVideoInput): string {
  const { composition, cameraWork, colorPalette, bgmMood, cta } = input.promptSpec;
  return [
    composition,
    `Camera: ${cameraWork}.`,
    colorPalette.length ? `Palette: ${colorPalette.join(", ")}.` : "",
    bgmMood ? `Mood: ${bgmMood}.` : "",
    cta ? `End card: ${cta}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
