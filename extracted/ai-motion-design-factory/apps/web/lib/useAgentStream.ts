"use client";

import { useAgent } from "agents/react";
import { useAuth } from "@/lib/auth-context";

const AGENTS_WORKER_URL = process.env.NEXT_PUBLIC_AGENTS_WORKER_URL ?? "http://localhost:8788";

export interface AgentStatusState {
  status: "idle" | "running" | "awaiting_approval" | "error";
  currentTask?: string;
  lastRunAt?: string;
  lastError?: string;
  runsToday?: number;
}

export const AGENT_SLUGS = [
  "prompt-engineer",
  "storyboard",
  "motion-designer",
  "video-director",
  "copywriter",
  "lead-finder",
  "sales",
  "crm",
  "finance",
  "qa",
  "knowledge",
  "analytics",
  "automation",
] as const;

export type AgentSlug = (typeof AGENT_SLUGS)[number];

export const AGENT_LABELS: Record<AgentSlug, string> = {
  "prompt-engineer": "Prompt Engineer",
  storyboard: "Storyboard",
  "motion-designer": "Motion Designer",
  "video-director": "Video Director",
  copywriter: "Copywriter",
  "lead-finder": "Lead Finder",
  sales: "Sales",
  crm: "CRM",
  finance: "Finance",
  qa: "QA",
  knowledge: "Knowledge",
  analytics: "Analytics",
  automation: "Automation",
};

/**
 * Connects directly to one agent's Durable Object over WebSocket via the
 * `agents` package's React hook — this bypasses the API Gateway entirely
 * (docs/04 §1.3), which is why it needs its own `host` pointing at the
 * agents Worker's public URL rather than going through NEXT_PUBLIC_API_GATEWAY_URL.
 *
 * VERIFY: `useAgent`'s exact option names (`agent`, `name`, `host`,
 * `onStateUpdate`) against the current `agents/react` package — the shape
 * used here matches Cloudflare's documented agents-starter template as of
 * this scaffold's authoring, but this package is under active development.
 */
export function useAgentStream(agentSlug: AgentSlug, onStateUpdate?: (state: AgentStatusState) => void) {
  const { tenantId } = useAuth();

  return useAgent({
    agent: agentSlug,
    name: tenantId ?? "unknown-tenant",
    host: AGENTS_WORKER_URL,
    onStateUpdate: (state: AgentStatusState) => onStateUpdate?.(state),
  });
}
