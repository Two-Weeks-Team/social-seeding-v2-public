import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Category / status chip — C2. Variant NAMES are kept stable (so existing callers
 * don't break) but each maps onto the Champagne & Espresso token palette. For
 * live status that should read as state, prefer <StatusTag> (text + dot).
 */
const VARIANTS = {
  slate: "bg-surface-2 text-ink-2 border-line",
  blue: "bg-run-bg text-run border-run/30",
  emerald: "bg-ok-bg text-ok border-ok/30",
  amber: "bg-warn-bg text-warn border-warn/30",
  rose: "bg-stop-bg text-stop border-stop/30",
  cyan: "bg-brand-soft text-brand-ink border-brand-ink/25",
  violet: "bg-brand-soft text-brand-ink border-brand-ink/25",
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
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold leading-none",
        VARIANTS[variant],
        mono && "mono",
        className,
      )}
    >
      {children}
    </span>
  );
}
