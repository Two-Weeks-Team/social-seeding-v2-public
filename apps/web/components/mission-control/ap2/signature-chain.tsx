/**
 * Signature chain — visualises the AP2 v0.2.0 cryptographic chain
 * (Intent → Cart → Payment) per `PROTOCOLS.md §2.3` and AP2-UX.md §6.3.
 *
 * D-IDs touched:
 *   D27 — in v2 day-1, the Cart + Payment Mandates do NOT exist until the
 *         operator signs them in a separate ceremony; this component renders
 *         the future steps as "pending human auth" placeholders so the
 *         operator can see where they are in the chain.
 *
 * AP2-UX.md §6.3 specifies the forensic view shows:
 *   User (operator) — signs Intent
 *      ↓ sha256
 *   payment_mandate agent — composes Cart draft
 *      ↓ sha256
 *   PSP (Adyen / …) — receives Payment Mandate with agentic_signals
 *
 * Each node renders: actor name, signature status, jti short-form, timestamp.
 * The hash arrows are styled as small SHA-256 indicators to communicate the
 * cryptographic binding without overwhelming the layout.
 */
import { partnerOrUnknown } from "@/lib/ap2/partner-registry";
import { createTranslator } from "@/lib/ap2/i18n";
import type { AP2Locale } from "@/lib/ap2/mandate";

export interface ChainStep {
  /** Display label — e.g. "User (operator)", "payment_mandate agent". */
  actor: string;
  /** Short-form id — e.g. "intent-7f3a". */
  jtiShort: string;
  /** Step status. `pending` = not yet signed. */
  status: "signed" | "pending" | "expired" | "rejected";
  /** ISO timestamp; rendered locale-aware. */
  timestamp?: Date;
  /** Optional sub-label — "by @operator at 17:32". */
  detail?: string;
}

export interface SignatureChainProps {
  intent: ChainStep;
  cart: ChainStep;
  payment: ChainStep;
  partnerId?: string;
  locale: AP2Locale;
}

export function SignatureChain({
  intent,
  cart,
  payment,
  partnerId,
  locale,
}: SignatureChainProps) {
  const t = createTranslator(locale);
  const partner = partnerId ? partnerOrUnknown(partnerId) : null;

  return (
    <div
      className="flex flex-col gap-0"
      role="list"
      aria-label="AP2 signature chain — Intent to Cart to Payment"
    >
      <ChainNode step={intent} role="Intent Mandate" locale={locale} />
      <ChainEdge label="sha256" />
      <ChainNode step={cart} role="Cart Mandate" locale={locale} />
      <ChainEdge label="sha256" />
      <ChainNode
        step={payment}
        role="Payment Mandate"
        locale={locale}
        suffix={partner ? `→ ${partner.displayName}` : undefined}
      />
      {partner && !partner.apNative && (
        <p className="mt-2 text-[11px] text-amber-700">
          ⚠ {t("partner_orchestrated")} — agentic_signals delivered via merchant orchestration only.
        </p>
      )}
    </div>
  );
}

function ChainNode({
  step,
  role,
  locale: _locale,
  suffix,
}: {
  step: ChainStep;
  role: string;
  locale: AP2Locale;
  suffix?: string;
}) {
  const tone =
    step.status === "signed"
      ? "border-emerald-200 bg-emerald-50/40 text-emerald-900"
      : step.status === "pending"
        ? "border-amber-200 bg-amber-50/40 text-amber-900"
        : step.status === "expired"
          ? "border-slate-200 bg-slate-50 text-slate-700"
          : "border-rose-200 bg-rose-50/40 text-rose-900";
  const glyph =
    step.status === "signed"
      ? "✓"
      : step.status === "pending"
        ? "⌛"
        : step.status === "expired"
          ? "—"
          : "✕";
  return (
    <div
      role="listitem"
      className={`flex items-start gap-3 p-3 rounded-md border ${tone}`}
    >
      <span aria-hidden="true" className="text-[14px] font-medium leading-none mt-0.5">
        {glyph}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[12px] uppercase tracking-wider text-slate-500 font-medium">
          {role}
        </div>
        <div className="text-[13px] font-semibold">
          {step.actor}
          {suffix && <span className="text-slate-500 font-normal"> {suffix}</span>}
        </div>
        <div className="mt-1 text-[11px] mono text-slate-600">{step.jtiShort}</div>
        {step.detail && <div className="text-[11px] text-slate-500">{step.detail}</div>}
        {step.timestamp && (
          <time
            className="text-[11px] text-slate-400 mono"
            dateTime={step.timestamp.toISOString()}
          >
            {step.timestamp.toISOString().replace("T", " ").slice(0, 19)} UTC
          </time>
        )}
      </div>
    </div>
  );
}

function ChainEdge({ label }: { label: string }) {
  return (
    <div
      className="ml-4 my-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-slate-400"
      aria-hidden="true"
    >
      <span className="block w-0.5 h-4 bg-slate-300" />
      <span className="mono">{label}</span>
    </div>
  );
}
