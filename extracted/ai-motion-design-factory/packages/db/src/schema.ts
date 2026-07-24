/**
 * @factory/db — Drizzle ORM schema
 *
 * Source of truth for the Postgres schema described in
 * docs/02-database-api-mcp.md. Row Level Security policies live in
 * infra/supabase/rls.sql — Drizzle does not manage RLS directly.
 *
 * OSS/free-stack note (see docs/06-oss-free-stack.md): this schema targets
 * a self-hosted Postgres + pgvector instance (docker-compose.yml), reached
 * directly via DATABASE_URL rather than Cloudflare Hyperdrive, which has
 * no free tier. `pipeline_runs` and `job_queue` below replace Cloudflare
 * Workflows and Cloudflare Queues respectively — both are polled by a
 * Cron Trigger (workers/orchestrator, workers/agents' automation agent)
 * instead of relying on those paid/uncertain-free-tier products.
 *
 * Generate a migration after editing this file:
 *   pnpm db:generate
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  numeric,
  boolean,
  date,
  primaryKey,
  vector,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Tenants / billing / members
// ---------------------------------------------------------------------------

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  plan: text("plan").notNull().default("trial"), // trial|starter|growth|scale|enterprise
  status: text("status").notNull().default("active"), // active|suspended|churned
  brandConfig: jsonb("brand_config").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tenantMembers = pgTable(
  "tenant_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(), // Supabase Auth (GoTrue) user id — auth.users.id
    role: text("role").notNull().default("member"), // owner|admin|member|viewer
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqTenantUser: uniqueIndex("tenant_members_tenant_user_uq").on(t.tenantId, t.userId),
  })
);

export const tenantBillingAccounts = pgTable("tenant_billing_accounts", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id, { onDelete: "cascade" }),
  stripeCustomerId: text("stripe_customer_id").unique(),
  stripeSubscriptionId: text("stripe_subscription_id"),
  monthlyVideoQuota: integer("monthly_video_quota").notNull().default(20),
  monthlyVideoUsed: integer("monthly_video_used").notNull().default(0),
  monthlyOutreachQuota: integer("monthly_outreach_quota").notNull().default(500),
  monthlyOutreachUsed: integer("monthly_outreach_used").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const integrationCredentials = pgTable("integration_credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(), // gmail|outlook|slack|discord
  // Encrypted at the application layer before insert — never store plaintext tokens.
  encryptedPayload: text("encrypted_payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Products / video generation
// ---------------------------------------------------------------------------

export const products = pgTable("products", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  ownerType: text("owner_type").notNull(), // 'tenant_portfolio' | 'lead_pitch'
  leadId: uuid("lead_id").references((): any => leads.id),
  sourceType: text("source_type").notNull(), // 'url' | 'image'
  sourceUrl: text("source_url"),
  sourceImageKey: text("source_image_key"), // R2 object key
  analyzedData: jsonb("analyzed_data"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const videoProjects = pgTable("video_projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull().references(() => products.id),
  status: text("status").notNull().default("queued"), // queued|analyzing|generating|review|approved|failed
  durationVariant: text("duration_variant").notNull(), // '15s'|'30s'|'60s'
  provider: text("provider"),
  promptSpec: jsonb("prompt_spec"),
  qualityTier: text("quality_tier").notNull().default("draft"), // draft|final
  costUsd: numeric("cost_usd", { precision: 10, scale: 4 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const videoAssets = pgTable("video_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  videoProjectId: uuid("video_project_id").notNull().references(() => videoProjects.id, { onDelete: "cascade" }),
  r2Key: text("r2_key").notNull(),
  thumbnailR2Key: text("thumbnail_r2_key"),
  captionsR2Key: text("captions_r2_key"),
  durationSeconds: numeric("duration_seconds", { precision: 6, scale: 2 }),
  qaStatus: text("qa_status").notNull().default("pending"), // pending|passed|flagged
  qaNotes: jsonb("qa_notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const portfolioSites = pgTable("portfolio_sites", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  slug: text("slug").notNull().unique(),
  publishedUrl: text("published_url"),
  videoProjectIds: uuid("video_project_ids").array().notNull().default(sql`'{}'::uuid[]`),
  theme: jsonb("theme"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// Lead Finder / Sales — see docs/05 §3 for the compliance model these
// columns exist to support (source_provider / legal_basis / consent_status).
// ---------------------------------------------------------------------------

export const leads = pgTable("leads", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  companyName: text("company_name").notNull(),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  socials: jsonb("socials"), // {linkedin, instagram, x, youtube}
  source: text("source").notNull(), // google_maps|shopify|kickstarter|product_hunt|crunchbase|own_site|search_engine|csv_import
  sourceProvider: text("source_provider"), // which compliant data provider actually served this record
  legalBasis: text("legal_basis").notNull().default("legitimate_interest_b2b"),
  adQualityScore: numeric("ad_quality_score", { precision: 3, scale: 2 }),
  videoQualityScore: numeric("video_quality_score", { precision: 3, scale: 2 }),
  improvementNotes: text("improvement_notes"),
  dealProbability: numeric("deal_probability", { precision: 3, scale: 2 }),
  consentStatus: text("consent_status").notNull().default("unknown"), // unknown|opted_in|opted_out|do_not_contact
  status: text("status").notNull().default("new"), // new|enriched|contacted|replied|qualified|won|lost
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const suppressionList = pgTable(
  "suppression_list",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }), // null = global suppression
    email: text("email").notNull(),
    reason: text("reason").notNull(), // unsubscribed|bounced|complaint|manual
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqTenantEmail: uniqueIndex("suppression_tenant_email_uq").on(t.tenantId, t.email),
  })
);

export const outreachCampaigns = pgTable("outreach_campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  channel: text("channel").notNull(), // email|linkedin_dm|slack|discord|line|whatsapp
  requiresHumanApproval: boolean("requires_human_approval").notNull().default(true),
  jurisdiction: text("jurisdiction"), // e.g. 'JP' | 'US' | 'EU' — drives default consent rules, docs/05 §3.2
  status: text("status").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const outreachMessages = pgTable("outreach_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  campaignId: uuid("campaign_id").notNull().references(() => outreachCampaigns.id, { onDelete: "cascade" }),
  leadId: uuid("lead_id").notNull().references(() => leads.id),
  channel: text("channel").notNull(),
  generatedBody: text("generated_body").notNull(),
  personalizedVideoAssetId: uuid("personalized_video_asset_id").references(() => videoAssets.id),
  status: text("status").notNull().default("pending_approval"), // pending_approval|approved|sent|replied|bounced|suppressed
  complianceCheck: jsonb("compliance_check"), // {suppressionOk, consentOk, jurisdiction, checkedAt}
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id").notNull().references(() => leads.id),
  direction: text("direction").notNull(), // inbound|outbound
  channel: text("channel").notNull(),
  body: text("body").notNull(),
  intent: text("intent"), // interested|not_interested|question|out_of_office|unsubscribe
  sentiment: numeric("sentiment", { precision: 3, scale: 2 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// CRM / deals / billing / delivery
// ---------------------------------------------------------------------------

export const deals = pgTable("deals", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  leadId: uuid("lead_id").references(() => leads.id),
  stage: text("stage").notNull().default("prospect"), // prospect|negotiation|won|lost
  valueUsd: numeric("value_usd", { precision: 12, scale: 2 }),
  currency: text("currency").notNull().default("USD"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const contracts = pgTable("contracts", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id").notNull().references(() => deals.id, { onDelete: "cascade" }),
  r2Key: text("r2_key"),
  status: text("status").notNull().default("draft"), // draft|sent|signed
  signedAt: timestamp("signed_at", { withTimezone: true }),
});

export const invoices = pgTable("invoices", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id").notNull().references(() => deals.id),
  stripeInvoiceId: text("stripe_invoice_id"),
  amountUsd: numeric("amount_usd", { precision: 12, scale: 2 }).notNull(),
  status: text("status").notNull().default("draft"), // draft|sent|paid|overdue|void
  dueDate: date("due_date"),
  idempotencyKey: text("idempotency_key").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const deliverables = pgTable("deliverables", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id").notNull().references(() => deals.id),
  videoAssetId: uuid("video_asset_id").references(() => videoAssets.id),
  revisionNumber: integer("revision_number").notNull().default(1),
  clientFeedback: text("client_feedback"),
  status: text("status").notNull().default("in_progress"), // in_progress|delivered|revision_requested|accepted
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Knowledge / RAG
// ---------------------------------------------------------------------------

export const knowledgeDocuments = pgTable("knowledge_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  sourceType: text("source_type").notNull(), // notion|github|gdrive|pdf|markdown|web|youtube|mediawiki
  sourceUri: text("source_uri"),
  status: text("status").notNull().default("pending"), // pending|indexed|failed
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").notNull().references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    // 768 dims matches Workers AI's @cf/baai/bge-base-en-v1.5 (the free,
    // open-weight default — see knowledge-mcp/src/embeddings.ts). If you
    // switch to OpenAI's text-embedding-3-small, change this to 1536 and
    // regenerate the migration; the two are not interchangeable in the
    // same column.
    embedding: vector("embedding", { dimensions: 768 }),
    metadata: jsonb("metadata"),
  },
  (t) => ({
    embeddingIdx: index("knowledge_chunks_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
  })
);

// ---------------------------------------------------------------------------
// Observability / analytics
// ---------------------------------------------------------------------------

export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  agentName: text("agent_name").notNull(),
  workflowInstanceId: text("workflow_instance_id"),
  inputRef: jsonb("input_ref"),
  outputRef: jsonb("output_ref"),
  status: text("status").notNull(), // running|succeeded|failed|awaiting_approval
  tokensUsed: integer("tokens_used"),
  costUsd: numeric("cost_usd", { precision: 10, scale: 5 }),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const analyticsDailyRollups = pgTable(
  "analytics_daily_rollups",
  {
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    videosGenerated: integer("videos_generated").notNull().default(0),
    leadsFound: integer("leads_found").notNull().default(0),
    messagesSent: integer("messages_sent").notNull().default(0),
    replyRate: numeric("reply_rate", { precision: 5, scale: 4 }),
    winRate: numeric("win_rate", { precision: 5, scale: 4 }),
    revenueUsd: numeric("revenue_usd", { precision: 12, scale: 2 }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.day] }),
  })
);

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  actorUserId: text("actor_user_id"),
  action: text("action").notNull(), // e.g. 'outreach.approve', 'invoice.send'
  targetTable: text("target_table"),
  targetId: uuid("target_id"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Orchestration — Postgres-native replacement for Cloudflare Workflows
// (pipeline_runs) and Cloudflare Queues (job_queue). Both are advanced by a
// Cron Trigger polling loop rather than a managed product, which keeps the
// entire orchestration layer inside the same free, self-hosted Postgres
// instance as everything else. See docs/06-oss-free-stack.md and
// workers/orchestrator/src/index.ts.
// ---------------------------------------------------------------------------

export const pipelineRuns = pgTable("pipeline_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  pipelineName: text("pipeline_name").notNull().default("motion-factory-pipeline"),
  status: text("status").notNull().default("running"), // running|waiting|succeeded|failed
  currentStep: text("current_step").notNull().default("analyze-product"),
  params: jsonb("params").notNull(),
  stepState: jsonb("step_state").notNull().default({}), // accumulated output from completed steps
  waitUntil: timestamp("wait_until", { withTimezone: true }), // for step.sleep-equivalent pauses
  lastError: text("last_error"),
  attempts: integer("attempts").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const jobQueue = pgTable(
  "job_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    jobType: text("job_type").notNull(), // e.g. 'send_outreach_message'
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"), // pending|processing|done|failed
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(), // rate-limited sends set this in the future
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The Cron consumer's core query is "give me pending jobs whose time has
    // come" — this index is what keeps that query cheap as the table grows.
    pendingRunAfterIdx: index("job_queue_pending_run_after_idx").on(t.status, t.runAfter),
  })
);

// ---------------------------------------------------------------------------
// Relations (used by Drizzle's relational query API — db.query.leads.findMany etc.)
// ---------------------------------------------------------------------------

export const tenantsRelations = relations(tenants, ({ many }) => ({
  members: many(tenantMembers),
  products: many(products),
  leads: many(leads),
  deals: many(deals),
}));

export const leadsRelations = relations(leads, ({ many, one }) => ({
  outreachMessages: many(outreachMessages),
  conversations: many(conversations),
  deal: one(deals, { fields: [leads.id], references: [deals.leadId] }),
}));

export const videoProjectsRelations = relations(videoProjects, ({ many, one }) => ({
  assets: many(videoAssets),
  product: one(products, { fields: [videoProjects.productId], references: [products.id] }),
}));

export const dealsRelations = relations(deals, ({ many, one }) => ({
  invoices: many(invoices),
  deliverables: many(deliverables),
  contracts: many(contracts),
  lead: one(leads, { fields: [deals.leadId], references: [leads.id] }),
}));
