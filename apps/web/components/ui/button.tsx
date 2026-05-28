import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/cn";

/**
 * Minimal button. 3 visual variants:
 *   primary    — slate-900 fill (the workspace's main "go" action)
 *   secondary  — white surface with slate-200 border (the everyday)
 *   ghost      — text-only, hover background (compact / inline actions)
 *
 * Plus a `tone` for the few moments we genuinely need amber / rose / emerald
 * intent (approve / reject / kill switch). Used sparingly.
 */
type Variant = "primary" | "secondary" | "ghost";
type Tone = "neutral" | "approve" | "reject" | "warn";

const SIZE = "h-8 px-3 text-[13px]";

const VARIANT_BASE: Record<Variant, string> = {
  primary: "bg-slate-900 text-white hover:bg-slate-800",
  secondary: "bg-white text-slate-900 border border-slate-200 hover:bg-slate-50",
  ghost: "bg-transparent text-slate-700 hover:bg-slate-100",
};

const TONE_PRIMARY: Record<Tone, string> = {
  neutral: "",
  approve: "bg-emerald-600 hover:bg-emerald-700",
  reject: "bg-rose-600 hover:bg-rose-700",
  warn: "bg-amber-500 hover:bg-amber-600",
};

const TONE_SECONDARY: Record<Tone, string> = {
  neutral: "",
  approve: "text-emerald-700 border-emerald-200 hover:bg-emerald-50",
  reject: "text-rose-700 border-rose-200 hover:bg-rose-50",
  warn: "text-amber-700 border-amber-200 hover:bg-amber-50",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  tone?: Tone;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", tone = "neutral", className, ...rest },
  ref,
) {
  const variantClass = VARIANT_BASE[variant];
  const toneClass =
    variant === "primary" ? TONE_PRIMARY[tone] : variant === "secondary" ? TONE_SECONDARY[tone] : "";
  return (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        // A10 (P1 Sub-1.4) — WCAG 2.4.11 focus-not-obscured: ensure every
        // button has a visible 2px ring on keyboard focus regardless of the
        // variant's background. focus-visible:* keeps mouse-click outlines
        // suppressed while keyboard nav gets a high-contrast indicator.
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-1",
        SIZE,
        variantClass,
        toneClass,
        className,
      )}
      {...rest}
    />
  );
});
