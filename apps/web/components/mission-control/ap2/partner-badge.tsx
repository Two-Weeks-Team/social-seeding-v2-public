/**
 * Partner badge — renders the AP2 payment partner name + icon + AP2-native
 * status (or `⚠` decoration if the partner routes via merchant orchestration).
 *
 * D-IDs touched:
 *   D27 — partner badge is mandatory on the inbox row, drill-in, bulk modal,
 *         and voice readback per AP2-UX.md §3.1 and anti-pattern §9.5.
 *   D34 — partner display name is brand-name verbatim (no translation); the
 *         "AP2 native" / "merchant orchestration" tag is translated.
 *
 * AP2-UX.md compliance:
 *   - apNative === true  → Badge variant tinted; tag reads "AP2 native"
 *   - apNative === false → Badge slate + `⚠` glyph; tag reads
 *                          "merchant orchestration"
 *   - SR aria-label: full readout — "Adyen, AP2 native payment partner"
 */
import { Badge } from "@/components/ui/badge";
import { partnerOrUnknown, type PaymentPartner } from "@/lib/ap2/partner-registry";
import { createTranslator } from "@/lib/ap2/i18n";
import type { AP2Locale } from "@/lib/ap2/mandate";

export interface PartnerBadgeProps {
  partnerId: string;
  locale: AP2Locale;
  /**
   * "compact" → just icon + name (inbox row).
   * "detailed" → icon + name + "AP2 native" / "via merchant orchestration" tag
   *   (drill-in cards, bulk modal).
   */
  size?: "compact" | "detailed";
  /** Renders a `⚠` glyph next to non-AP2-native partners. */
  showWarning?: boolean;
}

export function PartnerBadge({
  partnerId,
  locale,
  size = "compact",
  showWarning = true,
}: PartnerBadgeProps) {
  const t = createTranslator(locale);
  const partner: PaymentPartner = partnerOrUnknown(partnerId);
  const tone = partner.tone ?? "slate";
  const tag = partner.apNative ? t("partner_ap2_native") : t("partner_orchestrated");
  const aria = `${partner.displayName}, ${tag}`;

  if (size === "compact") {
    return (
      <Badge variant={partner.apNative ? tone : "slate"} aria-label={aria}>
        <span aria-hidden="true">{partner.icon}</span>
        <span>{partner.displayName}</span>
        {showWarning && !partner.apNative && (
          <span aria-hidden="true" className="text-warn">
            ⚠
          </span>
        )}
      </Badge>
    );
  }

  return (
    <span
      className="inline-flex flex-col gap-0.5"
      aria-label={aria}
      role="group"
    >
      <span className="inline-flex items-center gap-1.5">
        <Badge variant={partner.apNative ? tone : "slate"}>
          <span aria-hidden="true">{partner.icon}</span>
          <span className="font-medium">{partner.displayName}</span>
        </Badge>
        {showWarning && !partner.apNative && (
          <span
            aria-hidden="true"
            className="text-warn text-[11px] font-medium"
            title={tag}
          >
            ⚠
          </span>
        )}
      </span>
      <span className="text-[11px] text-ink-3 pl-1">{tag}</span>
    </span>
  );
}

/**
 * Inline partner summary used in §3.4 bulk-approve toolbar — collapses N
 * partners into "Adyen ×12, PayPal ×2".
 */
export function PartnerSummary({
  partnerIds,
  locale: _locale,
}: {
  partnerIds: string[];
  locale: AP2Locale;
}) {
  const counts = new Map<string, number>();
  for (const id of partnerIds) {
    const p = partnerOrUnknown(id);
    counts.set(p.displayName, (counts.get(p.displayName) ?? 0) + 1);
  }
  const entries = Array.from(counts.entries());
  if (entries.length === 0) return null;
  return (
    <span className="text-[12px] text-ink-2">
      {entries.map(([name, count], i) => (
        <span key={name}>
          {i > 0 && ", "}
          <span className="mono">{name}</span>
          <span className="text-ink-3"> ×{count}</span>
        </span>
      ))}
    </span>
  );
}
