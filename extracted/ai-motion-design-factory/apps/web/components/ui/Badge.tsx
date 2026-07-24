import { cn } from "@/lib/utils";

const VARIANT_CLASSES = {
  live: "bg-signal-live/15 text-signal-live",
  ready: "bg-signal-ready/15 text-signal-ready",
  standby: "bg-signal-standby/15 text-signal-standby",
  error: "bg-signal-error/15 text-signal-error",
  neutral: "bg-panel-raised text-ink-muted",
} as const;

export function Badge({
  variant = "neutral",
  className,
  children,
}: {
  variant?: keyof typeof VARIANT_CLASSES;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={cn("rounded px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wide", VARIANT_CLASSES[variant], className)}>
      {children}
    </span>
  );
}
