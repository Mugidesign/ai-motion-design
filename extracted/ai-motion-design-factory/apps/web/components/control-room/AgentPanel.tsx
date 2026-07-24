"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/utils";
import { useAgentStream, AGENT_LABELS, type AgentSlug, type AgentStatusState } from "@/lib/useAgentStream";

const STATUS_META: Record<AgentStatusState["status"], { label: string; dot: string; ring: string }> = {
  running: { label: "LIVE", dot: "bg-signal-live animate-pulse-tally", ring: "ring-1 ring-signal-live/40" },
  idle: { label: "READY", dot: "bg-signal-ready", ring: "" },
  awaiting_approval: { label: "承認待ち", dot: "bg-signal-standby animate-pulse-tally", ring: "ring-1 ring-signal-standby/40" },
  error: { label: "ERROR", dot: "bg-signal-error", ring: "ring-1 ring-signal-error/40" },
};

export function AgentPanel({ agentSlug }: { agentSlug: AgentSlug }) {
  const [state, setState] = useState<AgentStatusState>({ status: "idle" });
  useAgentStream(agentSlug, setState);

  const meta = STATUS_META[state.status];

  return (
    <Card className={cn("transition-shadow", meta.ring)}>
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className={cn("tally-dot", meta.dot)} />
            <span className="text-sm font-medium text-ink-primary">{AGENT_LABELS[agentSlug]}</span>
          </div>
          <p className="mt-1 truncate text-xs text-ink-muted" title={state.currentTask}>
            {state.currentTask ?? "待機中"}
          </p>
        </div>
        <span className="font-mono text-[10px] text-ink-faint">{meta.label}</span>
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-hairline pt-2 font-mono text-[11px] text-ink-muted">
        <span>本日 {state.runsToday ?? 0} 回実行</span>
        <span>{state.lastRunAt ? new Date(state.lastRunAt).toLocaleTimeString("ja-JP") : "--:--:--"}</span>
      </div>

      {state.status === "error" && state.lastError && (
        <p className="mt-2 truncate text-[11px] text-signal-error" title={state.lastError}>
          {state.lastError}
        </p>
      )}
    </Card>
  );
}
