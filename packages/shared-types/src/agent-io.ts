/**
 * Agent I/O contracts — the payloads Durable Object agents
 * (workers/agents/src/agents/*) accept and return. These are intentionally
 * thin; the heavy lifting schemas (video generation, lead search, etc.)
 * live in mcp-contracts.ts and are reused here.
 */
import { z } from "zod";
import { PromptSpecSchema } from "./mcp-contracts";

export const AgentNameSchema = z.enum([
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
]);
export type AgentName = z.infer<typeof AgentNameSchema>;

// ---- Prompt Engineer -------------------------------------------------------
export const PromptEngineerInputSchema = z.object({
  tenantId: z.string().uuid(),
  productId: z.string().uuid(),
});
export const PromptEngineerOutputSchema = z.object({
  promptSpec: PromptSpecSchema,
  copyVariants: z.array(z.string()).optional(),
});

// ---- Storyboard -------------------------------------------------------------
export const StoryboardInputSchema = z.object({
  tenantId: z.string().uuid(),
  promptSpec: PromptSpecSchema,
});
export const StoryboardScenSchema = z.object({
  order: z.number().int(),
  seconds: z.number(),
  shotDescription: z.string(),
});
export const StoryboardOutputSchema = z.object({
  scenes: z.array(StoryboardScenSchema),
});

// ---- Motion Designer --------------------------------------------------------
export const MotionDesignerInputSchema = z.object({
  tenantId: z.string().uuid(),
  productId: z.string().uuid(),
  promptSpec: PromptSpecSchema,
  durationVariant: z.enum(["15s", "30s", "60s"]),
  qualityTier: z.enum(["draft", "final"]).default("draft"),
});
export const MotionDesignerOutputSchema = z.object({
  videoProjectId: z.string().uuid(),
  jobId: z.string(),
  provider: z.string(),
});

// ---- QA ----------------------------------------------------------------------
export const QaInputSchema = z.object({
  tenantId: z.string().uuid(),
  videoAssetIds: z.array(z.string().uuid()),
});
export const QaOutputSchema = z.object({
  status: z.enum(["passed", "flagged"]),
  flaggedIds: z.array(z.string().uuid()).default([]),
  notes: z.record(z.string()).optional(),
});

// ---- Lead Finder ---------------------------------------------------------
export const LeadFinderInputSchema = z.object({
  tenantId: z.string().uuid(),
  sources: z.array(z.string()).min(1),
  industry: z.string().optional(),
  region: z.string().optional(),
  maxResults: z.number().int().default(50),
});
export const LeadFinderOutputSchema = z.object({
  leadIds: z.array(z.string().uuid()),
  skippedSources: z.array(z.string()).default([]), // e.g. non-compliant sources refused, see docs/05
});

// ---- Sales Agent -----------------------------------------------------------
export const SalesDraftInputSchema = z.object({
  tenantId: z.string().uuid(),
  leadIds: z.array(z.string().uuid()),
  campaignId: z.string().uuid(),
});
export const SalesDraftOutputSchema = z.object({
  draftedMessageIds: z.array(z.string().uuid()),
  skipped: z.array(z.object({ leadId: z.string().uuid(), reason: z.string() })).default([]),
});

// ---- CRM ---------------------------------------------------------------------
export const CrmUpdateInputSchema = z.object({
  tenantId: z.string().uuid(),
  dealId: z.string().uuid(),
  triggerEvent: z.enum(["reply_received", "manual_update", "invoice_paid"]),
  context: z.record(z.unknown()).optional(),
});

// ---- Finance -----------------------------------------------------------------
export const FinanceInputSchema = z.object({
  tenantId: z.string().uuid(),
  dealId: z.string().uuid(),
  action: z.enum(["create_invoice", "record_payment", "propose_upsell"]),
});

// ---- Analytics -----------------------------------------------------------
export const AnalyticsInputSchema = z.object({
  tenantId: z.string().uuid(),
  rangeDays: z.number().int().default(30),
});
export const AnalyticsOutputSchema = z.object({
  summary: z.string(),
  suggestions: z.array(z.string()),
});

// ---- Automation (orchestration-adjacent, ad hoc coordination) -----------
export const AutomationEventInputSchema = z.object({
  tenantId: z.string().uuid(),
  eventType: z.string(),
  payload: z.record(z.unknown()),
});
