import { Hono } from "hono";
import { schema } from "@factory/db";
import { and, eq } from "drizzle-orm";
import type { Env, HonoVars } from "../types";
import { getDb } from "../db";

const app = new Hono<{ Bindings: Env; Variables: HonoVars }>();

app.get("/deal/:dealId", async (c) => {
  const db = getDb(c.env);
  const invoices = await db.select().from(schema.invoices).where(eq(schema.invoices.dealId, c.req.param("dealId")));
  return c.json({ invoices });
});

/** Triggers Finance Agent's create_invoice action for a deal — see
 *  workers/agents/src/agents/finance.ts for the idempotency-key handling. */
app.post("/deal/:dealId/create", async (c) => {
  const auth = c.get("auth");
  const db = getDb(c.env);
  const [deal] = await db
    .select()
    .from(schema.deals)
    .where(and(eq(schema.deals.id, c.req.param("dealId")), eq(schema.deals.tenantId, auth.tenantId)));
  if (!deal) return c.json({ error: "deal not found" }, 404);

  const res = await c.env.AGENTS_WORKER.fetch(`https://agents-worker.internal/agents/finance/${auth.tenantId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId: auth.tenantId, dealId: deal.id, action: "create_invoice" }),
  });
  if (!res.ok) return c.json({ error: "invoice creation failed", detail: await res.text() }, 502);
  return c.json(await res.json(), 201);
});

export default app;
