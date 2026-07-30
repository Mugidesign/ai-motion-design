import { Hono } from "hono";
import { z } from "zod";
import { schema } from "@factory/db";
import { eq } from "drizzle-orm";
import type { Env, HonoVars } from "../types";
import { getDb } from "../db";

const app = new Hono<{ Bindings: Env; Variables: HonoVars }>();

const CreateProductSchema = z.object({
  sourceType: z.enum(["url", "image"]),
  sourceUrl: z.string().url().optional(),
  sourceImageKey: z.string().optional(), // R2 key, uploaded client-side via a presigned URL beforehand
  ownerType: z.enum(["tenant_portfolio", "lead_pitch"]).default("tenant_portfolio"),
  leadId: z.string().uuid().optional(),
  autoRunPipeline: z.boolean().default(true),
  autoFindLeads: z.boolean().default(false),
});

app.post("/", async (c) => {
  const auth = c.get("auth");
  const body = CreateProductSchema.parse(await c.req.json());
  if (!body.sourceUrl && !body.sourceImageKey) {
    return c.json({ error: "sourceUrl or sourceImageKey is required" }, 400);
  }

  const db = getDb(c.env);
  const [product] = await db
    .insert(schema.products)
    .values({
      tenantId: auth.tenantId,
      ownerType: body.ownerType,
      leadId: body.leadId,
      sourceType: body.sourceType,
      sourceUrl: body.sourceUrl,
      sourceImageKey: body.sourceImageKey,
    })
    .returning();

  let pipelineInstanceId: string | undefined;
  if (body.autoRunPipeline) {
    const res = await c.env.ORCHESTRATOR.fetch("https://orchestrator.internal/pipelines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: auth.tenantId, productId: product!.id, autoFindLeads: body.autoFindLeads }),
    });
    if (res.ok) {
      const data = (await res.json()) as { id: string };
      pipelineInstanceId = data.id;
    }
  }

  return c.json({ product, pipelineInstanceId }, 201);
});

app.get("/:id", async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  if (!id) return c.json({ error: "missing id" }, 400);
  const db = getDb(c.env);
  const [product] = await db
    .select()
    .from(schema.products)
    .where(eq(schema.products.id, id));
  if (!product || product.tenantId !== auth.tenantId) return c.json({ error: "not found" }, 404);
  return c.json({ product });
});

export default app;
