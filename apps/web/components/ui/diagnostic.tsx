import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * DiagnosticBanner — the honest "something needs attention" surface. Used for a
 * zero-result campaign (what happened + likely cause + recovery actions) and for
 * blocking warnings (e.g. Gmail re-auth). Replaces green-washed failures and
 * internal v1/v2 narration with operator-readable guidance + a clear next step.
 */
export function DiagnosticBanner({
  tone = "warn",
  title,
  children,
  actions,
  className,
}: {
  tone?: "warn" | "stop";
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border px-5 py-4 shadow-soft",
        tone === "warn" && "bg-warn-bg border-warn/25",
        tone === "stop" && "bg-stop-bg border-stop/25",
        className,
      )}
    >
      <div className={cn("flex items-start gap-2.5 font-bold text-[14.5px]", tone === "warn" ? "text-warn" : "text-stop")}>
        <span aria-hidden className="mt-0.5">⚠</span>
        <span>{title}</span>
      </div>
      {children != null && (
        <div className="mt-2 text-[13.5px] text-ink-2 max-w-[680px] pl-[26px]">{children}</div>
      )}
      {actions != null && <div className="mt-3.5 flex flex-wrap gap-2.5 pl-[26px]">{actions}</div>}
    </div>
  );
}
