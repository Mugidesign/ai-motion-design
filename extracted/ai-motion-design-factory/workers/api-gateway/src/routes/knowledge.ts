import { Hono } from "hono";
import { z } from "zod";
import { schema } from "@factory/db";
import { eq } from "drizzle-orm";
import type { Env, HonoVars } from "../types";
import { getDb } from "../db";

const app = new Hono<{ Bindings: Env; Variables: HonoVars }>();

const SourceSchema = z.object({
  sourceType: z.enum(["notion", "github", "gdrive", "pdf", "markdown", "web", "youtube", "mediawiki"]),
  sourceUri: z.string(),
});

app.post("/sources", async (c) => {
  const auth = c.get("auth");
  const body = SourceSchema.parse(await c.req.json());
  const res = await c.env.AGENTS_WORKER.fetch(`https://agents-worker.internal/agents/knowledge/${auth.tenantId}/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId: auth.tenantId, ...body }),
  });
  if (!res.ok) return c.json({ error: "ingest failed", detail: await res.text() }, 502);
  return c.json(await res.json(), 202);
});

app.get("/sources", async (c) => {
  const auth = c.get("auth");
  const db = getDb(c.env);
  const sources = await db.select().from(schema.knowledgeDocuments).where(eq(schema.knowledgeDocuments.tenantId, auth.tenantId));
  return c.json({ sources });
});

const AskSchema = z.object({ question: z.string().min(1) });

app.post("/ask", async (c) => {
  const auth = c.get("auth");
  const body = AskSchema.parse(await c.req.json());
  const res = await c.env.AGENTS_WORKER.fetch(`https://agents-worker.internal/agents/knowledge/${auth.tenantId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId: auth.tenantId, question: body.question }),
  });
  if (!res.ok) return c.json({ error: "ask failed", detail: await res.text() }, 502);
  return c.json(await res.json());
});

export default app;
