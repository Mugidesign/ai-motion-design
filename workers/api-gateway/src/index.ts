import { Hono } from "hono";
import { cors } from "hono/cors";
import { checkDatabase, checkUpstreamWorker, buildHealthReport } from "@factory/health-kit";
import type { Env, HonoVars } from "./types";
import { supabaseAuth } from "./middleware/auth";
import { rateLimit } from "./middleware/rateLimit";

import products from "./routes/products";
import videoProjects from "./routes/videoProjects";
import leads from "./routes/leads";
import campaigns from "./routes/campaigns";
import deals from "./routes/deals";
import invoices from "./routes/invoices";
import knowledge from "./routes/knowledge";
import analytics from "./routes/analytics";
import agents from "./routes/agents";

const app = new Hono<{ Bindings: Env; Variables: HonoVars }>();

app.use(
  "*",
  cors({
    origin: (origin) => origin, // tighten to an explicit allowlist (your Vercel domain) before production
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  })
);

/**
 * Real health check, not just "the process started" — verifies Postgres
 * is reachable and that both Workers this gateway depends on
 * (agents-worker, orchestrator) are themselves healthy. Returns 503 if
 * anything failed, which is what scripts/health-check.sh and
 * .github/workflows/deploy.yml's post-deploy check key off of.
 */
app.get("/health", async (c) => {
  const { body, httpStatus } = await buildHealthReport("api-gateway", {
    database: () => checkDatabase(c.env.DATABASE_URL),
    agentsWorker: () => checkUpstreamWorker(c.env.AGENTS_WORKER, "agents-worker"),
    orchestrator: () => checkUpstreamWorker(c.env.ORCHESTRATOR, "orchestrator"),
  });
  return c.json(body, httpStatus as 200 | 503);
});

// Everything under /api/v1/* requires a verified Supabase Auth (GoTrue) session and a
// per-tenant rate limit. Health check above stays outside this group.
const api = new Hono<{ Bindings: Env; Variables: HonoVars }>();
api.use("*", supabaseAuth);
api.use("*", rateLimit({ windowSeconds: 60, maxRequests: 120 }));

api.route("/products", products);
api.route("/video-projects", videoProjects);
api.route("/leads", leads);
api.route("/campaigns", campaigns);
api.route("/deals", deals);
api.route("/invoices", invoices);
api.route("/knowledge", knowledge);
api.route("/analytics", analytics);
api.route("/agents", agents);

app.route("/api/v1", api);

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal error", detail: err.message }, 500);
});

export default app;
