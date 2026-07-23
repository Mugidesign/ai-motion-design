import { Hono } from "hono";
import { cors } from "hono/cors";
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

app.get("/health", (c) => c.json({ ok: true, service: "api-gateway" }));

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
