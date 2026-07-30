import { Hono } from "hono";
import { z } from "zod";
import { schema } from "@factory/db";
import { and, eq } from "drizzle-orm";
import type { Env, HonoVars } from "../types";
import { getDb } from "../db";

const app = new Hono<{ Bindings: Env; Variables: HonoVars }>();

const SearchSchema = z.object({
  sources: z.array(z.string()).min(1),
  industry: z.string().optional(),
  region: z.string().optional(),
  maxResults: z.number().int().min(1).max(200).default(50),
});

app.post("/search", async (c) => {
  const auth = c.get("auth");
  const body = SearchSchema.parse(await c.req.json());

  const res = await c.env.AGENTS_WORKER.fetch(`https://agents-worker.internal/agents/lead-finder/${auth.tenantId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId: auth.tenantId, ...body }),
  });
  if (!res.ok) return c.json({ error: "lead search failed", detail: await res.text() }, 502);
  return c.json(await res.json());
});

app.get("/", async (c) => {
  const auth = c.get("auth");
  const db = getDb(c.env);
  const status = c.req.query("status");
  const source = c.req.query("source");

  const conditions = [eq(schema.leads.tenantId, auth.tenantId)];
  if (status) conditions.push(eq(schema.leads.status, status));
  if (source) conditions.push(eq(schema.leads.source, source));

  const rows = await db
    .select()
    .from(schema.leads)
    .where(and(...conditions))
    .limit(200);
  return c.json({ leads: rows });
});

const PatchSchema = z.object({
  status: z.enum(["new", "enriched", "contacted", "replied", "qualified", "won", "lost"]).optional(),
  contactName: z.string().optional(),
  contactEmail: z.string().email().optional(),
});

app.patch("/:id", async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  if (!id) return c.json({ error: "missing id" }, 400);
  const body = PatchSchema.parse(await c.req.json());
  const db = getDb(c.env);
  const [updated] = await db
    .update(schema.leads)
    .set(body)
    .where(and(eq(schema.leads.id, id), eq(schema.leads.tenantId, auth.tenantId)))
    .returning();
  if (!updated) return c.json({ error: "not found" }, 404);
  return c.json({ lead: updated });
});

/** Immediate, unconditional suppression — the single most important
 *  compliance endpoint in the system (docs/05 §3.2). No approval step,
 *  no delay: this writes straight to suppression_list, and every future
 *  send checks that table before doing anything else. */
app.post("/:id/opt-out", async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  if (!id) return c.json({ error: "missing id" }, 400);
  const db = getDb(c.env);
  const [lead] = await db
    .select()
    .from(schema.leads)
    .where(and(eq(schema.leads.id, id), eq(schema.leads.tenantId, auth.tenantId)));
  if (!lead) return c.json({ error: "not found" }, 404);

  await db.update(schema.leads).set({ consentStatus: "opted_out" }).where(eq(schema.leads.id, lead.id));
  if (lead.contactEmail) {
    await db
      .insert(schema.suppressionList)
      .values({ tenantId: auth.tenantId, email: lead.contactEmail, reason: "manual" })
      .onConflictDoNothing();
  }
  return c.json({ ok: true });
});

export default app;
