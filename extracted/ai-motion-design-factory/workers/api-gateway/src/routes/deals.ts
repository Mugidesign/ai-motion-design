import { Hono } from "hono";
import { z } from "zod";
import { schema } from "@factory/db";
import { and, eq } from "drizzle-orm";
import type { Env, HonoVars } from "../types";
import { getDb } from "../db";

const app = new Hono<{ Bindings: Env; Variables: HonoVars }>();

app.get("/", async (c) => {
  const auth = c.get("auth");
  const db = getDb(c.env);
  const deals = await db.select().from(schema.deals).where(eq(schema.deals.tenantId, auth.tenantId));
  return c.json({ deals });
});

const StageSchema = z.object({ stage: z.enum(["prospect", "negotiation", "won", "lost"]) });

app.patch("/:id/stage", async (c) => {
  const auth = c.get("auth");
  const body = StageSchema.parse(await c.req.json());
  const db = getDb(c.env);
  const [updated] = await db
    .update(schema.deals)
    .set({ stage: body.stage })
    .where(and(eq(schema.deals.id, c.req.param("id")), eq(schema.deals.tenantId, auth.tenantId)))
    .returning();
  if (!updated) return c.json({ error: "not found" }, 404);
  return c.json({ deal: updated });
});

export default app;
