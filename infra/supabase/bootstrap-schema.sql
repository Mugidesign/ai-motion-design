-- ============================================================================
-- infra/supabase/bootstrap-schema.sql
--
-- Hand-authored SQL matching packages/db/src/schema.ts, for two purposes:
--   1. Mounted into Postgres's /docker-entrypoint-initdb.d/ by
--      infra/docker-compose.yml, so `docker compose up` on a fresh volume
--      produces a fully-schema'd database with zero Node/pnpm steps.
--   2. A readable reference matching docs/02-database-api-mcp.md's DDL.
--
-- Deliberately kept OUTSIDE packages/db/migrations/ — that folder is
-- drizzle-kit's own territory (it tracks a meta/_journal.json alongside
-- whatever migration files IT generates, with its own naming convention).
-- Mixing a hand-written file into that folder risks a naming collision or
-- confusing drizzle-kit's bookkeeping. The real, drizzle-managed
-- migration history starts empty and is created by running
-- `pnpm db:generate` for the first time against the current schema.ts —
-- at that point the two will describe the same schema through two
-- independent paths (drizzle's migration, and this file), which is
-- intentional redundancy, not duplication to keep in sync by hand: this
-- file is a snapshot for bootstrapping, not something you edit going
-- forward. Change schema.ts, then `pnpm db:generate`, and treat drizzle's
-- output as authoritative for anything after initial setup.
-- ============================================================================

create extension if not exists pgcrypto; -- gen_random_uuid()
create extension if not exists vector;   -- pgvector, for knowledge_chunks

-- ---------------------------------------------------------------------------
-- Tenants / billing / members
-- ---------------------------------------------------------------------------
create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  plan text not null default 'trial',
  status text not null default 'active',
  brand_config jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table tenant_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id text not null,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create table tenant_billing_accounts (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text,
  monthly_video_quota int not null default 20,
  monthly_video_used int not null default 0,
  monthly_outreach_quota int not null default 500,
  monthly_outreach_used int not null default 0,
  updated_at timestamptz not null default now()
);

create table integration_credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  provider text not null,
  encrypted_payload text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Leads (created before products/video_projects because products.lead_id
-- references it)
-- ---------------------------------------------------------------------------
create table leads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  company_name text not null,
  contact_name text,
  contact_email text,
  socials jsonb,
  source text not null,
  source_provider text,
  legal_basis text not null default 'legitimate_interest_b2b',
  ad_quality_score numeric(3,2),
  video_quality_score numeric(3,2),
  improvement_notes text,
  deal_probability numeric(3,2),
  consent_status text not null default 'unknown',
  status text not null default 'new',
  created_at timestamptz not null default now()
);

create index leads_tenant_status_idx on leads (tenant_id, status);

create table suppression_list (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete cascade,
  email text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, email)
);

-- ---------------------------------------------------------------------------
-- Products / video generation
-- ---------------------------------------------------------------------------
create table products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  owner_type text not null,
  lead_id uuid references leads(id),
  source_type text not null,
  source_url text,
  source_image_key text,
  analyzed_data jsonb,
  created_at timestamptz not null default now()
);

create table video_projects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  product_id uuid not null references products(id),
  status text not null default 'queued',
  duration_variant text not null,
  provider text,
  prompt_spec jsonb,
  quality_tier text not null default 'draft',
  cost_usd numeric(10,4),
  created_at timestamptz not null default now()
);

create table video_assets (
  id uuid primary key default gen_random_uuid(),
  video_project_id uuid not null references video_projects(id) on delete cascade,
  r2_key text not null,
  thumbnail_r2_key text,
  captions_r2_key text,
  duration_seconds numeric(6,2),
  qa_status text not null default 'pending',
  qa_notes jsonb,
  created_at timestamptz not null default now()
);

create table portfolio_sites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  slug text unique not null,
  published_url text,
  video_project_ids uuid[] not null default '{}',
  theme jsonb,
  published_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Outreach / conversations
-- ---------------------------------------------------------------------------
create table outreach_campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  channel text not null,
  requires_human_approval boolean not null default true,
  jurisdiction text,
  status text not null default 'draft',
  created_at timestamptz not null default now()
);

create table outreach_messages (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references outreach_campaigns(id) on delete cascade,
  lead_id uuid not null references leads(id),
  channel text not null,
  generated_body text not null,
  personalized_video_asset_id uuid references video_assets(id),
  status text not null default 'pending_approval',
  compliance_check jsonb,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id),
  direction text not null,
  channel text not null,
  body text not null,
  intent text,
  sentiment numeric(3,2),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- CRM / billing / delivery
-- ---------------------------------------------------------------------------
create table deals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  lead_id uuid references leads(id),
  stage text not null default 'prospect',
  value_usd numeric(12,2),
  currency text not null default 'USD',
  created_at timestamptz not null default now()
);

create table contracts (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id) on delete cascade,
  r2_key text,
  status text not null default 'draft',
  signed_at timestamptz
);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id),
  stripe_invoice_id text,
  amount_usd numeric(12,2) not null,
  status text not null default 'draft',
  due_date date,
  idempotency_key text unique,
  created_at timestamptz not null default now()
);

create table deliverables (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id),
  video_asset_id uuid references video_assets(id),
  revision_number int not null default 1,
  client_feedback text,
  status text not null default 'in_progress',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Knowledge / RAG
-- ---------------------------------------------------------------------------
create table knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  source_type text not null,
  source_uri text,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references knowledge_documents(id) on delete cascade,
  content text not null,
  -- 768 dims = bge-base-en-v1.5 via Workers AI (free/open-weight default).
  -- Switching to OpenAI's text-embedding-3-small needs vector(1536) instead.
  embedding vector(768),
  metadata jsonb
);

create index knowledge_chunks_embedding_hnsw
  on knowledge_chunks using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Observability / analytics
-- ---------------------------------------------------------------------------
create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_name text not null,
  workflow_instance_id text,
  input_ref jsonb,
  output_ref jsonb,
  status text not null,
  tokens_used int,
  cost_usd numeric(10,5),
  duration_ms int,
  created_at timestamptz not null default now()
);

create index agent_runs_tenant_created_idx on agent_runs (tenant_id, created_at desc);

create table analytics_daily_rollups (
  tenant_id uuid not null references tenants(id) on delete cascade,
  day date not null,
  videos_generated int not null default 0,
  leads_found int not null default 0,
  messages_sent int not null default 0,
  reply_rate numeric(5,4),
  win_rate numeric(5,4),
  revenue_usd numeric(12,2),
  primary key (tenant_id, day)
);

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  actor_user_id text,
  action text not null,
  target_table text,
  target_id uuid,
  metadata jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Orchestration — Postgres-native replacement for Cloudflare Workflows and
-- Cloudflare Queues. See docs/06-oss-free-stack.md.
-- ---------------------------------------------------------------------------
create table pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  pipeline_name text not null default 'motion-factory-pipeline',
  status text not null default 'running',
  current_step text not null default 'analyze-product',
  params jsonb not null,
  step_state jsonb not null default '{}',
  wait_until timestamptz,
  last_error text,
  attempts int not null default 0,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index pipeline_runs_status_wait_idx on pipeline_runs (status, wait_until);

create table job_queue (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  job_type text not null,
  payload jsonb not null,
  status text not null default 'pending',
  run_after timestamptz not null default now(),
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);

create index job_queue_pending_run_after_idx on job_queue (status, run_after);
