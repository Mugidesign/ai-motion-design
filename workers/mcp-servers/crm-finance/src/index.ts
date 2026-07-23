/**
 * crm-finance-mcp — deal stage transitions, Stripe invoicing, payment
 * recording (docs/02 §3, docs/05 §1 idempotency requirement).
 */
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import Stripe from "stripe";
import { createDb, schema } from "@factory/db";
import { eq } from "drizzle-orm";
import { UpdateDealStageInputSchema, CreateInvoiceInputSchema, type CreateInvoiceOutputSchema } from "@factory/shared-types";
import { z } from "zod";

export interface Env {
  CRM_FINANCE_MCP: DurableObjectNamespace;
  DATABASE_URL: string;
  STRIPE_SECRET_KEY?: string;
}

export class CrmFinanceMcp extends McpAgent<Env> {
  server = new McpServer({ name: "crm-finance-mcp", version: "0.1.0" });

  async init() {
    this.server.tool(
      "update_deal_stage",
      "商談のステージを更新し、audit_logに記録する",
      UpdateDealStageInputSchema.shape,
      async (rawInput) => {
        const input = UpdateDealStageInputSchema.parse(rawInput);
        const db = createDb(this.env.DATABASE_URL);
        const [deal] = await db
          .update(schema.deals)
          .set({ stage: input.stage })
          .where(eq(schema.deals.id, input.dealId))
          .returning();

        if (deal) {
          await db.insert(schema.auditLog).values({
            tenantId: deal.tenantId,
            action: "deal.stage_update",
            targetTable: "deals",
            targetId: deal.id,
            metadata: { newStage: input.stage, note: input.note },
          });
        }
        return { content: [{ type: "text" as const, text: JSON.stringify({ deal }) }] };
      }
    );

    this.server.tool(
      "create_invoice",
      "冪等キー付きでStripe請求書を作成する。同じidempotencyKeyでの再試行は二重課金を起こさない。",
      CreateInvoiceInputSchema.shape,
      async (rawInput) => {
        const input = CreateInvoiceInputSchema.parse(rawInput);
        const db = createDb(this.env.DATABASE_URL);

        // Idempotency check at the application layer, in addition to
        // Stripe's own Idempotency-Key header below — belt and suspenders,
        // since this tool may be retried by the Workflow step retry policy.
        const existing = await db
          .select()
          .from(schema.invoices)
          .where(eq(schema.invoices.idempotencyKey, input.idempotencyKey));
        if (existing[0]) {
          const out: z.infer<typeof CreateInvoiceOutputSchema> = {
            invoiceId: existing[0].id,
            stripeInvoiceId: existing[0].stripeInvoiceId ?? undefined,
          };
          return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
        }

        const [deal] = await db.select().from(schema.deals).where(eq(schema.deals.id, input.dealId));
        if (!deal) throw new Error("deal not found");

        let stripeInvoiceId: string | undefined;
        let hostedInvoiceUrl: string | undefined;

        if (this.env.STRIPE_SECRET_KEY) {
          const stripe = new Stripe(this.env.STRIPE_SECRET_KEY, { apiVersion: "2024-10-28.acacia" });
          const [tenant] = await db
            .select()
            .from(schema.tenantBillingAccounts)
            .where(eq(schema.tenantBillingAccounts.tenantId, deal.tenantId));

          if (tenant?.stripeCustomerId) {
            const invoice = await stripe.invoices.create(
              { customer: tenant.stripeCustomerId, collection_method: "send_invoice", days_until_due: 14 },
              { idempotencyKey: input.idempotencyKey }
            );
            await stripe.invoiceItems.create(
              {
                customer: tenant.stripeCustomerId,
                invoice: invoice.id,
                amount: Math.round(input.amountUsd * 100),
                currency: "usd",
                description: `AI Motion Design Factory — deal ${input.dealId}`,
              },
              { idempotencyKey: `${input.idempotencyKey}-item` }
            );
            const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
            stripeInvoiceId = finalized.id;
            hostedInvoiceUrl = finalized.hosted_invoice_url ?? undefined;
          }
        }

        const [saved] = await db
          .insert(schema.invoices)
          .values({
            dealId: input.dealId,
            amountUsd: String(input.amountUsd),
            status: stripeInvoiceId ? "sent" : "draft",
            idempotencyKey: input.idempotencyKey,
            stripeInvoiceId,
          })
          .returning();

        const out: z.infer<typeof CreateInvoiceOutputSchema> = {
          invoiceId: saved!.id,
          stripeInvoiceId,
          hostedInvoiceUrl,
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      }
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") return CrmFinanceMcp.serve("/mcp").fetch(request, env, ctx);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "crm-finance-mcp" });
    return new Response("Not found", { status: 404 });
  },
};
