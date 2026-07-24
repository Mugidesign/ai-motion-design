import { Hono } from "hono";
import { schema } from "@factory/db";
import { eq } from "drizzle-orm";
import type { Env, HonoVars } from "../types";
import { getDb } from "../db";

const app = new Hono<{ Bindings: Env; Variables: HonoVars }>();

app.get("/:id", async (c) => {
  const auth = c.get("auth");
  const db = getDb(c.env);
  const [project] = await db.select().from(schema.videoProjects).where(eq(schema.videoProjects.id, c.req.param("id")));
  if (!project || project.tenantId !== auth.tenantId) return c.json({ error: "not found" }, 404);
  const assets = await db.select().from(schema.videoAssets).where(eq(schema.videoAssets.videoProjectId, project.id));
  return c.json({ project, assets });
});

app.get("/:id/status", async (c) => {
  const auth = c.get("auth");
  const db = getDb(c.env);
  const [project] = await db.select().from(schema.videoProjects).where(eq(schema.videoProjects.id, c.req.param("id")));
  if (!project || project.tenantId !== auth.tenantId) return c.json({ error: "not found" }, 404);
  return c.json({ status: project.status });
});

export default app;
