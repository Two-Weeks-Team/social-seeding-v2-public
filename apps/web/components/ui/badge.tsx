import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Status / category chip. Variants map to status colors (single-purpose, no
 * decorative use). All variants share the same 1px border + tiny padding +
 * 11px text — distinguishability comes from color, not size.
 */
const VARIANTS = {
  slate: "bg-slate-100 text-slate-700 border-slate-200",
  blue: "bg-blue-50 text-blue-700 border-blue-200",
  emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  rose: "bg-rose-50 text-rose-700 border-rose-200",
  cyan: "bg-cyan-50 text-cyan-700 border-cyan-200",
  violet: "bg-violet-50 text-violet-700 border-violet-200",
} as const;

export type BadgeVariant = keyof typeof VARIANTS;

export function Badge({
  children,
  variant = "slate",
  mono = false,
  className,
}: {
  children: ReactNode;
  variant?: BadgeVariant;
  mono?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none",
        VARIANTS[variant],
        mono && "mono",
        className,
      )}
    >
      {children}
    </span>
  );
}
