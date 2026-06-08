import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * EmptyState — one calm, consolidated "nothing here yet" surface. Replaces the
 * audit's stacks-of-empty-boxes anti-pattern. Optional icon (inline SVG/char),
 * title, hint, and a single primary action.
 */
export function EmptyState({
  icon,
  title,
  hint,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("bg-surface border border-line rounded-2xl shadow-soft px-6 py-12 text-center", className)}>
      {icon != null && <div className="mx-auto mb-3 text-ink-3 text-[22px]" aria-hidden>{icon}</div>}
      <div className="text-[14px] font-semibold text-ink">{title}</div>
      {hint != null && <div className="mt-1.5 text-[13px] text-ink-3 max-w-[460px] mx-auto">{hint}</div>}
      {action != null && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}
