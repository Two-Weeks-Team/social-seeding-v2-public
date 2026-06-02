import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/cn";

/**
 * Button — C2 (Champagne & Espresso). 3 variants:
 *   primary    — espresso fill (the workspace's main "go" action), soft brand shadow
 *   secondary  — ivory surface + hairline border (the everyday)
 *   ghost      — text-only, hover fill (compact / inline actions)
 *
 * `tone` adds approve/reject/warn intent (used sparingly), `size` adjusts height.
 */
type Variant = "primary" | "secondary" | "ghost";
type Tone = "neutral" | "approve" | "reject" | "warn";
type Size = "sm" | "md" | "lg";

const SIZE: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[12px]",
  md: "h-9 px-3.5 text-[13px]",
  lg: "h-10 px-5 text-[14px]",
};

const VARIANT_BASE: Record<Variant, string> = {
  primary: "bg-brand text-white hover:bg-brand-2 shadow-brand",
  secondary: "bg-surface text-ink border border-line hover:bg-surface-2",
  ghost: "bg-transparent text-ink-2 hover:bg-surface-2",
};

const TONE_PRIMARY: Record<Tone, string> = {
  neutral: "",
  approve: "bg-ok hover:bg-ok/90 shadow-none",
  reject: "bg-stop hover:bg-stop/90 shadow-none",
  warn: "bg-warn hover:bg-warn/90 shadow-none",
};

const TONE_SECONDARY: Record<Tone, string> = {
  neutral: "",
  approve: "text-ok border-ok/30 hover:bg-ok-bg",
  reject: "text-stop border-stop/30 hover:bg-stop-bg",
  warn: "text-warn border-warn/30 hover:bg-warn-bg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  tone?: Tone;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", tone = "neutral", size = "md", className, ...rest },
  ref,
) {
  const toneClass =
    variant === "primary" ? TONE_PRIMARY[tone] : variant === "secondary" ? TONE_SECONDARY[tone] : "";
  return (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-xl font-semibold transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        // WCAG 2.4.11 — keyboard focus always shows a visible ring regardless of variant bg.
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-ink focus-visible:ring-offset-2",
        SIZE[size],
        VARIANT_BASE[variant],
        toneClass,
        className,
      )}
      {...rest}
    />
  );
});
