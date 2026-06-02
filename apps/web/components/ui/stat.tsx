import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Stat — KPI card. `value` is the headline figure; `unit` renders smaller after
 * it; `hint` is the sub-line. `tone` tints the value (brand/ok/stop) or "muted"
 * for a non-computable "—" so "측정 불가" reads differently from a real 0.
 */
export function Stat({
  label,
  value,
  unit,
  hint,
  tone = "default",
  className,
}: {
  label: string;
  value: ReactNode;
  unit?: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "brand" | "ok" | "stop" | "muted";
  className?: string;
}) {
  const valueClass = cn(
    "mt-2 text-[28px] font-bold tracking-[-0.02em] tnum",
    tone === "brand" && "text-brand",
    tone === "ok" && "text-ok",
    tone === "stop" && "text-stop",
    tone === "muted" && "text-ink-3",
    tone === "default" && "text-ink",
  );
  return (
    <div className={cn("bg-surface border border-line rounded-2xl shadow-soft px-5 py-4", className)}>
      <div className="text-[10px] uppercase tracking-[0.06em] text-ink-3 font-semibold">{label}</div>
      <div className={valueClass}>
        {value}
        {unit != null && <span className="ml-1 text-[15px] font-semibold text-ink-3">{unit}</span>}
      </div>
      {hint != null && <div className="mt-1.5 text-[12px] text-ink-2">{hint}</div>}
    </div>
  );
}
