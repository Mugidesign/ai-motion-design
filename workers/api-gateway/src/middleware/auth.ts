import type { Context, Next } from "hono";
import { jwtVerify, type JWTPayload } from "jose";
import type { Env, HonoVars } from "../types";

/**
 * Verifies the JWT issued by self-hosted Supabase Auth (GoTrue). GoTrue
 * signs with HS256 using a shared secret (GOTRUE_JWT_SECRET in
 * docker-compose.yml) by default — simpler to self-host than RS256/JWKS,
 * which is why this looks different from the Clerk-based version this
 * replaced (that verified against a public JWKS endpoint instead).
 *
 * tenant_id and app_role are injected into the token by the
 * custom_access_token_hook Postgres function in infra/supabase/rls.sql,
 * which GoTrue calls on every token issuance — see that file for how the
 * mapping from user -> tenant is derived from `tenant_members`.
 */
let cachedSecretKey: Uint8Array | undefined;

export async function supabaseAuth(c: Context<{ Bindings: Env; Variables: HonoVars }>, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "missing bearer token" }, 401);
  }
  const token = authHeader.slice("Bearer ".length);

  if (!cachedSecretKey) {
    cachedSecretKey = new TextEncoder().encode(c.env.SUPABASE_JWT_SECRET);
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, cachedSecretKey));
  } catch (err) {
    return c.json({ error: "invalid token", detail: err instanceof Error ? err.message : String(err) }, 401);
  }

  const tenantId = payload["tenant_id"];
  const appRole = payload["app_role"] ?? "member";
  if (typeof tenantId !== "string" || !payload.sub) {
    return c.json(
      {
        error:
          "token missing required claims (sub, tenant_id) — is the custom_access_token_hook wired up in your GoTrue config? See infra/supabase/rls.sql",
      },
      401
    );
  }

  c.set("auth", { userId: payload.sub, tenantId, role: appRole as "owner" | "admin" | "member" | "viewer" });
  await next();
}

/** Route guard for owner/admin-only actions (billing, contracts). */
export function requireRole(...allowed: Array<"owner" | "admin" | "member" | "viewer">) {
  return async (c: Context<{ Bindings: Env; Variables: HonoVars }>, next: Next) => {
    const auth = c.get("auth");
    if (!allowed.includes(auth.role)) {
      return c.json({ error: `requires role: ${allowed.join(" or ")}` }, 403);
    }
    await next();
  };
}
