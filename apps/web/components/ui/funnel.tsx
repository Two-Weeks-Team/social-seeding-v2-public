import { cn } from "@/lib/cn";

/**
 * Funnel — HONEST stage-conversion bars. Bar width is strictly value / max, so a
 * value of 0 renders an EMPTY track (no fake nonzero segment — the audit's
 * cardinal data-viz sin). Max defaults to the largest value; if every value is
 * 0, all tracks render empty.
 */
export type FunnelRow = { label: string; value: number };

export function Funnel({ rows, className }: { rows: FunnelRow[]; className?: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      {rows.map((r) => {
        const pct = max > 0 && r.value > 0 ? Math.max(4, (r.value / max) * 100) : 0;
        return (
          <div key={r.label} className="grid grid-cols-[92px_1fr_40px] gap-3 items-center">
            <div className="text-[12px] text-ink-2 text-right">{r.label}</div>
            <div className="h-4 rounded-lg bg-surface-2 overflow-hidden">
              {pct > 0 && (
                <div
                  className="h-full rounded-lg bg-gradient-to-r from-brand to-brand-2"
                  style={{ width: `${pct}%` }}
                />
              )}
            </div>
            <div className={cn("text-[12.5px] mono text-right", r.value > 0 ? "text-ink-2" : "text-ink-3")}>
              {r.value}
            </div>
          </div>
        );
      })}
    </div>
  );
}
