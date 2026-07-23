import { Hono } from "hono";
import { schema } from "@factory/db";
import { and, desc, eq } from "drizzle-orm";
import type { Env, HonoVars } from "../types";
import { getDb } from "../db";

const app = new Hono<{ Bindings: Env; Variables: HonoVars }>();

/**
 * Historical / REST view of agent activity, for the Control Room's
 * initial page load and for any non-realtime reporting. Live updates
 * (the actual "control room" feel) come from the browser connecting
 * WebSockets directly to each agent Durable Object via `useAgent` in
 * apps/web/lib/useAgentStream.ts — that path bypasses this gateway
 * entirely for lower latency, which is why there's no WS proxy route
 * here. See docs/04 §1.3.
 */
app.get("/runs", async (c) => {
  const auth = c.get("auth");
  const db = getDb(c.env);
  const agentName = c.req.query("agent");
  const status = c.req.query("status");

  const conditions = [eq(schema.agentRuns.tenantId, auth.tenantId)];
  if (agentName) conditions.push(eq(schema.agentRuns.agentName, agentName));
  if (status) conditions.push(eq(schema.agentRuns.status, status));

  const runs = await db
    .select()
    .from(schema.agentRuns)
    .where(and(...conditions))
    .orderBy(desc(schema.agentRuns.createdAt))
    .limit(100);

  return c.json({ runs });
});

export default app;
