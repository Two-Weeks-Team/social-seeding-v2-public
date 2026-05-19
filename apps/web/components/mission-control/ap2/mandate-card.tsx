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
 *   1. ⚖️ AP2-INTENT badge (slate-blue distinguishes from outreach/shipment)
 *   2. Campaign id (camp_a8f3…) — links to campaign drill-in
 *   3. One-line description (creator_payout · 7명)
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

  return (
    <div
      className="grid grid-cols-[auto_auto_1fr_auto_auto_auto_auto] gap-3 items-center px-4 py-3 border-b border-slate-100 hover:bg-slate-50/60"
      data-approval-id={approvalId}
      role="row"
    >
      {bulkSelectable ? (
        <input
          type="checkbox"
          aria-label={
            bulkDisabled && bulkDisabledReason
              ? `${campaignName} — ${bulkDisabledReason}`
              : `${campaignName} — select for bulk sign`
          }
          checked={bulkChecked}
          disabled={bulkDisabled}
          onChange={(e) => onBulkToggle?.(approvalId, e.target.checked)}
          className="h-5 w-5 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
        />
      ) : (
        <span aria-hidden="true" className="w-5" />
      )}

      <Badge variant="violet" aria-label={t("kind_label")}>
        <span aria-hidden="true">⚖️</span> {t("kind_label")}
      </Badge>

      <div className="min-w-0">
        <div className="text-[13px] font-medium text-slate-900 truncate">
          {campaignName}
        </div>
        <Link
          href={`/campaigns/${campaignId}`}
          className="text-[11px] mono text-slate-500 hover:text-slate-900 underline-offset-2 hover:underline"
        >
          camp_{campaignId.slice(0, 8)}
        </Link>
        <span className="text-[12px] text-slate-600 ml-2">· {description}</span>
      </div>

      <div className="text-right">
        <div
          className="text-[14px] font-semibold mono text-slate-900"
          aria-label={formatMoneyAriaLabel(draft.totalAmount as Money, locale)}
        >
          {formatMoney(draft.totalAmount as Money, locale)}
        </div>
      </div>

      <Badge variant={waitTone}>
        <span className="mono">
          {waitMinutes}
          {locale === "ko" ? "분" : locale === "ja" ? "分" : locale === "zh" ? "分" : "m"}
        </span>{" "}
        {t("wait_label")}
      </Badge>

      <PartnerBadge partnerId={draft.partner} locale={locale} size="compact" />

      <Link
        href={`/approvals/${approvalId}`}
        className="text-slate-500 hover:text-slate-900 px-2 py-1"
        aria-label={`Open approval ${campaignName}`}
      >
        →
      </Link>
    </div>
  );
}
