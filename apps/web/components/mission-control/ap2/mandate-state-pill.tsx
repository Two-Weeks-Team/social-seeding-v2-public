/**
 * Mandate state pill — visual indicator of where a Mandate sits in the
 * AP2-UX.md §8 state machine.
 *
 * D-IDs touched:
 *   D27 — every state pill renders the `AWAITING_PAYMENT_HUMAN` step
 *         distinctly so the operator sees that payment auth is still pending
 *         even after a successful Intent sign.
 *
 * States (per AP2-UX.md §8):
 *   AGENT_DRAFT → PENDING → EDITING → SIGNED → AWAITING_PAYMENT_HUMAN →
 *     PAID → SETTLED  (happy path)
 *   ↳ REJECTED · EXPIRED · REFUNDED  (terminal)
 *
 * Used in:
 *   - inbox row (compact, beside the campaign name)
 *   - drill-in header (header strip)
 *   - bulk-approve modal per-child summary
 *   - timeline view on the campaign drill-in
 */
import { Badge } from "@/components/ui/badge";
import { AP2_STATE_TONE, type AP2State } from "@/lib/ap2/mandate";
import { createTranslator } from "@/lib/ap2/i18n";
import type { AP2Locale } from "@/lib/ap2/mandate";

export interface MandateStatePillProps {
  state: AP2State;
  locale: AP2Locale;
  /** Optional secondary annotation (e.g. "signed 12m ago"). */
  detail?: string;
}

export function MandateStatePill({ state, locale, detail }: MandateStatePillProps) {
  const t = createTranslator(locale);
  const label = t(`state_${state}`);
  return (
    <span className="inline-flex items-center gap-2">
      <Badge variant={AP2_STATE_TONE[state]} aria-label={`Payment state: ${label}`}>
        <span aria-hidden="true">
          {state === "PAID" || state === "SETTLED" ? "✓ " : null}
          {state === "REJECTED" || state === "REFUNDED" ? "✕ " : null}
          {state === "EXPIRED" ? "⌛ " : null}
        </span>
        {label}
      </Badge>
      {detail && <span className="text-[11px] text-ink-3">{detail}</span>}
    </span>
  );
}
