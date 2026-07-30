import { getAgentByName } from "agents";
import type { FactoryEnv } from "@factory/agent-kit";
import { checkDatabase, buildHealthReport } from "@factory/health-kit";

import { PromptEngineerAgent } from "./agents/promptEngineer";
import { StoryboardAgent } from "./agents/storyboard";
import { MotionDesignerAgent } from "./agents/motionDesigner";
import { VideoDirectorAgent } from "./agents/videoDirector";
import { CopywriterAgent } from "./agents/copywriter";
import { LeadFinderAgent } from "./agents/leadFinder";
import { SalesAgent } from "./agents/sales";
import { CrmAgent } from "./agents/crm";
import { FinanceAgent } from "./agents/finance";
import { QaAgent } from "./agents/qa";
import { KnowledgeAgent } from "./agents/knowledge";
import { AnalyticsAgent } from "./agents/analytics";
import { AutomationAgent } from "./agents/automation";

export {
  PromptEngineerAgent,
  StoryboardAgent,
  MotionDesignerAgent,
  VideoDirectorAgent,
  CopywriterAgent,
  LeadFinderAgent,
  SalesAgent,
  CrmAgent,
  FinanceAgent,
  QaAgent,
  KnowledgeAgent,
  AnalyticsAgent,
  AutomationAgent,
};

export interface Env extends FactoryEnv {
  PROMPT_ENGINEER_AGENT: DurableObjectNamespace;
  STORYBOARD_AGENT: DurableObjectNamespace;
  MOTION_DESIGNER_AGENT: DurableObjectNamespace;
  VIDEO_DIRECTOR_AGENT: DurableObjectNamespace;
  COPYWRITER_AGENT: DurableObjectNamespace;
  LEAD_FINDER_AGENT: DurableObjectNamespace;
  SALES_AGENT: DurableObjectNamespace;
  CRM_AGENT: DurableObjectNamespace;
  FINANCE_AGENT: DurableObjectNamespace;
  QA_AGENT: DurableObjectNamespace;
  KNOWLEDGE_AGENT: DurableObjectNamespace;
  ANALYTICS_AGENT: DurableObjectNamespace;
  AUTOMATION_AGENT: DurableObjectNamespace;
}

/**
 * Maps the URL slug (kebab-case, matches AgentName in
 * @factory/shared-types) to its wrangler.jsonc binding name. Used both by
 * this Worker's own router and, implicitly, by the URL scheme the
 * frontend's `useAgent({ agent: "<slug>", name: tenantId })` hook expects
 * (agents/react constructs `/agents/<slug>/<name>` — see
 * apps/web/lib/useAgentStream.ts).
 */
const AGENT_BINDING: Record<string, keyof Env> = {
  "prompt-engineer": "PROMPT_ENGINEER_AGENT",
  storyboard: "STORYBOARD_AGENT",
  "motion-designer": "MOTION_DESIGNER_AGENT",
  "video-director": "VIDEO_DIRECTOR_AGENT",
  copywriter: "COPYWRITER_AGENT",
  "lead-finder": "LEAD_FINDER_AGENT",
  sales: "SALES_AGENT",
  crm: "CRM_AGENT",
  finance: "FINANCE_AGENT",
  qa: "QA_AGENT",
  knowledge: "KNOWLEDGE_AGENT",
  analytics: "ANALYTICS_AGENT",
  automation: "AUTOMATION_AGENT",
};

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      const { body, httpStatus } = await buildHealthReport("agents-worker", {
        database: () => checkDatabase(env.DATABASE_URL),
      });
      return Response.json({ ...body, agents: Object.keys(AGENT_BINDING) }, { status: httpStatus });
    }

    // Expected shape: /agents/<agent-slug>/<tenantId>[/...rest]
    // Both plain HTTP (agent.onRequest) and WebSocket upgrades (Control
    // Room live state) go through the same path — the DO's own fetch
    // handler (provided by the `Agent` base class) branches on the
    // Upgrade header internally.
    const [, prefix, agentSlug, tenantId] = url.pathname.split("/");
    if (prefix !== "agents" || !agentSlug || !tenantId) {
      return Response.json(
        { error: "expected path /agents/:agentSlug/:tenantId, e.g. /agents/sales/<tenantId>" },
        { status: 400 }
      );
    }

    const bindingKey = AGENT_BINDING[agentSlug];
    if (!bindingKey) {
      return Response.json({ error: `unknown agent "${agentSlug}"`, known: Object.keys(AGENT_BINDING) }, { status: 404 });
    }

    const namespace = env[bindingKey] as DurableObjectNamespace;
    const agent = await getAgentByName(namespace, tenantId);
    return agent.fetch(request);
  },
};
