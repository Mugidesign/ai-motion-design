/**
 * @factory/agent-kit — shared base class for all 13 product agents.
 *
 * Every agent in workers/agents/src/agents/*.ts extends BaseFactoryAgent
 * instead of the raw `Agent` class from `agents`, so the boilerplate below
 * (LLM calls, MCP server wiring, run logging to `agent_runs`, and Control
 * Room state broadcasting) is written once and reviewed once, rather than
 * copy-pasted 13 times.
 *
 * OSS/free-stack note (docs/06-oss-free-stack.md): Durable Objects (the
 * `agents` package's `Agent` base class, SQLite-backed) stay in this
 * design — they're free-tier eligible on Cloudflare Workers, unlike
 * Hyperdrive, which this file no longer depends on. `this.db` now takes a
 * plain DATABASE_URL pointing at a self-hosted Postgres (docker-compose.yml)
 * instead of a Hyperdrive binding. LLM calls default to Workers AI running
 * open-weight models (free tier, no API key), with Ollama (fully
 * self-hosted), Anthropic, and OpenAI available as opt-in swaps via
 * LLM_PROVIDER — see callLLM below.
 */
import { Agent } from "agents";
import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { createDb, type Db, agentRuns } from "@factory/db";

export type LlmProvider = "workers-ai" | "ollama" | "anthropic" | "openai";

/** Bindings shared by every Worker that hosts one or more of these agents.
 *  Extend this per-worker if a specific agent needs an extra binding —
 *  see workers/agents/src/index.ts for the concrete Env used in this repo. */
export interface FactoryEnv {
  /** Self-hosted Postgres (docker-compose.yml), reached directly — no
   *  Hyperdrive in the free-stack configuration. Hyperdrive has no free
   *  tier (docs/06 §pricing table); add it back later as a pure
   *  performance optimization if/when you're on Workers Paid anyway. */
  DATABASE_URL: string;

  /** Default "workers-ai" — free tier, open-weight models, zero setup.
   *  "ollama" is the fully self-hosted, zero-cloud-dependency option for
   *  anyone running their own GPU box. "anthropic"/"openai" remain
   *  available as opt-in paid upgrades when quality matters more than
   *  cost for a given deployment. */
  LLM_PROVIDER?: LlmProvider;

  /** Workers AI binding — required when LLM_PROVIDER is "workers-ai"
   *  (the default). Add `"ai": { "binding": "AI" }` to wrangler.jsonc. */
  AI?: Ai;
  WORKERS_AI_MODEL?: string; // default "@cf/meta/llama-3.1-8b-instruct"

  OLLAMA_BASE_URL?: string; // e.g. "http://ollama:11434" inside docker-compose's network
  OLLAMA_MODEL?: string; // default "llama3.1"

  ANTHROPIC_API_KEY?: string;
  MODEL_NAME?: string; // Anthropic model override, default "claude-sonnet-4-6"

  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string; // default "gpt-4o-mini"

  MOTION_GENERATOR_MCP_URL: string;
  LEAD_ENRICHMENT_MCP_URL: string;
  COMMUNICATION_MCP_URL: string;
  KNOWLEDGE_MCP_URL: string;
  CRM_FINANCE_MCP_URL: string;
}

export type McpServerKey =
  | "motion-generator"
  | "lead-enrichment"
  | "communication"
  | "knowledge"
  | "crm-finance";

/** Mirrors what the Control Room UI renders per agent — see
 *  apps/web/components/control-room/AgentPanel.tsx. Kept intentionally
 *  small so state-sync payloads stay cheap. */
export interface AgentStatusState {
  status: "idle" | "running" | "awaiting_approval" | "error";
  currentTask?: string;
  lastRunAt?: string;
  lastError?: string;
  runsToday?: number;
}

export const idleStatus: AgentStatusState = { status: "idle", runsToday: 0 };

/** Normalized shape every provider adapter below returns, matching the
 *  slice of Anthropic's Messages API response shape the 13 agent files
 *  already read (`response.content.find(b => b.type === "text")`) — this
 *  is what let every agent file stay unchanged across the provider swap,
 *  aside from a mechanical callClaude -> callLLM rename. */
