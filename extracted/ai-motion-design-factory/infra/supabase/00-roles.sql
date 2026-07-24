-- ============================================================================
-- infra/supabase/00-roles.sql
--
-- Minimal role setup for self-hosted GoTrue, mirroring what the official
-- Supabase self-hosted stack provisions (there it's created by a larger
-- bootstrap script; here it's just what this scaffold actually needs).
-- Mounted into Postgres's /docker-entrypoint-initdb.d/ so it runs once,
-- automatically, on first container start — see docker-compose.yml.
--
-- Files in /docker-entrypoint-initdb.d/ run in filename sort order, which
-- is why this is prefixed 00- (must exist before GoTrue's own startup
-- migrations run and before rls.sql's `grant ... to supabase_auth_admin`
-- executes, both of which reference this role).
-- ============================================================================

do $$
begin
  if not exists (select from pg_catalog.pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin noinherit createrole login password 'change-me-auth-admin-password';
  end if;
end
$$;

grant create on database postgres to supabase_auth_admin;

-- GoTrue manages its own `auth` schema and runs its own migrations against
-- it on startup — this just ensures the schema exists and is owned by the
-- role GoTrue connects as, so those migrations succeed.
create schema if not exists auth authorization supabase_auth_admin;

-- Lets application code (Workers connecting as the default postgres user
-- in this scaffold) read auth.users for joins/debugging if ever needed.
-- Tighten or remove this in production if you don't need it — the
-- platform's own tables (tenant_members etc.) are the source of truth for
-- anything authorization-relevant, not direct auth.users access.
grant usage on schema auth to postgres;
grant select on all tables in schema auth to postgres;
alter default privileges in schema auth grant select on tables to postgres;
