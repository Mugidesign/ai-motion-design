import type {
  GenerateVideoInput,
  GenerateVideoOutput,
  CheckGenerationStatusOutput,
} from "@factory/shared-types";

export interface VideoProviderAdapter {
  startGeneration(input: GenerateVideoInput): Promise<GenerateVideoOutput>;
  checkStatus(jobId: string): Promise<CheckGenerationStatusOutput>;
  estimateCost(durationVariant: "15s" | "30s" | "60s", qualityTier: "draft" | "final"): number;
}

export function durationVariantToSeconds(v: "15s" | "30s" | "60s"): number {
  return v === "15s" ? 15 : v === "30s" ? 30 : 60;
}
