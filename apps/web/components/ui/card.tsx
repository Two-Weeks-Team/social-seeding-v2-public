import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Surface primitive. White surface · 1px slate-200 border · rounded 8px.
 * No shadow by default. The `hover` flag adds a 1-pixel translate-y on hover
 * (no shadow — the lift is enough to feel responsive).
 */
export function Card({
  children,
  className,
  hover = false,
  as: As = "div",
}: {
  children: ReactNode;
  className?: string;
  hover?: boolean;
  as?: "div" | "section" | "article";
}) {
  return (
    <As
      className={cn(
        "bg-white border border-slate-200 rounded-lg",
        hover && "transition-transform hover:-translate-y-px",
        className,
      )}
    >
      {children}
    </As>
  );
}

export function CardHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("px-5 py-3 border-b border-slate-200 flex items-center justify-between", className)}>{children}</div>;
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("px-5 py-4", className)}>{children}</div>;
}

export function CardTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("text-[15px] font-semibold text-slate-900", className)}>{children}</div>;
}

export function CardSubtitle({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("text-[11px] text-slate-500", className)}>{children}</div>;
}

/**
 * Section header used as a poor-cousin to CardHeader when we're not inside a
 * Card (e.g. above a table that fills its own card). All-caps + thin spacing.
 */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("text-[10px] uppercase tracking-wider text-slate-500 font-medium", className)}>
      {children}
    </div>
  );
}
