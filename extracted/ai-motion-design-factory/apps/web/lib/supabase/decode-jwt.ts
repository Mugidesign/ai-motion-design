/**
 * Decodes a JWT's payload WITHOUT verifying its signature. This is safe
 * here specifically because the result is only ever used for
 * UI-convenience purposes (showing the right nav, picking a WebSocket
 * `name` to connect to) — every security-relevant decision is re-checked
 * server-side: workers/api-gateway/src/middleware/auth.ts independently
 * verifies the signature against SUPABASE_JWT_SECRET before trusting
 * tenant_id/app_role for anything that matters. Never use this function's
 * output to decide whether to show/hide something security-sensitive.
 */
export interface DecodedSupabaseClaims {
  sub?: string;
  tenant_id?: string;
  app_role?: "owner" | "admin" | "member" | "viewer";
  exp?: number;
}

export function decodeJwtPayload(jwt: string): DecodedSupabaseClaims {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return {};
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
    return JSON.parse(json);
  } catch {
    return {};
  }
}
