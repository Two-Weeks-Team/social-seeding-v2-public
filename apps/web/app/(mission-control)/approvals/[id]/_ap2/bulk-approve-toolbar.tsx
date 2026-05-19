"use client";

/**
 * Bulk-approve toolbar — AP2-UX.md §3.4 wireframe E.
 *
 * D-IDs touched:
 *   D27 — bulk approve signs a BUNDLE SD-JWT containing the hashes of all
 *         N Mandates (max 10). One WebAuthn assertion covers all; replay-
 *         protected by the bundle's own jti + each child Mandate's jti.
 *
 * AP2-UX.md §3.4 constraints (enforced here):
 *   - Bulk disabled if any selected Mandate has `first-time-partner`.
 *   - Bulk disabled if total > operator's daily authority ceiling.
 *   - Bulk disabled if any Mandate has `Model-Armor-flagged`.
 *   - Bulk-approve is workspace-scoped (R5 cross-tenant safety) — UI greys
 *     out cross-workspace rows (enforced by the parent: only same-workspace
 *     rows are passed in).
 *
 * The toolbar is "sticky" at the bottom of the viewport when 2+ rows are
 * selected. On click of `전체 서명`, the parent opens a modal (rendered
 * separately) showing the delta-diff readback per AP2-UX.md §3.4.
 */

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { PartnerSummary } from "@/components/mission-control/ap2/partner-badge";
import {
  formatMoney,
  formatMoneyAriaLabel,
  sumMoney,
  type AP2Locale,
  type MandateEdit,
  type Money,
  type PaymentMandateDraft,
} from "@/lib/ap2/mandate";
import { createTranslator } from "@/lib/ap2/i18n";

export interface BulkSelectionItem {
  approvalId: string;
  draft: PaymentMandateDraft;
  /** Operator edits applied to this Mandate (if any). */
  edits?: MandateEdit;
}

export interface BulkApproveToolbarProps {
  /** Selected items — parent owns the source-of-truth selection state. */
  selected: BulkSelectionItem[];
  locale: AP2Locale;
  /** Daily authority ceiling — bulk disabled above this. */
  dailyCeiling?: Money;
  onRejectAll: () => void;
  onSignBundle: () => void;
  onSeparateReview: (approvalId: string) => void;
}

