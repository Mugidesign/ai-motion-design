import type { VideoProviderAdapter } from "./types";
import { MockProvider } from "./mock";
import { RunwayProvider } from "./runway";
import { KlingProvider } from "./kling";
import { OssSelfHostedProvider } from "./oss-selfhosted";
import type { VideoProvider } from "@factory/shared-types";

export interface ProviderEnv {
  RUNWAY_API_KEY?: string;
  KLING_API_KEY?: string;
  LUMA_API_KEY?: string;
  PIKA_API_KEY?: string;
  VEO_API_KEY?: string;
  HIGGSFIELD_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OSS_VIDEO_ENDPOINT_URL?: string; // your Wan2.1/HunyuanVideo server — see providers/oss-selfhosted.ts
  OSS_VIDEO_API_KEY?: string; // optional shared secret if you put one in front of the endpoint
}

/**
 * Providers with a written adapter below. luma / pika / veo / higgsfield /
 * openai are declared in the shared VideoProviderSchema (they're valid
 * choices in the UI and API) but throw a clear NotImplementedError here
 * until an adapter is added — copy runway.ts or kling.ts as the template,
 * it's the same three-method shape for every provider.
 *
 * "oss-selfhosted" is the recommended default once you want real output
 * instead of mock's placeholder — see infra/oss-video-server/ for a
 * Wan2.1 server deployable on Lightning AI's free GPU tier, and
 * docs/06-oss-free-stack.md for the feasibility notes.
 */
const IMPLEMENTED: VideoProvider[] = ["mock", "runway", "kling", "oss-selfhosted"];

export function getProviderAdapter(provider: VideoProvider, env: ProviderEnv): VideoProviderAdapter {
  switch (provider) {
    case "mock":
      return new MockProvider();
    case "oss-selfhosted":
      if (!env.OSS_VIDEO_ENDPOINT_URL) throw new Error("OSS_VIDEO_ENDPOINT_URL is not set");
      return new OssSelfHostedProvider(env.OSS_VIDEO_ENDPOINT_URL, env.OSS_VIDEO_API_KEY);
    case "runway":
      if (!env.RUNWAY_API_KEY) throw new Error("RUNWAY_API_KEY is not set");
      return new RunwayProvider(env.RUNWAY_API_KEY);
    case "kling":
      if (!env.KLING_API_KEY) throw new Error("KLING_API_KEY is not set");
      return new KlingProvider(env.KLING_API_KEY);
    default:
      throw new Error(
        `No adapter implemented yet for provider "${provider}". ` +
          `Implemented: ${IMPLEMENTED.join(", ")}. ` +
          `Copy providers/runway.ts as a template to add it.`
      );
  }
}

export function listAvailableProviders(env: ProviderEnv): { provider: VideoProvider; configured: boolean }[] {
  return [
    { provider: "mock", configured: true },
    { provider: "oss-selfhosted", configured: Boolean(env.OSS_VIDEO_ENDPOINT_URL) },
    { provider: "runway", configured: Boolean(env.RUNWAY_API_KEY) },
    { provider: "kling", configured: Boolean(env.KLING_API_KEY) },
    { provider: "luma", configured: Boolean(env.LUMA_API_KEY) },
    { provider: "pika", configured: Boolean(env.PIKA_API_KEY) },
    { provider: "veo", configured: Boolean(env.VEO_API_KEY) },
    { provider: "higgsfield", configured: Boolean(env.HIGGSFIELD_API_KEY) },
    { provider: "openai", configured: Boolean(env.OPENAI_API_KEY) },
  ];
}
