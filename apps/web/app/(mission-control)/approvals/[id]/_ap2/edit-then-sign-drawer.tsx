"use client";

/**
 * Edit-then-sign drawer — AP2-UX.md §3.3.
 *
 * D-IDs touched:
 *   D27 — the operator's edit creates a NEW Intent (new jti, prior_intent_jti
 *         pointing at the agent draft). This drawer captures the edits; the
 *         server-side action composes the new Intent JWS during sign.
 *
 * AP2-UX.md §3.3 constraints (enforced here):
 *   - Per-recipient amount: editable, but ≤ proposed × 1.2 without
 *     `uplift_acknowledged: true`.
 *   - Per-recipient inclusion (checkbox): editable; at least one must remain.
 *   - Merchant allowlist: locked (read-only).
 *   - Refundable flag: locked (read-only).
 *   - TTL: reducible only — operator can shorten replay window, never extend.
 *   - Rationale (operator_note): free-text 0-500 chars; appended to Mandate
 *     as `operator_note` claim.
 *
 * Delta diff card at bottom shows `agent_proposed → operator` per changed
 * row, with the percentage delta.
 *
 * Floor warning: edit below `floorAmount` → toast warning, still allowed.
 */

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { DiagnosticBanner } from "@/components/ui/diagnostic";
import {
  formatMoney,
  formatMoneyAriaLabel,
  moneyGreaterThan,
  type AP2Locale,
  type MandateEdit,
  type Money,
  type PaymentMandateDraft,
  type RecipientEdit,
} from "@/lib/ap2/mandate";
import { createTranslator } from "@/lib/ap2/i18n";

export interface EditThenSignDrawerProps {
  draft: PaymentMandateDraft;
  initialEdits?: MandateEdit;
  locale: AP2Locale;
  onCancel: () => void;
  onApply: (edits: MandateEdit) => void;
}

interface RowState {
  creatorId: string;
  uniqueId: string;
  included: boolean;
  amount: string; // string for input control
  acknowledgedFloor: boolean;
}

