/**
 * Mandate card — compact inbox row for an AP2 Intent Mandate awaiting human
 * decision.
 *
 * D-IDs touched:
 *   D26 — Mission Control surface; this is the row that appears in
 *         /approvals when `kind === "payment_mandate"`.
 *   D27 — every row links to a human-only signing path (no auto-approve, even
 *         "low value").
 *   D34 — currency / wait-time / partner labels all use the operator's locale.
 *
 * AP2-UX.md §3.1 columns:
 *   1. ⚖️ AP2-INTENT badge (brand-tinted; distinguishes from outreach/shipment)
 *   2. Campaign ref — human name (or "Campaign ·1234" fallback), links to drill-in
 *   3. One-line description (creator_payout · 7)
 *   4. Total amount — locale formatted
 *   5. Wait time — minutes since Intent was created; turns rose after 30 min
 *   6. Payment partner badge with `⚠` if non-AP2-native
 *   7. Drill-in chevron
 *
 * Bulk-select checkbox column appears when the inbox filter is
 * `kind=payment_mandate`; controlled by the parent via `bulkSelectable`.
 */
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { PartnerBadge } from "./partner-badge";
import {
  formatMoney,
  formatMoneyAriaLabel,
  type Money,
  type PaymentMandateDraft,
  type AP2Locale,
} from "@/lib/ap2/mandate";
import { createTranslator } from "@/lib/ap2/i18n";

export interface MandateCardProps {
  approvalId: string;
  campaignId: string;
  campaignName: string;
  draft: PaymentMandateDraft;
  /** Minutes since the Intent was composed. */
  waitMinutes: number;
  locale: AP2Locale;
  /** Whether bulk-select checkbox should render (per AP2-UX.md §3.1 filter). */
  bulkSelectable?: boolean;
  /** Initial checked state in a controlled bulk selection. */
  bulkChecked?: boolean;
  /** Bulk-select change callback. Client-side parents wire this up. */
  onBulkToggle?: (approvalId: string, checked: boolean) => void;
  /** Per row whether the bulk checkbox is disabled (e.g. first-time-partner). */
  bulkDisabled?: boolean;
  /** Disable reason — surfaced as `aria-label` on the disabled checkbox. */
  bulkDisabledReason?: string;
}

const CATEGORY_KEY: Record<string, string> = {
  creator_payout: "category_creator_payout",
  sample_carrier: "category_sample_carrier",
  ads_topup: "category_ads_topup",
  platform_subscription: "category_platform_subscription",
  tax_remittance: "category_tax_remittance",
  refund_disbursement: "category_refund_disbursement",
  other: "category_other",
};

export function MandateCard({
  approvalId,
  campaignId,
  campaignName,
  draft,
  waitMinutes,
  locale,
  bulkSelectable = false,
  bulkChecked = false,
  onBulkToggle,
  bulkDisabled = false,
  bulkDisabledReason,
}: MandateCardProps) {
  const t = createTranslator(locale);
  const categoryKey = CATEGORY_KEY[draft.intent.category] ?? "category_other";
  const description = `${t(categoryKey)} · ${draft.recipients.length}`;
  const waitTone =
    waitMinutes >= 30 ? "rose" : waitMinutes >= 10 ? "amber" : "slate";
  // Human campaign ref — never the raw camp_ token. Use the campaign name when
  // present; otherwise a short "Campaign ·{last4}" reference (mirrors creatorLabel).
  const campaignRef = campaignName?.trim() || `Campaign ·${(campaignId ?? "").slice(-4)}`;

  return (
    <div
      className="grid grid-cols-[auto_auto_1fr_auto_auto_auto_auto] gap-3 items-center px-4 py-3 border-b border-line-2 hover:bg-surface-2/50"
      data-approval-id={approvalId}
      role="row"
    >
      {bulkSelectable ? (
        <input
          type="checkbox"
          aria-label={
            bulkDisabled && bulkDisabledReason
              ? `${campaignRef} — ${bulkDisabledReason}`
              : `${campaignRef} — select for bulk signing`
          }
          checked={bulkChecked}
          disabled={bulkDisabled}
          onChange={(e) => onBulkToggle?.(approvalId, e.target.checked)}
          className="h-5 w-5 cursor-pointer accent-brand disabled:cursor-not-allowed disabled:opacity-40"
        />
      ) : (
        <span aria-hidden="true" className="w-5" />
      )}

      <Badge variant="violet" aria-label={t("kind_label")}>
        <span aria-hidden="true">⚖️</span> {t("kind_label")}
      </Badge>

      <div className="min-w-0">
        <Link
          href={`/campaigns/${campaignId}`}
          className="text-[13px] font-medium text-ink truncate hover:text-brand-ink underline-offset-2 hover:underline block"
        >
          {campaignRef}
        </Link>
        <span className="text-[12px] text-ink-2">{description}</span>
      </div>

      <div className="text-right">
        <div
          className="text-[14px] font-semibold mono tnum text-ink"
          aria-label={formatMoneyAriaLabel(draft.totalAmount as Money, locale)}
        >
          {formatMoney(draft.totalAmount as Money, locale)}
        </div>
      </div>

      <Badge variant={waitTone}>
        <span className="mono">
          {waitMinutes}
          {locale === "en" ? "m" : t("wait_unit_minute")}
        </span>{" "}
        {t("wait_label")}
      </Badge>

      <PartnerBadge partnerId={draft.partner} locale={locale} size="compact" />

      <Link
        href={`/approvals/${approvalId}`}
        className="text-ink-3 hover:text-brand-ink px-2 py-1"
        aria-label={`Open approval for ${campaignRef}`}
      >
        →
      </Link>
    </div>
  );
}
