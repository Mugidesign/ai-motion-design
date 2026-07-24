import type { Context, Next } from "hono";
import type { Env, HonoVars } from "../types";

/**
 * Fixed-window rate limiting keyed on tenant + route, backed by Workers
 * KV. This is intentionally simple (fixed window, not a true sliding
 * log) — KV's eventual consistency and per-key write limits make a
 * precise sliding window expensive to implement correctly; a fixed
 * window is the standard pragmatic tradeoff at this layer. For
 * stricter guarantees (e.g. billing-affecting limits), enforce a second
 * check against Postgres inside the route itself.
 */
export function rateLimit(opts: { windowSeconds: number; maxRequests: number }) {
  return async (c: Context<{ Bindings: Env; Variables: HonoVars }>, next: Next) => {
    const auth = c.get("auth");
    const windowStart = Math.floor(Date.now() / 1000 / opts.windowSeconds);
    const key = `ratelimit:${auth.tenantId}:${c.req.path}:${windowStart}`;

    const current = Number((await c.env.RATE_LIMIT_KV.get(key)) ?? "0");
    if (current >= opts.maxRequests) {
      return c.json({ error: "rate limit exceeded", retryAfterSeconds: opts.windowSeconds }, 429);
    }

    await c.env.RATE_LIMIT_KV.put(key, String(current + 1), { expirationTtl: opts.windowSeconds * 2 });
    await next();
  };
}
