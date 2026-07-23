import type { VideoProviderAdapter } from "./types";
import { durationVariantToSeconds } from "./types";
import type {
  GenerateVideoInput,
  GenerateVideoOutput,
  CheckGenerationStatusOutput,
} from "@factory/shared-types";

/**
 * Mock provider — the only provider that requires zero API keys.
 * This is what MOTION_GENERATOR_DEFAULT_PROVIDER points to out of the box,
 * so the full pipeline (Studio upload -> generation -> QA -> portfolio) is
 * runnable end-to-end on a fresh checkout before any provider account is
 * set up. Swap in a real provider by setting the corresponding *_API_KEY
 * in .env and passing `preferredProvider` explicitly, or by changing
 * MOTION_GENERATOR_DEFAULT_PROVIDER in wrangler.jsonc.
 *
 * State is encoded in the jobId itself (base64 JSON) rather than stored
 * anywhere, since this provider only needs to simulate the passage of time
 * between "queued" and "succeeded" — no external system to poll.
 */
export class MockProvider implements VideoProviderAdapter {
  private static SIMULATED_RENDER_SECONDS = 8;

  async startGeneration(input: GenerateVideoInput): Promise<GenerateVideoOutput> {
    const payload = {
      startedAt: Date.now(),
      variant: input.durationVariant,
      waitSeconds: MockProvider.SIMULATED_RENDER_SECONDS,
    };
    const jobId = `mock_${btoa(JSON.stringify(payload))}`;
    return { jobId, provider: "mock", status: "queued", estimatedCostUsd: 0 };
  }

  async checkStatus(jobId: string): Promise<CheckGenerationStatusOutput> {
    const raw = jobId.replace(/^mock_/, "");
    let payload: { startedAt: number; variant: "15s" | "30s" | "60s"; waitSeconds: number };
    try {
      payload = JSON.parse(atob(raw));
    } catch {
      return { jobId, status: "failed", error: "malformed mock job id" };
    }

    const elapsedSeconds = (Date.now() - payload.startedAt) / 1000;
    if (elapsedSeconds < payload.waitSeconds) {
      return { jobId, status: "processing" };
    }

    return {
      jobId,
      status: "succeeded",
      // Not a real file — the QA agent and portfolio renderer should treat
      // any `mock://` output as a placeholder and render a "sample" badge.
      // Upload a short real clip to R2 at these keys for demos:
      //   assets/mock-samples/{15s,30s,60s}.mp4
      outputUrl: `mock://placeholder/${payload.variant}.mp4`,
      thumbnailUrl: `mock://placeholder/${payload.variant}.jpg`,
      durationSeconds: durationVariantToSeconds(payload.variant),
    };
  }

  estimateCost(): number {
    return 0;
  }
}
