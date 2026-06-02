import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * StatusTag — live state pill conveyed by COLOR + TEXT + DOT (never color alone,
 * per WCAG 1.4.1). Use for campaign / track / approval state. C2 tokens.
 */
export type StatusTone = "ok" | "run" | "warn" | "stop" | "neutral";

const TONE: Record<StatusTone, { wrap: string; dot: string }> = {
  ok: { wrap: "bg-ok-bg text-ok", dot: "bg-ok" },
  run: { wrap: "bg-run-bg text-run", dot: "bg-run" },
  warn: { wrap: "bg-warn-bg text-warn", dot: "bg-warn" },
  stop: { wrap: "bg-stop-bg text-stop", dot: "bg-stop" },
  neutral: { wrap: "bg-surface-2 text-ink-2", dot: "bg-ink-3" },
};

export function StatusTag({
  tone,
  children,
  className,
  size = "md",
}: {
  tone: StatusTone;
  children: ReactNode;
  className?: string;
  size?: "sm" | "md";
}) {
  const t = TONE[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full font-semibold whitespace-nowrap",
        size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-[12px]",
        t.wrap,
        className,
      )}
    >
      <span className={cn("rounded-full", size === "sm" ? "w-1.5 h-1.5" : "w-[7px] h-[7px]", t.dot)} aria-hidden />
      {children}
    </span>
  );
}
