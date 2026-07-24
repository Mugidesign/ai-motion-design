"use client";

import { AgentPanel } from "@/components/control-room/AgentPanel";
import { AGENT_SLUGS } from "@/lib/useAgentStream";
import { useEffect, useState } from "react";

/** A simple master clock, in keeping with the broadcast control-room
 *  framing — purely decorative, but a real touch: control rooms always
 *  have a visible house clock. */
function MasterClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="font-mono text-sm tabular-nums text-ink-muted">{now ? now.toLocaleTimeString("ja-JP") : "--:--:--"}</span>;
}

export default function ControlRoomPage() {
  return (
    <div className="p-6">
      <header className="mb-6 flex items-center justify-between border-b border-hairline pb-4">
        <div>
          <h1 className="text-lg font-semibold text-ink-primary">Control Room</h1>
          <p className="mt-0.5 text-sm text-ink-muted">13エージェントの稼働状況をリアルタイム表示</p>
        </div>
        <MasterClock />
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {AGENT_SLUGS.map((slug) => (
          <AgentPanel key={slug} agentSlug={slug} />
        ))}
      </div>

      <p className="mt-6 font-mono text-[11px] text-ink-faint">
        承認待ち（AMBER）のパネルは Campaigns 画面で内容を確認・承認してください。自動送信は行われません。
      </p>
    </div>
  );
}