export interface LlmResponse {
  content: Array<{ type: "text"; text: string }>;
}

export abstract class BaseFactoryAgent<
  ExtraState extends Record<string, unknown> = Record<string, never>
> extends Agent<FactoryEnv, AgentStatusState & ExtraState> {
  /** Must match the string stored in agent_runs.agent_name and the
   *  AgentName enum in @factory/shared-types. */
  protected abstract agentName: string;

  initialState = { ...idleStatus } as AgentStatusState & ExtraState;

  protected get db(): Db {
    return createDb(this.env.DATABASE_URL);
  }

  protected mcpServerConfig(key: McpServerKey) {
    const urlByKey: Record<McpServerKey, string> = {
      "motion-generator": this.env.MOTION_GENERATOR_MCP_URL,
      "lead-enrichment": this.env.LEAD_ENRICHMENT_MCP_URL,
      communication: this.env.COMMUNICATION_MCP_URL,
      knowledge: this.env.KNOWLEDGE_MCP_URL,
      "crm-finance": this.env.CRM_FINANCE_MCP_URL,
    };
    return { type: "url" as const, url: urlByKey[key], name: key };
  }

  /**
   * Calls whichever LLM_PROVIDER is configured (default: Workers AI, a
   * free-tier, open-weight model — genuinely $0 and open source, not just
   * "free tier of a closed model"). This is the standard entry point every
   * agent should use for its reasoning step.
   *
   * `mcpServers` (letting the model decide when to call a tool mid-turn)
   * is currently only wired up for the "anthropic" provider, via the
   * Messages API's mcp_servers parameter — Workers AI's and Ollama's chat
   * APIs don't have an equivalent yet, so it's a no-op for those. Every
   * agent in this codebase calls MCP tools explicitly via `callMcpTool`
   * rather than relying on model-initiated tool use, so this doesn't
   * currently limit anything — it's here for parity if you build a new
   * agent that wants Claude specifically for that behavior.
   */
  protected async callLLM(opts: {
    system: string;
    userContent: string;
    mcpServers?: McpServerKey[];
    maxTokens?: number;
  }): Promise<LlmResponse> {
    const provider = this.env.LLM_PROVIDER ?? "workers-ai";
    switch (provider) {
      case "workers-ai":
        return this.callWorkersAi(opts);
      case "ollama":
        return this.callOllama(opts);
      case "openai":
        return this.callOpenAi(opts);
      case "anthropic":
        return this.callAnthropic(opts);
      default:
        throw new Error(`unknown LLM_PROVIDER "${provider}"`);
    }
  }

  private async callWorkersAi(opts: { system: string; userContent: string; maxTokens?: number }): Promise<LlmResponse> {
    if (!this.env.AI) {
      throw new Error('LLM_PROVIDER is "workers-ai" but no AI binding is configured — add `"ai": {"binding":"AI"}` to wrangler.jsonc');
    }
    // Model string current as of authoring — Workers AI's catalog changes
    // over time, confirm at https://developers.cloudflare.com/workers-ai/models/
    // if this returns a "model not found" error.
    const model = this.env.WORKERS_AI_MODEL ?? "@cf/meta/llama-3.1-8b-instruct";
    const result = await this.env.AI.run(model as keyof AiModels, {
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.userContent },
      ],
      max_tokens: opts.maxTokens ?? 1500,
    });
    const text = (result as { response?: string }).response ?? "";
    return { content: [{ type: "text", text }] };
  }

  private async callOllama(opts: { system: string; userContent: string }): Promise<LlmResponse> {
    const base = this.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
    const model = this.env.OLLAMA_MODEL ?? "llama3.1";
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.userContent },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Ollama request failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { message: { content: string } };
    return { content: [{ type: "text", text: data.message.content }] };
  }

  private async callOpenAi(opts: { system: string; userContent: string; maxTokens?: number }): Promise<LlmResponse> {
    if (!this.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set but LLM_PROVIDER is \"openai\"");
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.env.OPENAI_MODEL ?? "gpt-4o-mini",
        max_tokens: opts.maxTokens ?? 1500,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.userContent },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI request failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return { content: [{ type: "text", text: data.choices[0]?.message.content ?? "" }] };
  }

  private async callAnthropic(opts: {
    system: string;
    userContent: string;
    mcpServers?: McpServerKey[];
    maxTokens?: number;
  }): Promise<LlmResponse> {
    if (!this.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set but LLM_PROVIDER is \"anthropic\"");
    const anthropic = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: this.env.MODEL_NAME ?? "claude-sonnet-4-6",
      max_tokens: opts.maxTokens ?? 1500,
      system: opts.system,
      messages: [{ role: "user", content: opts.userContent }],
      // @ts-expect-error mcp_servers is supported by the Messages API but may
      // not yet be reflected in the installed @anthropic-ai/sdk type defs —
      // verify against the current SDK version before removing this.
      mcp_servers: (opts.mcpServers ?? []).map((k) => this.mcpServerConfig(k)),
    });
    return response as unknown as LlmResponse;
  }

  /**
   * Wraps a unit of work with: Control Room state updates (idle -> running
   * -> idle/error), a persisted row in `agent_runs` for the Analytics Agent
   * and the audit trail, and consistent error handling.
   */
  protected async runWithLogging<T>(
    tenantId: string,
    taskLabel: string,
    input: unknown,
    fn: () => Promise<T>
  ): Promise<T> {
    const startedAt = Date.now();
    this.setState({ ...this.state, status: "running", currentTask: taskLabel });

    const [run] = await this.db
      .insert(agentRuns)
      .values({ tenantId, agentName: this.agentName, inputRef: input as object, status: "running" })
      .returning();

    try {
      const result = await fn();
      await this.db
        .update(agentRuns)
        .set({
          status: "succeeded",
          outputRef: (result ?? {}) as object,
          durationMs: Date.now() - startedAt,
        })
        .where(eq(agentRuns.id, run!.id));

      this.setState({
        ...this.state,
        status: "idle",
        currentTask: undefined,
        lastRunAt: new Date().toISOString(),
        runsToday: (this.state.runsToday ?? 0) + 1,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.db
        .update(agentRuns)
        .set({ status: "failed", outputRef: { error: message }, durationMs: Date.now() - startedAt })
        .where(eq(agentRuns.id, run!.id));

      this.setState({ ...this.state, status: "error", lastError: message, currentTask: undefined });
      throw err;
    }
  }

  /** Call when a task cannot proceed without a human decision (e.g. Sales
   *  Agent after drafting outreach — see docs/03 §3.2 on the approval gate). */
  protected markAwaitingApproval(taskLabel: string) {
    this.setState({ ...this.state, status: "awaiting_approval", currentTask: taskLabel });
  }

  /**
   * Calls an MCP tool directly over its JSON-RPC endpoint, bypassing the
   * LLM. Use this for mechanical, deterministic calls (start a render,
   * check suppression, update a deal stage) where no model judgment is
   * needed — it's cheaper and more predictable than routing every tool
   * call through an LLM turn via `callLLM`'s `mcpServers` option.
   *
   * Wire format follows MCP's JSON-RPC 2.0 `tools/call` method — verify
   * against the current MCP spec (https://modelcontextprotocol.io) if the
   * server side (agents/mcp's McpAgent.serve) changes its transport.
   */
  protected async callMcpTool<T = unknown>(
    server: McpServerKey,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<T> {
    const { url } = this.mcpServerConfig(server);
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
    });
    if (!res.ok) {
      throw new Error(`MCP call ${server}/${toolName} failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      result?: { content: { type: string; text: string }[] };
      error?: { message: string };
    };
    if (data.error) throw new Error(`MCP tool "${toolName}" on "${server}" returned an error: ${data.error.message}`);
    const text = data.result?.content?.[0]?.text ?? "{}";
    return JSON.parse(text) as T;
  }
}
