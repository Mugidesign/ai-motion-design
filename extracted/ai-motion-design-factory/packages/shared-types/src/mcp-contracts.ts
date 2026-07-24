/**
 * MCP tool contracts, shared between MCP server implementations
 * (workers/mcp-servers/*) and the agents that call them
 * (workers/agents/src/agents/*).
 *
 * Zod schemas double as runtime validation AND the source for the JSON
 * Schema each MCP server advertises in its `tools/list` response — see
 * zodToJsonSchema usage in each server's index.ts under workers/mcp-servers/.
 */
import { z } from "zod";

// ============================================================================
// motion-generator-mcp
// ============================================================================

export const VideoProviderSchema = z.enum([
  "runway",
  "luma",
  "pika",
  "kling",
  "veo",
  "higgsfield",
  "openai",
  "oss-selfhosted", // Wan2.1/HunyuanVideo etc. on your own GPU or a free tier like Lightning AI Studios
  "mock", // always available, no API key required — see providers/mock.ts
]);
export type VideoProvider = z.infer<typeof VideoProviderSchema>;

export const PromptSpecSchema = z.object({
  composition: z.string().describe("全体の構図・トーン"),
  cameraWork: z.string().describe("カメラワーク指示"),
  colorPalette: z.array(z.string()).default([]),
  bgmMood: z.string().optional(),
  captionsLocale: z.string().default("ja"),
  cta: z.string().optional(),
});
export type PromptSpec = z.infer<typeof PromptSpecSchema>;

export const GenerateVideoInputSchema = z.object({
  productId: z.string().uuid(),
  durationVariant: z.enum(["15s", "30s", "60s"]),
  promptSpec: PromptSpecSchema,
  preferredProvider: VideoProviderSchema.default("mock"),
  qualityTier: z.enum(["draft", "final"]).default("draft"),
  sourceImageUrl: z.string().url().optional(),
});
export type GenerateVideoInput = z.infer<typeof GenerateVideoInputSchema>;

export const GenerateVideoOutputSchema = z.object({
  jobId: z.string(),
  provider: VideoProviderSchema,
  status: z.enum(["queued", "processing", "succeeded", "failed"]),
  estimatedCostUsd: z.number().optional(),
});
export type GenerateVideoOutput = z.infer<typeof GenerateVideoOutputSchema>;

export const CheckGenerationStatusInputSchema = z.object({
  jobId: z.string(),
  provider: VideoProviderSchema,
});

export const CheckGenerationStatusOutputSchema = z.object({
  jobId: z.string(),
  status: z.enum(["queued", "processing", "succeeded", "failed"]),
  outputUrl: z.string().url().optional(),
  thumbnailUrl: z.string().url().optional(),
  durationSeconds: z.number().optional(),
  error: z.string().optional(),
});
export type CheckGenerationStatusOutput = z.infer<typeof CheckGenerationStatusOutputSchema>;

// ============================================================================
// lead-enrichment-mcp  (compliant sources only — docs/05 §3.1)
// ============================================================================

export const LeadSourceSchema = z.enum([
  "google_maps",
  "shopify",
  "kickstarter",
  "product_hunt",
  "crunchbase",
  "own_site",
  "search_engine",
  "csv_import",
]);
export type LeadSource = z.infer<typeof LeadSourceSchema>;

export const SearchCompaniesInputSchema = z.object({
  tenantId: z.string().uuid(),
  sources: z.array(LeadSourceSchema).min(1),
  query: z.object({
    industry: z.string().optional(),
    region: z.string().optional(),
    keyword: z.string().optional(),
  }),
  maxResults: z.number().int().min(1).max(200).default(50),
});

export const CompanyCandidateSchema = z.object({
  companyName: z.string(),
  contactName: z.string().optional(),
  contactEmail: z.string().email().optional(),
  socials: z.record(z.string()).optional(),
  source: LeadSourceSchema,
  sourceProvider: z.string().describe("実際に呼び出したデータプロバイダ名（監査/コンプライアンス用）"),
  websiteUrl: z.string().url().optional(),
});
export type CompanyCandidate = z.infer<typeof CompanyCandidateSchema>;

export const SearchCompaniesOutputSchema = z.object({
  candidates: z.array(CompanyCandidateSchema),
});

export const EnrichCompanyInputSchema = z.object({
  companyName: z.string(),
  websiteUrl: z.string().url().optional(),
});

export const EnrichCompanyOutputSchema = z.object({
  adQualityScore: z.number().min(0).max(1).optional(),
  videoQualityScore: z.number().min(0).max(1).optional(),
  improvementNotes: z.string().optional(),
  dealProbability: z.number().min(0).max(1).optional(),
});

export const CheckSuppressionInputSchema = z.object({
  tenantId: z.string().uuid(),
  email: z.string().email(),
});
export const CheckSuppressionOutputSchema = z.object({
  isSuppressed: z.boolean(),
  reason: z.string().optional(),
});

// ============================================================================
// communication-mcp
// ============================================================================

export const SendEmailInputSchema = z.object({
  tenantId: z.string().uuid(),
  leadId: z.string().uuid(),
  to: z.string().email(),
  subject: z.string().max(200),
  bodyHtml: z.string(),
  bodyText: z.string(),
  jurisdiction: z.enum(["US", "EU", "JP", "OTHER"]).default("OTHER"),
  campaignId: z.string().uuid(),
});

export const SendEmailOutputSchema = z.object({
  sent: z.boolean(),
  skippedReason: z.string().optional(), // e.g. "suppressed" | "consent_required_jp"
  providerMessageId: z.string().optional(),
});
export type SendEmailOutput = z.infer<typeof SendEmailOutputSchema>;

export const SendSlackMessageInputSchema = z.object({
  tenantId: z.string().uuid(),
  channel: z.string(),
  text: z.string(),
});

// ============================================================================
// knowledge-mcp
// ============================================================================

export const IngestSourceInputSchema = z.object({
  tenantId: z.string().uuid(),
  sourceType: z.enum(["notion", "github", "gdrive", "pdf", "markdown", "web", "youtube", "mediawiki"]),
  sourceUri: z.string(),
});

export const SearchKnowledgeInputSchema = z.object({
  tenantId: z.string().uuid(),
  query: z.string(),
  topK: z.number().int().min(1).max(20).default(5),
});

export const SearchKnowledgeOutputSchema = z.object({
  results: z.array(
    z.object({
      content: z.string(),
      score: z.number(),
      sourceUri: z.string().optional(),
    })
  ),
});

// ============================================================================
// crm-finance-mcp
// ============================================================================

export const UpdateDealStageInputSchema = z.object({
  dealId: z.string().uuid(),
  stage: z.enum(["prospect", "negotiation", "won", "lost"]),
  note: z.string().optional(),
});

export const CreateInvoiceInputSchema = z.object({
  dealId: z.string().uuid(),
  amountUsd: z.number().positive(),
  idempotencyKey: z.string(),
});

export const CreateInvoiceOutputSchema = z.object({
  invoiceId: z.string().uuid(),
  stripeInvoiceId: z.string().optional(),
  hostedInvoiceUrl: z.string().url().optional(),
});
