import { Hono } from "hono";
import { z } from "zod";
import { schema } from "@factory/db";
import { and, eq, inArray } from "drizzle-orm";
import type { Env, HonoVars } from "../types";
import { getDb } from "../db";
import { requireRole } from "../middleware/auth";

const app = new Hono<{ Bindings: Env; Variables: HonoVars }>();

const CreateCampaignSchema = z.object({
  name: z.string(),
  channel: z.enum(["email", "linkedin_dm", "slack", "discord", "line", "whatsapp"]),
  jurisdiction: z.enum(["US", "EU", "JP", "OTHER"]).default("OTHER"),
});

app.post("/", async (c) => {
  const auth = c.get("auth");
  const body = CreateCampaignSchema.parse(await c.req.json());
  const db = getDb(c.env);
  const [campaign] = await db
    .insert(schema.outreachCampaigns)
    .values({ tenantId: auth.tenantId, name: body.name, channel: body.channel, jurisdiction: body.jurisdiction })
    .returning();
  return c.json({ campaign }, 201);
});

const GenerateSchema = z.object({ leadIds: z.array(z.string().uuid()).min(1) });

app.post("/:id/generate", async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  if (!id) return c.json({ error: "missing id" }, 400);
  const body = GenerateSchema.parse(await c.req.json());

  const res = await c.env.AGENTS_WORKER.fetch(`https://agents-worker.internal/agents/sales/${auth.tenantId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId: auth.tenantId, leadIds: body.leadIds, campaignId: id }),
  });
  if (!res.ok) return c.json({ error: "draft generation failed", detail: await res.text() }, 502);
  return c.json(await res.json());
});

app.get("/:id/messages", async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  if (!id) return c.json({ error: "missing id" }, 400);
  const db = getDb(c.env);
  const [campaign] = await db
    .select()
    .from(schema.outreachCampaigns)
    .where(and(eq(schema.outreachCampaigns.id, id), eq(schema.outreachCampaigns.tenantId, auth.tenantId)));
  if (!campaign) return c.json({ error: "not found" }, 404);

  const messages = await db.select().from(schema.outreachMessages).where(eq(schema.outreachMessages.campaignId, campaign.id));
  return c.json({ campaign, messages });
});

const ApproveSchema = z.object({
  // Explicit allowlist of message IDs to approve, rather than "approve
  // everything in the campaign" — keeps a human looking at what they're
  // actually sending rather than rubber-stamping a batch (docs/03 §3.2).
  messageIds: z.array(z.string().uuid()).min(1),
});

/**
 * THE approval gate. This is the only route in the entire codebase that
 * flips outreach_messages.status away from "pending_approval" — the Sales
 * Agent (workers/agents/src/agents/sales.ts) has no code path that can do
 * this itself. Restricted to owner/admin so a compromised or over-eager
 * "member" account can't mass-approve outreach.
 *
 * This does not call communication-mcp directly either — it hands
 * approved messages to the Automation Agent, which is expected to enqueue
 * them onto a rate-limited Cloudflare Queue (see
 * workers/agents/src/agents/automation.ts "campaign_approved" case) rather
 * than sending them synchronously from this request.
 */
app.post("/:id/approve", requireRole("owner", "admin"), async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  if (!id) return c.json({ error: "missing id" }, 400);
  const body = ApproveSchema.parse(await c.req.json());
  const db = getDb(c.env);

  const [campaign] = await db
    .select()
    .from(schema.outreachCampaigns)
    .where(and(eq(schema.outreachCampaigns.id, id), eq(schema.outreachCampaigns.tenantId, auth.tenantId)));
  if (!campaign) return c.json({ error: "not found" }, 404);

  const updated = await db
    .update(schema.outreachMessages)
    .set({ status: "approved" })
    .where(
      and(
        eq(schema.outreachMessages.campaignId, campaign.id),
        inArray(schema.outreachMessages.id, body.messageIds),
        eq(schema.outreachMessages.status, "pending_approval") // no-op on anything already sent/approved
      )
    )
    .returning();

  await db.insert(schema.auditLog).values({
    tenantId: auth.tenantId,
    actorUserId: auth.userId,
    action: "outreach.approve",
    targetTable: "outreach_messages",
    metadata: { campaignId: campaign.id, messageIds: updated.map((m) => m.id) },
  });

  await c.env.AGENTS_WORKER.fetch(`https://agents-worker.internal/agents/automation/${auth.tenantId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId: auth.tenantId, eventType: "campaign_approved", payload: { campaignId: campaign.id } }),
  });

  return c.json({ approvedCount: updated.length, messages: updated });
});

export default app;
