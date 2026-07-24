-- ============================================================================
-- infra/supabase/rls.sql
--
-- Row Level Security: the first line of defense for tenant isolation
-- (docs/05-ops-security-compliance-cost.md §2). Apply after bootstrap-schema.sql.
--
-- Assumes the JWT issued to Postgres (via Supabase's `authenticator` role,
-- fed by a Clerk-issued JWT exchanged at the edge) carries a `tenant_id`
-- claim. The API Gateway Worker is responsible for only ever forwarding
-- requests whose JWT tenant_id it has itself verified — RLS is defense in
-- depth, not the only check.
-- ============================================================================

-- Helper: current tenant from JWT claims
create or replace function current_tenant_id() returns uuid as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id', '')::uuid
$$ language sql stable;

-- Apply the same pattern to every tenant-scoped table.
do $$
declare
  t text;
  tenant_scoped_tables text[] := array[
    'tenant_members', 'products', 'video_projects', 'video_assets',
    'portfolio_sites', 'leads', 'suppression_list', 'outreach_campaigns',
    'outreach_messages', 'deals', 'knowledge_documents', 'agent_runs',
    'analytics_daily_rollups', 'audit_log', 'integration_credentials'
  ];
begin
  foreach t in array tenant_scoped_tables loop
    execute format('alter table %I enable row level security;', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_tenant_id());',
      t
    );
  end loop;
end $$;

-- Tables without a direct tenant_id column: isolate via join to their parent.
alter table conversations enable row level security;
create policy tenant_isolation on conversations
  using (
    lead_id in (select id from leads where tenant_id = current_tenant_id())
  );

alter table invoices enable row level security;
create policy tenant_isolation on invoices
  using (
    deal_id in (select id from deals where tenant_id = current_tenant_id())
  );

alter table contracts enable row level security;
create policy tenant_isolation on contracts
  using (
    deal_id in (select id from deals where tenant_id = current_tenant_id())
  );

alter table deliverables enable row level security;
create policy tenant_isolation on deliverables
  using (
    deal_id in (select id from deals where tenant_id = current_tenant_id())
  );

alter table knowledge_chunks enable row level security;
create policy tenant_isolation on knowledge_chunks
  using (
    document_id in (select id from knowledge_documents where tenant_id = current_tenant_id())
  );

alter table tenant_billing_accounts enable row level security;
create policy tenant_isolation on tenant_billing_accounts
  using (tenant_id = current_tenant_id());

-- `tenants` itself: a member can only read the tenant row(s) they belong to.
alter table tenants enable row level security;
create policy member_can_read_own_tenant on tenants
  for select
  using (id in (select tenant_id from tenant_members where user_id = current_setting('request.jwt.claims', true)::jsonb ->> 'sub'));

-- Service-role (used by Workers via a direct Postgres connection with a
-- service-role credential, never the anon key) bypasses RLS by design in
-- Supabase/GoTrue setups — application-layer tenant_id scoping in every
-- query is still mandatory in that path. See
-- docs/05-ops-security-compliance-cost.md §2 "テナント分離".

alter table pipeline_runs enable row level security;
create policy tenant_isolation on pipeline_runs using (tenant_id = current_tenant_id());

alter table job_queue enable row level security;
create policy tenant_isolation on job_queue using (tenant_id = current_tenant_id());

-- ============================================================================
-- GoTrue custom claims hook (self-hosted auth — replaces what a Clerk JWT
-- template did in the earlier draft of this architecture). GoTrue calls
-- this function on every token issuance/refresh if configured as the
-- account's Auth Hook (GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI or the
-- self-hosted config equivalent — see docker-compose.yml comments and
-- docs/06-oss-free-stack.md). It injects tenant_id and role into the JWT so
-- api-gateway and RLS policies above can read them without an extra
-- database round trip per request.
--
-- This assumes one tenant per user for simplicity (the common case for a
-- solo operator or small agency running this platform). Multi-tenant users
-- (one person belonging to several tenants) would need a tenant-switcher
-- flow that re-issues a token with a chosen tenant_id — out of scope here.
-- ============================================================================
create or replace function custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims jsonb;
  membership record;
begin
  claims := event -> 'claims';

  select tenant_id, role into membership
  from tenant_members
  where user_id = (event ->> 'user_id')
  limit 1;

  if membership is not null then
    claims := jsonb_set(claims, '{tenant_id}', to_jsonb(membership.tenant_id::text));
    -- Named app_role, NOT role: GoTrue already uses the `role` claim for
    -- the Postgres session role (authenticated/anon) — overwriting it
    -- would break RLS role resolution. api-gateway reads app_role for
    -- the owner/admin/member/viewer permission check (requireRole()).
    claims := jsonb_set(claims, '{app_role}', to_jsonb(membership.role));
  end if;

  event := jsonb_set(event, '{claims}', claims);
  return event;
end;
$$;

-- GoTrue's hook-invoking role needs execute on this function; grant it to
-- the role docker-compose.yml configures GoTrue to connect as (default
-- "supabase_auth_admin" in the standard self-hosted stack).
grant execute on function custom_access_token_hook to supabase_auth_admin;
