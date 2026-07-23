import { cn } from "@/lib/utils";
import type { ButtonHTMLAttributes } from "react";

const VARIANTS = {
  primary: "bg-accent text-white hover:bg-accent/90",
  secondary: "bg-panel-raised text-ink-primary border border-hairline hover:border-accent/50",
  ghost: "text-ink-muted hover:text-ink-primary hover:bg-panel-raised",
  danger: "bg-signal-error/15 text-signal-error hover:bg-signal-error/25",
} as const;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANTS;
}

export function Button({ variant = "primary", className, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40",
        VARIANTS[variant],
        className
      )}
      {...props}
    />
  );
}