export function EditThenSignDrawer({
  draft,
  initialEdits,
  locale,
  onCancel,
  onApply,
}: EditThenSignDrawerProps) {
  const t = createTranslator(locale);
  const editsByCreator = useMemo(
    () =>
      new Map(
        (initialEdits?.recipientEdits ?? []).map((e) => [e.creatorId, e] as const),
      ),
    [initialEdits],
  );

  const [rows, setRows] = useState<RowState[]>(
    draft.recipients.map((r) => {
      const e = editsByCreator.get(r.creatorId);
      return {
        creatorId: r.creatorId,
        uniqueId: r.uniqueId,
        included: !(e && e.amount === null),
        amount: (e?.amount ?? r.proposedAmount).amount,
        acknowledgedFloor: e?.acknowledgedFloor ?? false,
      };
    }),
  );
  const [note, setNote] = useState<string>(initialEdits?.operatorNote ?? "");
  const [reducedExp, setReducedExp] = useState<number | undefined>(
    initialEdits?.reducedExp,
  );
  const [upliftAcknowledged, setUpliftAcknowledged] = useState<boolean>(
    initialEdits?.uplift_acknowledged ?? false,
  );

  function patchRow(creatorId: string, patch: Partial<RowState>) {
    setRows((cur) => cur.map((r) => (r.creatorId === creatorId ? { ...r, ...patch } : r)));
  }

  const proposedByCreator = new Map(
    draft.recipients.map((r) => [r.creatorId, r] as const),
  );

  // Diff computation — what's changed vs the agent draft.
  const diff: Array<{
    creatorId: string;
    uniqueId: string;
    before: Money;
    after: Money | null; // null = dropped
    deltaPercent: number | null;
    upliftWarning: boolean;
    floorWarning: boolean;
  }> = [];

  for (const row of rows) {
    const proposed = proposedByCreator.get(row.creatorId);
    if (!proposed) continue;
    const before = proposed.proposedAmount;
    const after = row.included
      ? ({ amount: row.amount, currency: before.currency } as Money)
      : null;
    const changed = after === null || after.amount !== before.amount;
    if (!changed) continue;
    let deltaPercent: number | null = null;
    if (after) {
      const beforeNum = Number(before.amount);
      const afterNum = Number(after.amount);
      deltaPercent = beforeNum > 0 ? ((afterNum - beforeNum) / beforeNum) * 100 : null;
    }
    const upliftCap: Money = {
      amount: (Number(before.amount) * draft.intent.per_recipient_uplift_max).toString(),
      currency: before.currency,
    };
    const upliftWarning = after !== null && moneyGreaterThan(after, upliftCap);
    const floorWarning = !!(
      after !== null &&
      proposed.floorAmount &&
      moneyGreaterThan(proposed.floorAmount, after)
    );
    diff.push({
      creatorId: row.creatorId,
      uniqueId: row.uniqueId,
      before,
      after,
      deltaPercent,
      upliftWarning,
      floorWarning,
    });
  }

  const upliftViolatorCount = diff.filter((d) => d.upliftWarning).length;
  const anyIncluded = rows.some((r) => r.included);
  const submitDisabled =
    !anyIncluded || (upliftViolatorCount > 0 && !upliftAcknowledged);

  // Reduced-TTL field — only reducible per §3.3.
  const minExp = Math.floor(Date.now() / 1000) + 60;
  const maxExp = draft.exp;

  function handleApply() {
    const recipientEdits: RecipientEdit[] = [];
    for (const row of rows) {
      const proposed = proposedByCreator.get(row.creatorId);
      if (!proposed) continue;
      if (!row.included) {
        recipientEdits.push({
          creatorId: row.creatorId,
          amount: null,
          acknowledgedFloor: false,
        });
        continue;
      }
      if (row.amount !== proposed.proposedAmount.amount) {
        recipientEdits.push({
          creatorId: row.creatorId,
          amount: { amount: row.amount, currency: proposed.proposedAmount.currency },
          acknowledgedFloor: row.acknowledgedFloor,
        });
      }
    }
    const final: MandateEdit = {
      recipientEdits,
      operatorNote: note || undefined,
      reducedExp: reducedExp && reducedExp < maxExp ? reducedExp : undefined,
      uplift_acknowledged: upliftAcknowledged,
    };
    onApply(final);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-brand/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-drawer-title"
    >
      <div className="bg-surface border-l border-line w-full max-w-2xl h-full overflow-y-auto shadow-soft flex flex-col">
        <header className="px-6 py-4 border-b border-line">
          <h2 id="edit-drawer-title" className="text-[18px] font-semibold text-ink">
            {t("drawer_edit_title")}
          </h2>
        </header>

        <div className="flex-1 px-6 py-4 space-y-4">
          <Card>
            <CardBody>
              <SectionLabel className="mb-2">{t("drawer_field_amount")}</SectionLabel>
              <table className="w-full text-[13px]">
                <thead className="text-[11px] uppercase tracking-wider text-ink-3 border-b border-line">
                  <tr>
                    <th className="text-left py-2 w-8 font-medium">
                      <span className="sr-only">{t("drawer_field_inclusion")}</span>
                    </th>
                    <th className="text-left py-2 font-medium">@</th>
                    <th className="text-left py-2 font-medium">proposed</th>
                    <th className="text-left py-2 font-medium">operator</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const proposed = proposedByCreator.get(row.creatorId);
                    if (!proposed) return null;
                    return (
                      <tr key={row.creatorId} className="border-b border-line-2">
                        <td className="py-2">
                          <input
                            type="checkbox"
                            checked={row.included}
                            onChange={(e) =>
                              patchRow(row.creatorId, { included: e.target.checked })
                            }
                            aria-label={`include ${row.uniqueId}`}
                          />
                        </td>
                        <td className="py-2 mono text-ink">@{row.uniqueId}</td>
                        <td className="py-2 mono text-ink-3 text-[12px]">
                          {formatMoney(proposed.proposedAmount, locale)}
                        </td>
                        <td className="py-2">
                          <input
                            type="text"
                            value={row.amount}
                            disabled={!row.included}
                            onChange={(e) =>
                              patchRow(row.creatorId, {
                                amount: e.target.value.replace(/[^0-9.]/g, ""),
                              })
                            }
                            className="w-32 bg-surface border border-line rounded-xl px-2 py-1 mono text-[12px] text-ink disabled:bg-surface-2 disabled:text-ink-3"
                            aria-label={`amount for ${row.uniqueId}`}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!anyIncluded && (
                <DiagnosticBanner tone="stop" title="Select at least one recipient" className="mt-3" />
              )}
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <SectionLabel className="mb-2">{t("drawer_field_ttl")}</SectionLabel>
              <input
                type="number"
                min={minExp}
                max={maxExp}
                step={60}
                value={reducedExp ?? maxExp}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setReducedExp(v < maxExp ? v : undefined);
                }}
                className="w-full bg-surface border border-line rounded-xl px-2 py-1.5 mono text-[12px] text-ink"
                aria-label="reduced expiry (unix seconds)"
              />
              <p className="mt-1 text-[11px] text-ink-3">
                Original exp: {new Date(maxExp * 1000).toISOString()} — operator
                may only reduce.
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <SectionLabel className="mb-2">{t("drawer_field_note")}</SectionLabel>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, 500))}
                rows={3}
                maxLength={500}
                className="w-full bg-surface border border-line rounded-xl px-2 py-1.5 text-[13px] text-ink"
                aria-label="operator note"
              />
              <p className="mt-1 text-[11px] text-ink-3">{note.length}/500</p>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <SectionLabel className="mb-2">{t("drawer_delta_label")}</SectionLabel>
              {diff.length === 0 ? (
                <p className="text-[12px] text-ink-3">No changes yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {diff.map((d) => (
                    <li key={d.creatorId} className="text-[12px]">
                      <span className="mono">@{d.uniqueId}</span>{" "}
                      <span
                        aria-label={formatMoneyAriaLabel(d.before, locale)}
                      >
                        {formatMoney(d.before, locale)}
                      </span>{" "}
                      → {" "}
                      {d.after ? (
                        <span aria-label={formatMoneyAriaLabel(d.after, locale)}>
                          {formatMoney(d.after, locale)}
                        </span>
                      ) : (
                        <span className="text-stop">dropped</span>
                      )}
                      {d.deltaPercent !== null && (
                        <span
                          className={`ml-1 mono ${
                            d.deltaPercent < 0 ? "text-ok" : "text-warn"
                          }`}
                        >
                          ({d.deltaPercent > 0 ? "+" : ""}
                          {d.deltaPercent.toFixed(1)}%)
                        </span>
                      )}
                      {d.upliftWarning && (
                        <Badge variant="amber" className="ml-2">
                          ⚠ uplift {">"} 1.2×
                        </Badge>
                      )}
                      {d.floorWarning && (
                        <Badge variant="rose" className="ml-2">
                          ⚠ floor
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {upliftViolatorCount > 0 && (
                <div className="mt-3 p-3 rounded-xl border border-warn/25 bg-warn-bg">
                  <p className="text-[12px] text-warn">
                    {t("drawer_warning_uplift")}
                  </p>
                  <label className="mt-2 flex items-center gap-2 text-[12px] text-warn">
                    <input
                      type="checkbox"
                      checked={upliftAcknowledged}
                      onChange={(e) => setUpliftAcknowledged(e.target.checked)}
                    />
                    {t("drawer_acknowledge_uplift")}
                  </label>
                </div>
              )}
            </CardBody>
          </Card>
        </div>

        <footer className="px-6 py-4 border-t border-line flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {t("drawer_button_discard")}
          </Button>
          <Button variant="primary" onClick={handleApply} disabled={submitDisabled}>
            {t("drawer_button_save")}
          </Button>
        </footer>
      </div>
    </div>
  );
}
