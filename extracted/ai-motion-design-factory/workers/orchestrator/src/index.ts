/**
 * Orchestrator — starts/inspects pipeline runs (POST/GET /pipelines) and,
 * on a Cron Trigger, advances any pipeline_runs that are due for their
 * next step and drains job_queue (currently just outreach sends). Cron
 * Triggers are available on the Workers Free plan, which is the whole
 * point of this design vs. Cloudflare Workflows — see
 * docs/06-oss-free-stack.md.
 *
 * Add the trigger in this Worker's wrangler.jsonc:
 *   "triggers": { "crons": ["* * * * *"] }   // every minute
 */
import { createDb, schema } from "@factory/db";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { runStep, STEP_ORDER, type Env as PipelineEnv, type PipelineParams, type PipelineRunRow } from "./pipeline";

export interface Env extends PipelineEnv {
  COMMUNICATION_MCP_URL: string;
}

const MAX_RUNS_PER_TICK = 20;
const MAX_JOBS_PER_TICK = 30;
const MAX_STEP_ATTEMPTS = 3;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const db = createDb(env.DATABASE_URL);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "orchestrator" });
    }

    if (request.method === "POST" && url.pathname === "/pipelines") {
      const params = (await request.json()) as PipelineParams;
      if (!params.tenantId || !params.productId) {
        return Response.json({ error: "tenantId and productId are required" }, { status: 400 });
      }
      const [run] = await db
        .insert(schema.pipelineRuns)
        .values({ tenantId: params.tenantId, params, currentStep: STEP_ORDER[0], status: "running" })
        .returning();
      return Response.json({ id: run!.id, status: run!.status }, { status: 202 });
    }

    if (request.method === "GET" && url.pathname.startsWith("/pipelines/")) {
      const id = url.pathname.split("/")[2];
      if (!id) return Response.json({ error: "missing instance id" }, { status: 400 });
      const [run] = await db.select().from(schema.pipelineRuns).where(eq(schema.pipelineRuns.id, id));
      if (!run) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json(run);
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(advanceDuePipelines(env));
    ctx.waitUntil(drainJobQueue(env));
  },
};

async function advanceDuePipelines(env: Env) {
  const db = createDb(env.DATABASE_URL);
  const due = await db
    .select()
    .from(schema.pipelineRuns)
    .where(
      and(
        eq(schema.pipelineRuns.status, "running"),
        or(isNull(schema.pipelineRuns.waitUntil), lte(schema.pipelineRuns.waitUntil, new Date()))
      )
    )
    .limit(MAX_RUNS_PER_TICK);

  await Promise.all(due.map((run) => advanceOneRun(env, run as unknown as PipelineRunRow & { attempts: number })));
}

