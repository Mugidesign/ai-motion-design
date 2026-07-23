import type { VideoProviderAdapter } from "./types";
import { durationVariantToSeconds } from "./types";
import type { GenerateVideoInput, GenerateVideoOutput, CheckGenerationStatusOutput } from "@factory/shared-types";

/**
 * oss-selfhosted — calls a small inference HTTP server you run yourself,
 * wrapping an open-weight video model (Wan2.1/2.2, HunyuanVideo, LTX-Video,
 * ...). A companion FastAPI server implementing this exact contract for
 * Wan2.1 is at infra/oss-video-server/ — it's designed to be deployed on a
 * free GPU tier such as Lightning AI Studios (T4/L4/A10G, ~80 free
 * GPU-hours/month as of this writing) so the whole default stack, model
 * included, costs $0. See docs/06-oss-free-stack.md §Motion Generator for
 * the feasibility notes and setup steps, and infra/oss-video-server/README.md
 * for deployment.
 *
 * This adapter itself is generic — any server that speaks this small
 * job-based contract works, whether it's on Lightning AI, your own GPU,
 * RunPod, or a rented box. Only OSS_VIDEO_ENDPOINT_URL changes.
 */
export class OssSelfHostedProvider implements VideoProviderAdapter {
  constructor(private endpointUrl: string, private apiKey?: string) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    return headers;
  }

  async startGeneration(input: GenerateVideoInput): Promise<GenerateVideoOutput> {
    const res = await fetch(`${this.endpointUrl}/generate`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        prompt: buildPrompt(input),
        image_url: input.sourceImageUrl,
        duration_seconds: durationVariantToSeconds(input.durationVariant),
        // 480p by default — the resolution most Wan2.1/HunyuanVideo variants
        // run comfortably on a free-tier 16-24GB GPU within a few minutes.
        // Bump to 720p in the server config once you know your model +
        // GPU combination handles it in acceptable time (docs/06).
        resolution: "480p",
      }),
    });
    if (!res.ok) {
      throw new Error(`oss-selfhosted generation request failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { job_id: string };
    return { jobId: data.job_id, provider: "oss-selfhosted", status: "queued", estimatedCostUsd: 0 };
  }

  async checkStatus(jobId: string): Promise<CheckGenerationStatusOutput> {
    const res = await fetch(`${this.endpointUrl}/status/${jobId}`, { headers: this.headers() });
    if (!res.ok) {
      return { jobId, status: "failed", error: `status check failed: ${res.status}` };
    }
    const data = (await res.json()) as {
      status: "queued" | "processing" | "succeeded" | "failed";
      output_url?: string;
      thumbnail_url?: string;
      duration_seconds?: number;
      error?: string;
    };
    return {
      jobId,
      status: data.status,
      outputUrl: data.output_url,
      thumbnailUrl: data.thumbnail_url,
      durationSeconds: data.duration_seconds,
      error: data.error,
    };
  }

  estimateCost(): number {
    // $0 against Lightning AI's free GPU-hours allocation. Once you exceed
    // the free monthly allowance (or run on rented GPU time instead), the
    // real cost is GPU-time-based, not per-video — track it manually or
    // extend this to read GPU-hours-used from your own metering.
    return 0;
  }
}

function buildPrompt(input: GenerateVideoInput): string {
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
