import { Hono } from "hono";
import { schema } from "@factory/db";
import { and, desc, eq, gte } from "drizzle-orm";
import type { Env, HonoVars } from "../types";
import { getDb } from "../db";

const app = new Hono<{ Bindings: Env; Variables: HonoVars }>();

app.get("/summary", async (c) => {
  const auth = c.get("auth");
  const rangeDays = Number(c.req.query("range")?.replace("d", "") ?? "30");
  const db = getDb(c.env);
  const since = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const rollups = await db
    .select()
    .from(schema.analyticsDailyRollups)
    .where(and(eq(schema.analyticsDailyRollups.tenantId, auth.tenantId), gte(schema.analyticsDailyRollups.day, since)))
    .orderBy(desc(schema.analyticsDailyRollups.day));

  return c.json({ rollups });
});

/** Triggers a fresh rollup + AI improvement suggestions on demand, rather
 *  than only relying on a scheduled Cron Trigger (add one in
 *  wrangler.jsonc `[triggers] crons` for a nightly run in production). */
app.post("/refresh", async (c) => {
  const auth = c.get("auth");
  const res = await c.env.AGENTS_WORKER.fetch(`https://agents-worker.internal/agents/analytics/${auth.tenantId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId: auth.tenantId, rangeDays: 30 }),
  });
  if (!res.ok) return c.json({ error: "refresh failed", detail: await res.text() }, 502);
  return c.json(await res.json());
});

export default app;