async function advanceOneRun(env: Env, run: PipelineRunRow & { attempts: number }) {
  const db = createDb(env.DATABASE_URL);
  try {
    const { nextStep, stepStatePatch } = await runStep(env, run);
    const mergedState = { ...(run.stepState as object), ...stepStatePatch };

    if (nextStep === "done") {
      await db
        .update(schema.pipelineRuns)
        .set({ status: "succeeded", currentStep: "done", stepState: mergedState, updatedAt: new Date() })
        .where(eq(schema.pipelineRuns.id, run.id));
    } else {
      await db
        .update(schema.pipelineRuns)
        .set({ currentStep: nextStep, stepState: mergedState, attempts: 0, lastError: null, updatedAt: new Date() })
        .where(eq(schema.pipelineRuns.id, run.id));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = (run.attempts ?? 0) + 1;
    if (attempts >= MAX_STEP_ATTEMPTS) {
      await db
        .update(schema.pipelineRuns)
        .set({ status: "failed", lastError: message, attempts, updatedAt: new Date() })
        .where(eq(schema.pipelineRuns.id, run.id));
    } else {
      // Exponential-ish backoff via wait_until, similar in spirit to
      // Workflows' retry policy, implemented with one UPDATE.
      const backoffMinutes = 2 ** attempts;
      await db
        .update(schema.pipelineRuns)
        .set({
          lastError: message,
          attempts,
          waitUntil: new Date(Date.now() + backoffMinutes * 60_000),
          updatedAt: new Date(),
        })
        .where(eq(schema.pipelineRuns.id, run.id));
    }
  }
}

/**
 * Drains job_queue — currently only `send_outreach_message`, enqueued by
 * the Automation Agent when a campaign is approved
 * (workers/agents/src/agents/automation.ts). Each job calls
 * communication-mcp's send_email tool directly (no agent/LLM involved —
 * this is a purely mechanical send of an already-approved, already-drafted
 * message).
 */
async function drainJobQueue(env: Env) {
  const db = createDb(env.DATABASE_URL);
  const due = await db
    .select()
    .from(schema.jobQueue)
    .where(and(eq(schema.jobQueue.status, "pending"), lte(schema.jobQueue.runAfter, new Date())))
    .limit(MAX_JOBS_PER_TICK);

  await Promise.all(due.map((job) => processJob(env, job)));
}

async function processJob(env: Env, job: typeof schema.jobQueue.$inferSelect) {
  const db = createDb(env.DATABASE_URL);
  await db.update(schema.jobQueue).set({ status: "processing" }).where(eq(schema.jobQueue.id, job.id));

  try {
    if (job.jobType === "send_outreach_message") {
      await sendOutreachMessage(env, (job.payload as { outreachMessageId: string }).outreachMessageId);
    } else {
      throw new Error(`unknown job_type "${job.jobType}"`);
    }
    await db.update(schema.jobQueue).set({ status: "done" }).where(eq(schema.jobQueue.id, job.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = job.attempts + 1;
    await db
      .update(schema.jobQueue)
      .set({
        status: attempts >= MAX_STEP_ATTEMPTS ? "failed" : "pending",
        attempts,
        lastError: message,
        runAfter: new Date(Date.now() + 5 * 60_000), // retry in 5 minutes
      })
      .where(eq(schema.jobQueue.id, job.id));
  }
}

async function sendOutreachMessage(env: Env, outreachMessageId: string) {
  const db = createDb(env.DATABASE_URL);
  const [message] = await db.select().from(schema.outreachMessages).where(eq(schema.outreachMessages.id, outreachMessageId));
  if (!message || message.status !== "approved") return; // already sent, or approval was revoked — silently skip

  const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.id, message.leadId));
  const [campaign] = await db.select().from(schema.outreachCampaigns).where(eq(schema.outreachCampaigns.id, message.campaignId));
  if (!lead?.contactEmail) throw new Error(`lead ${message.leadId} has no contact email`);

  const draft = JSON.parse(message.generatedBody) as { subject: string; bodyText: string; bodyHtml: string };

  const res = await fetch(`${env.COMMUNICATION_MCP_URL}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: {
        name: "send_email",
        arguments: {
          tenantId: campaign!.tenantId,
          leadId: lead.id,
          to: lead.contactEmail,
          subject: draft.subject,
          bodyHtml: draft.bodyHtml,
          bodyText: draft.bodyText,
          jurisdiction: campaign!.jurisdiction ?? "OTHER",
          campaignId: campaign!.id,
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`communication-mcp call failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { result?: { content: { text: string }[] } };
  const sendResult = JSON.parse(data.result?.content?.[0]?.text ?? "{}") as { sent: boolean; skippedReason?: string };

  await db
    .update(schema.outreachMessages)
    .set({ status: sendResult.sent ? "sent" : "suppressed", sentAt: sendResult.sent ? new Date() : undefined })
    .where(eq(schema.outreachMessages.id, message.id));

  if (!sendResult.sent) {
    throw new Error(`send skipped: ${sendResult.skippedReason ?? "unknown reason"}`);
  }
}
