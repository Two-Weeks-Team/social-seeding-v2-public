import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Surface primitive — C2. Ivory surface · hairline border · 16px radius · soft
 * warm shadow. `hover` lifts 1px. `flat` drops the shadow for nested/inset use.
 */
export function Card({
  children,
  className,
  hover = false,
  flat = false,
  as: As = "div",
}: {
  children: ReactNode;
  className?: string;
  hover?: boolean;
  flat?: boolean;
  as?: "div" | "section" | "article";
}) {
  return (
    <As
      className={cn(
        "bg-surface border border-line rounded-2xl",
        !flat && "shadow-soft",
        hover && "transition-transform hover:-translate-y-0.5",
        className,
      )}
    >
      {children}
    </As>
  );
}

export function CardHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("px-5 py-4 border-b border-line-2 flex items-center justify-between gap-3", className)}>{children}</div>;
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("px-5 py-4", className)}>{children}</div>;
}

export function CardTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("text-[15px] font-bold text-ink", className)}>{children}</div>;
}

export function CardSubtitle({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("text-[11px] text-ink-3", className)}>{children}</div>;
}

/** All-caps section label above a table / group not wrapped in a Card header. */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("text-[10px] uppercase tracking-[0.06em] text-ink-3 font-semibold", className)}>
      {children}
    </div>
  );
}
