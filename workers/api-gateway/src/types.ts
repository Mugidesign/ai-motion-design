export interface Env {
  DATABASE_URL: string;
  RATE_LIMIT_KV: KVNamespace;
  AGENTS_WORKER: Fetcher;
  ORCHESTRATOR: Fetcher;
  /** Self-hosted Supabase Auth (GoTrue) signs JWTs with this shared HS256
   *  secret by default (GOTRUE_JWT_SECRET in docker-compose.yml) — set the
   *  same value here. See docs/06-oss-free-stack.md and
   *  infra/supabase/rls.sql's custom_access_token_hook for how tenant_id
   *  and role end up as claims on that token. */
  SUPABASE_JWT_SECRET: string;
}

/** Populated by middleware/auth.ts, read by every route handler. */
export interface AuthContext {
  userId: string;
  tenantId: string;
  role: "owner" | "admin" | "member" | "viewer";
}

export type HonoVars = { auth: AuthContext };
