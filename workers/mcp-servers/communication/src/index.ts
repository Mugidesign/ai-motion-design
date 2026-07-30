/**
 * communication-mcp
 *
 * This is the single choke point every outbound message passes through,
 * by design (docs/05 §3.2): suppression-list and jurisdiction/consent
 * checks live INSIDE send_email, not in the calling agent, so there is no
 * code path that reaches an inbox without passing them — an agent cannot
 * "forget" to check compliance because it never sees a raw send primitive
 * that skips it.
 *
 * Sending uses a hand-rolled SMTP client (./smtp.ts) over Workers' native
 * TCP sockets rather than a proprietary HTTP-API email service — works
 * with a self-hosted Postfix or any SMTP relay's free tier. See
 * docs/05 §3.4 and docs/06-oss-free-stack.md for why raw SMTP, and why
 * cold-outreach volume still needs real deliverability groundwork
 * (SPF/DKIM/DMARC, IP warmup) regardless of which sender you use.
 * Gmail/Outlook OAuth (not implemented in this scaffold) is reserved for
 * low-volume warm follow-ups from a tenant's own connected mailbox, a
 * materially different, lower-risk path.
 */
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createDb, schema } from "@factory/db";
import { eq } from "drizzle-orm";
import { SendEmailInputSchema, SendSlackMessageInputSchema, type SendEmailOutput } from "@factory/shared-types";
import { sendSmtpMail } from "./smtp";
import { checkDatabase, buildHealthReport } from "@factory/health-kit";

export interface Env {
  COMMUNICATION_MCP: DurableObjectNamespace;
  DATABASE_URL: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string; // wrangler vars are strings; parsed with Number() below
  SMTP_USERNAME?: string;
  SMTP_PASSWORD?: string;
  SMTP_FROM_ADDRESS?: string; // e.g. "AI Motion Design Factory <outreach@yourdomain.example>"
  SLACK_WEBHOOK_URL?: string;
}

/**
 * Jurisdictions that default to requiring explicit opt-in before the FIRST
 * automated message (docs/05 §3.2 table — Japan's 特定電子メール法 is opt-in
 * by default; the others are opt-out-with-disclosure regimes). This is a
 * conservative default, not a substitute for legal review of your actual
 * sending program.
 */
const OPT_IN_REQUIRED_JURISDICTIONS = new Set(["JP", "EU"]);

export class CommunicationMcp extends McpAgent<Env> {
  server = new McpServer({ name: "communication-mcp", version: "0.1.0" });

  async init() {
    this.server.tool(
      "send_email",
      "コンプライアンスチェック（抑制リスト・地域別同意要件）を必ず通過させた上でメールを送信する。チェック不合格時は送信せずskippedReasonを返す。",
      SendEmailInputSchema.shape,
      async (rawInput: unknown) => {
        const input = SendEmailInputSchema.parse(rawInput);
        const db = createDb(this.env.DATABASE_URL);

        // 1. Suppression check (never bypassable)
        const suppressed = await db
          .select()
          .from(schema.suppressionList)
          .where(eq(schema.suppressionList.email, input.to));
        const isSuppressed = suppressed.some((r) => r.tenantId === input.tenantId || r.tenantId === null);
        if (isSuppressed) {
          return this.skip(input.to, "suppressed");
        }

        // 2. Jurisdiction / consent check
        const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.id, input.leadId));
        if (OPT_IN_REQUIRED_JURISDICTIONS.has(input.jurisdiction) && lead?.consentStatus !== "opted_in") {
          return this.skip(input.to, `consent_required_${input.jurisdiction.toLowerCase()}`);
        }
        if (lead?.consentStatus === "opted_out" || lead?.consentStatus === "do_not_contact") {
          return this.skip(input.to, "consent_status_blocks_send");
        }

        // 3. Send via SMTP, with unsubscribe header always present
        if (!this.env.SMTP_HOST || !this.env.SMTP_USERNAME || !this.env.SMTP_PASSWORD) {
          return this.skip(input.to, "smtp_not_configured");
        }
        try {
          await sendSmtpMail(
            {
              host: this.env.SMTP_HOST,
              port: Number(this.env.SMTP_PORT ?? "465"),
              username: this.env.SMTP_USERNAME,
              password: this.env.SMTP_PASSWORD,
              ehloDomain: "ai-motion-design-factory.local",
            },
            {
              from: this.env.SMTP_FROM_ADDRESS ?? "AI Motion Design Factory <outreach@yourdomain.example>",
              to: input.to,
              subject: input.subject,
              html: appendUnsubscribeFooter(input.bodyHtml, input.leadId, input.tenantId),
              text: input.bodyText,
              extraHeaders: { "List-Unsubscribe": `<https://app.yourdomain.example/unsubscribe?lead=${input.leadId}>` },
            }
          );
        } catch (err) {
          return this.skip(input.to, `send_failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        const output: SendEmailOutput = { sent: true };
        return { content: [{ type: "text" as const, text: JSON.stringify(output) }] };
      }
    );

    this.server.tool(
      "send_slack_message",
      "既存見込み客とのフォローアップ用途に限定して使用する（コールドアウトリーチの主軸には使わない、docs/05 §3.3）",
      SendSlackMessageInputSchema.shape,
      async (rawInput: unknown) => {
        const input = SendSlackMessageInputSchema.parse(rawInput);
        if (!this.env.SLACK_WEBHOOK_URL) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ sent: false, skippedReason: "slack_not_configured" }) }] };
        }
        const res = await fetch(this.env.SLACK_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel: input.channel, text: input.text }),
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ sent: res.ok }) }] };
      }
    );

    this.server.tool(
      "check_delivery_status",
      "指定メールアドレスが抑制リストに含まれるかどうかを確認する（送信前の早期チェック用）",
      { email: { type: "string" } as any },
      async ({ email }: { email: string }) => {
        const db = createDb(this.env.DATABASE_URL);
        const rows = await db.select().from(schema.suppressionList).where(eq(schema.suppressionList.email, email));
        return { content: [{ type: "text" as const, text: JSON.stringify({ isSuppressed: rows.length > 0 }) }] };
      }
    );
  }

  private skip(_to: string, reason: string) {
    const output: SendEmailOutput = { sent: false, skippedReason: reason };
    return { content: [{ type: "text" as const, text: JSON.stringify(output) }] };
  }
}

function appendUnsubscribeFooter(html: string, leadId: string, tenantId: string): string {
  const footer = `<hr/><p style="font-size:12px;color:#888">
    このメールは営業目的で送信されています。配信停止は
    <a href="https://app.yourdomain.example/unsubscribe?lead=${leadId}&tenant=${tenantId}">こちら</a>。
  </p>`;
  return `${html}${footer}`;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") return CommunicationMcp.serve("/mcp").fetch(request, env, ctx);
    if (url.pathname === "/health") {
      const { body, httpStatus } = await buildHealthReport("communication-mcp", {
        database: () => checkDatabase(env.DATABASE_URL),
      });
      return Response.json(body, { status: httpStatus });
    }
    return new Response("Not found", { status: 404 });
  },
};