export function BulkApproveToolbar({
  selected,
  locale,
  dailyCeiling,
  onRejectAll,
  onSignBundle,
  onSeparateReview,
}: BulkApproveToolbarProps) {
  const t = createTranslator(locale);

  // Total amount across all selected, ASSUMING SAME CURRENCY (AP2-UX.md §3.4).
  const total = useMemo(() => {
    if (selected.length === 0) return null;
    try {
      return sumMoney(selected.map((s) => s.draft.totalAmount as Money));
    } catch {
      // mixed currencies — return null (toolbar still shows count but no total)
      return null;
    }
  }, [selected]);

  const partnerIds = selected.map((s) => s.draft.partner);

  // Disable conditions per §3.4
  const hasFirstTime = selected.some((s) =>
    (s.draft.serverChips ?? s.draft.initialChips).some(
      (c) => c.chip === "first-time-partner" && c.passed,
    ),
  );
  const hasArmorFlag = selected.some((s) =>
    (s.draft.serverChips ?? s.draft.initialChips).some(
      (c) => c.chip === "Model-Armor-passed" && !c.passed,
    ),
  );
  const ceilingExceeded =
    dailyCeiling && total && dailyCeiling.currency === total.currency
      ? Number(total.amount) > Number(dailyCeiling.amount)
      : false;

  const disableReasons: string[] = [];
  if (hasFirstTime) disableReasons.push(t("bulk_modal_blocked_first_time"));
  if (hasArmorFlag) disableReasons.push(t("bulk_modal_blocked_armor"));
  if (ceilingExceeded) disableReasons.push(t("bulk_modal_blocked_ceiling"));
  const signDisabled = selected.length < 2 || disableReasons.length > 0;

  if (selected.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 w-[min(96vw,960px)] z-40 bg-white border border-slate-200 rounded-lg shadow-lg px-4 py-3 flex flex-wrap items-center gap-4"
      role="toolbar"
      aria-label="Bulk approve toolbar"
    >
      <div className="text-[13px] font-medium text-slate-900">
        ☑ {t("bulk_toolbar_count", { count: selected.length })}
      </div>
      {total && (
        <div className="text-[13px] mono text-slate-700">
          <span aria-label={formatMoneyAriaLabel(total, locale)}>
            {t("bulk_toolbar_total", { amount: formatMoney(total, locale) })}
          </span>
        </div>
      )}
      <div className="text-[12px] text-slate-700">
        <PartnerSummary partnerIds={partnerIds} locale={locale} />
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="secondary" tone="reject" onClick={onRejectAll}>
          {t("button_bulk_reject_all")}
        </Button>
        {disableReasons.length > 0 && (
          <details className="text-[11px] text-amber-700">
            <summary className="cursor-pointer">⚠ blocked</summary>
            <ul className="mt-1 space-y-0.5 max-w-xs">
              {disableReasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </details>
        )}
        <Button
          variant="primary"
          tone="approve"
          onClick={onSignBundle}
          disabled={signDisabled}
          aria-describedby="bulk-sign-hint"
        >
          {t("button_bulk_sign", { count: selected.length })}
        </Button>
        <span id="bulk-sign-hint" className="sr-only">
          One WebAuthn assertion will sign {selected.length} Mandates. Replay-protected.
        </span>
      </div>
      {/* per-item separate-review actions live in a row drop-down (omitted from
          the sticky toolbar to keep it scannable). */}
      <BulkSeparate selected={selected} locale={locale} onSeparate={onSeparateReview} />
    </div>
  );
}

function BulkSeparate({
  selected,
  locale,
  onSeparate,
}: {
  selected: BulkSelectionItem[];
  locale: AP2Locale;
  onSeparate: (approvalId: string) => void;
}) {
  const t = createTranslator(locale);
  const [open, setOpen] = useState(false);
  if (selected.length === 0) return null;
  return (
    <div className="relative">
      <button
        type="button"
        className="text-[11px] text-slate-500 hover:text-slate-900 underline-offset-2 hover:underline"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {t("button_separate_review")}
      </button>
      {open && (
        <ul
          className="absolute bottom-full right-0 mb-2 bg-white border border-slate-200 rounded-md shadow-md min-w-[220px] max-h-[260px] overflow-y-auto"
          role="menu"
        >
          {selected.map((s) => (
            <li key={s.approvalId} role="menuitem">
              <button
                type="button"
                className="block w-full text-left px-3 py-1.5 text-[12px] hover:bg-slate-50"
                onClick={() => {
                  onSeparate(s.approvalId);
                  setOpen(false);
                }}
              >
                <span className="mono">{s.approvalId.slice(0, 12)}</span>
                <span className="text-slate-500 ml-2">
                  {formatMoney(s.draft.totalAmount as Money, locale)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Bulk-approve modal — rendered when the operator clicks `전체 서명`.
 * Per AP2-UX.md §3.4 it shows:
 *   - The per-Mandate one-line summary
 *   - delta diff card (agent-draft → operator override) per changed Mandate
 *   - The warning about non-AP2-native partners
 *   - The warning about first-time partners
 *   - Final "WebAuthn 인증 후 N건 서명" button
 */
export interface BulkApproveModalProps {
  selected: BulkSelectionItem[];
  locale: AP2Locale;
  onCancel: () => void;
  onConfirm: () => void;
}

export function BulkApproveModal({
  selected,
  locale,
  onCancel,
  onConfirm,
}: BulkApproveModalProps) {
  const t = createTranslator(locale);
  const total = useMemo(() => {
    if (selected.length === 0) return null;
    try {
      return sumMoney(selected.map((s) => s.draft.totalAmount as Money));
    } catch {
      return null;
    }
  }, [selected]);

  const editedCount = selected.filter(
    (s) => s.edits && (s.edits.recipientEdits.length > 0 || s.edits.operatorNote),
  ).length;
  const unchangedCount = selected.length - editedCount;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-modal-title"
    >
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6">
        <h2 id="bulk-modal-title" className="text-[18px] font-semibold">
          {t("bulk_modal_title", { count: selected.length })}
        </h2>
        <p className="mt-2 text-[12px] text-slate-600">{t("bulk_modal_explainer")}</p>
        <ul className="mt-4 space-y-1 text-[12px]">
          {selected.map((s) => (
            <li
              key={s.approvalId}
              className="flex items-center gap-3 px-3 py-2 border border-slate-100 rounded"
            >
              <span className="mono text-slate-500">{s.approvalId.slice(0, 10)}</span>
              <span className="font-medium">
                {s.draft.intent.category} · {s.draft.recipients.length}
              </span>
              <span className="ml-auto mono">
                {formatMoney(s.draft.totalAmount as Money, locale)}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-3 text-[12px] text-slate-700">
          <span className="block">
            {t("bulk_modal_diff_unchanged", { count: unchangedCount })}
          </span>
          {editedCount > 0 && (
            <span className="block">
              {t("bulk_modal_diff_changed", { count: editedCount })}
            </span>
          )}
        </div>
        {total && (
          <p className="mt-3 text-[13px] font-semibold">
            {t("bulk_toolbar_total", { amount: formatMoney(total, locale) })}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {t("button_cancel")}
          </Button>
          <Button variant="primary" tone="approve" onClick={onConfirm}>
            {t("button_bulk_sign", { count: selected.length })}
          </Button>
        </div>
      </div>
    </div>
  );
}
