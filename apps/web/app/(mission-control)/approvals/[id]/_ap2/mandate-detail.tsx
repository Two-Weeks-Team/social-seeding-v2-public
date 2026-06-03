"use client";

/**
 * AP2 Intent Mandate drill-in detail — the full review surface specified in
 * AP2-UX.md §3.2.
 *
 * D-IDs touched:
 *   D26 — Mission Control surface (Next.js 16 App Router).
 *   D27 — every signing action is a fresh WebAuthn ceremony; agent never
 *         autonomously signs (Intent-only scope clamp).
 *   D33 — operator_note is PII; the parent persists it under PIPA Article 23
 *         30-day retention; the Mandate JWS itself is financial evidence.
 *   D34 — every visible string flows through the locale-aware translator.
 *
 * Anti-patterns this component DEFEATS:
 *   §9.2 — buttons are named "Sign all" / "Edit and sign" / "Reject", never
 *          a bare "Approve".
 *   §9.3 — every click triggers a fresh WebAuthn `navigator.credentials.get`.
 *          No assertion is cached across actions.
 *   §9.4 — raw JWS is in a collapsed `<details>`; primary review is semantic.
 *   §9.5 — partner badge is mandatory and visible.
 *   §9.9 — server re-fetches state before resolving (server-action / route
 *          handler responsibility, not the client's).
 *
 * A11y (AP2-UX.md §7):
 *   - H1 is first focusable element after the back-link.
 *   - Focus order: reject → edit-then-sign → sign-all (destructive first).
 *   - All chips have aria-label with state.
 *   - Live region on expiry countdown updates every minute, not every second.
 *   - Recipient table has proper <caption>, <th scope="row|col">.
 */

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { PartnerBadge } from "@/components/mission-control/ap2/partner-badge";
import { MandateStatePill } from "@/components/mission-control/ap2/mandate-state-pill";
import { EditThenSignDrawer } from "./edit-then-sign-drawer";
import { WebAuthnStepUp, type StepUpResult } from "./webauthn-step-up";
import {
  expiryGuard,
  formatMoney,
  formatMoneyAriaLabel,
  uuidv7,
  type AP2Locale,
  type MandateEdit,
  type MandateRecipient,
  type Money,
  type PaymentMandateDraft,
  type RejectReason,
} from "@/lib/ap2/mandate";
import { createTranslator } from "@/lib/ap2/i18n";

export interface MandateDetailProps {
  approvalId: string;
  approvalCreatedAt: string; // ISO — driven from the server
  campaignId: string;
  campaignName: string;
  rationale: string;
  draft: PaymentMandateDraft;
  locale: AP2Locale;
  /** Per AP2-UX.md §3.6 — operator can override workspace policy at sign time. */
  highValueThreshold?: Money;
  /** Used by tests + Storybook. */
  onSigned?: (result: StepUpResult) => void;
  onRejected?: (reason: RejectReason, note?: string) => void;
  /**
   * Test-only — forwarded to {@link WebAuthnStepUp} so unit tests can simulate
   * the WebAuthn ceremony without `navigator.credentials.get`. Production
   * callers should leave this undefined.
   *
   * Codex PR-fix: https://github.com/Two-Weeks-Team/social-seeding-v2/pull/1#discussion_r3266224729
   */
  webAuthnTestHook?: import("./webauthn-step-up").WebAuthnStepUpProps["testHook"];
}

export function MandateDetail(props: MandateDetailProps) {
  const t = createTranslator(props.locale);
  const [edits, setEdits] = useState<MandateEdit | null>(null);
  const [editDrawerOpen, setEditDrawerOpen] = useState(false);
  const [signKind, setSignKind] = useState<null | "sign-all" | "sign-with-edits">(null);
  /** UUIDv7 nonce — captured at sign-button click, not per render (EC-2.29). */
  const [signNonce, setSignNonce] = useState<string | null>(null);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState<number>(
    expiryGuard(props.draft.exp).secondsRemaining,
  );
  const [, startTransition] = useTransition();
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Live expiry countdown — re-render every 30s per AP2-UX.md §3.2 header.
  // We don't use 1s ticks because the screen reader live region updates
  // every minute per §7.2 (avoid SR spam).
  useEffect(() => {
    const id = setInterval(() => {
      const g = expiryGuard(props.draft.exp);
      setSecondsRemaining(g.secondsRemaining);
    }, 30_000);
    return () => clearInterval(id);
  }, [props.draft.exp]);

  // Initial focus on H1 (not on the primary action) per §7.2 + §7.3.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const guard = expiryGuard(props.draft.exp);
  const expiryLabel = formatDuration(secondsRemaining, props.locale);
  // Human campaign ref — never the raw camp_ token. Use the campaign name when
  // present; otherwise a short "캠페인 ·{last4}" reference (mirrors mandate-card).
  const campaignRef = props.campaignName?.trim() || `캠페인 ·${props.campaignId.slice(-4)}`;

  const chips = props.draft.serverChips ?? props.draft.initialChips;
  const blockingChips = chips.filter(
    (c) => !c.passed && (c.chip === "Model-Armor-passed" || c.chip === "merchant-allowlist"),
  );
  const submitBlocked = guard.block || blockingChips.length > 0;

  const changeCount = useMemo(() => {
    if (!edits) return 0;
    return (
      edits.recipientEdits.length +
      (edits.reducedExp !== undefined ? 1 : 0) +
      (edits.operatorNote ? 1 : 0)
    );
  }, [edits]);

  function handleSignAll() {
    setSignNonce(uuidv7());
    setSignKind("sign-all");
  }

  /**
   * Retry path after the operator cancels the WebAuthn dialog with saved edits.
   * Without this branch the primary button (which has been relabelled to
   * "Sign with edits") would route to `handleSignAll`, dropping the saved
   * `edits` state and submitting the original mandate.
   *
   * Codex PR-fix: https://github.com/Two-Weeks-Team/social-seeding-v2/pull/1#discussion_r3266224729
   */
  function handleSignWithSavedEdits() {
    setSignNonce(uuidv7());
    setSignKind("sign-with-edits");
  }

  function handleEditThenSign(applied: MandateEdit) {
    setEdits(applied);
    setEditDrawerOpen(false);
    setSignNonce(uuidv7());
    setSignKind("sign-with-edits");
  }

  async function handleStepUpResult(result: StepUpResult) {
    setSignKind(null);
    setSignNonce(null);
    if (props.onSigned) {
      startTransition(() => {
        props.onSigned?.(result);
      });
      return;
    }
    // Default behaviour — POST to /api/approvals/[id]/sign-mandate. On success,
    // navigate back to the inbox (the workflow consumes the event and the row
    // disappears from `listPendingByWorkspace`).
    try {
      const res = await fetch(`/api/approvals/${props.approvalId}/sign-mandate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          approvalId: props.approvalId,
          nonce: result.nonce,
          edits: result.edits,
          webAuthnAssertion: result.assertion,
        }),
      });
      if (res.ok) {
        window.location.assign(`/campaigns/${props.campaignId}`);
      } else {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        alert(`Sign failed: ${json.error ?? res.status}`);
      }
    } catch {
      alert("Network error during sign");
    }
  }

  async function handleReject(reason: RejectReason, note?: string) {
    if (props.onRejected) {
      props.onRejected(reason, note);
      return;
    }
    try {
      const res = await fetch(`/api/approvals/${props.approvalId}/reject-mandate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          approvalId: props.approvalId,
          reason,
          note,
        }),
      });
      if (res.ok) {
        window.location.assign(`/campaigns/${props.campaignId}`);
      } else {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        alert(`Reject failed: ${json.error ?? res.status}`);
      }
    } catch {
      alert("Network error during reject");
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-8 py-8">
      <header className="mb-4">
        <Link
          href="/approvals"
          className="text-[12px] text-ink-3 hover:text-ink-2"
        >
          {t("back_to_inbox")}
        </Link>
        <div className="mt-2 flex items-end justify-between flex-wrap gap-3">
          <div>
            <SectionLabel>{t("header_prefix")}</SectionLabel>
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="mt-1 text-[22px] font-semibold focus:outline-none"
            >
              {props.campaignName} · {t("recipients_label")}{" "}
              {t("recipients_count", { count: props.draft.recipients.length })} ·{" "}
              <span className="mono text-ink-3 text-[16px]">
                {shortJti(props.draft.jti)}
              </span>{" "}
              <span aria-hidden="true">⚖️</span>
            </h1>
            <div className="mt-1 text-[12px] text-ink-3">
              {t("wait_label")}{" "}
              {Math.floor(
                (Date.now() - new Date(props.approvalCreatedAt).getTime()) / 60000,
              )}{" "}
              {t("wait_unit_minute")} ·{" "}
              <Link
                className="underline underline-offset-2 hover:text-ink"
                href={`/campaigns/${props.campaignId}`}
              >
                {campaignRef}
              </Link>
            </div>
            <div
              className="mt-1 text-[12px]"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <span
                className={
                  guard.expired
                    ? "text-stop font-medium"
                    : guard.warn
                      ? "text-stop"
                      : "text-ink-2"
                }
              >
                {t("expires_in")} {expiryLabel}
              </span>
              {guard.block && !guard.expired && (
                <span className="ml-2 text-stop">[60초 이내 잠금]</span>
              )}
            </div>
          </div>
          <MandateStatePill state="PENDING" locale={props.locale} />
        </div>
      </header>

      <Card className="mb-5">
        <CardBody>
          <SectionLabel className="mb-2">{t("rationale_label")}</SectionLabel>
          <p className="text-[13px] text-ink-2 leading-relaxed">
            {props.rationale}
          </p>
        </CardBody>
      </Card>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <Card>
          <CardBody>
            <SectionLabel className="mb-2">{t("summary_label")}</SectionLabel>
            <SummaryGrid draft={props.draft} locale={props.locale} />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <SectionLabel className="mb-2">{t("chips_label")}</SectionLabel>
            <ChipGrid chips={chips} locale={props.locale} />
            <div className="mt-3 pt-3 border-t border-line-2">
              <SectionLabel className="mb-2">{t("partner_label")}</SectionLabel>
              <PartnerBadge
                partnerId={props.draft.partner}
                locale={props.locale}
                size="detailed"
              />
            </div>
          </CardBody>
        </Card>
      </div>

      <Card className="mb-4">
        <CardBody>
          <SectionLabel className="mb-3">
            {t("recipients_label")} ({props.draft.recipients.length})
          </SectionLabel>
          <RecipientTable
            recipients={props.draft.recipients}
            edits={edits}
            locale={props.locale}
            onEditClick={() => setEditDrawerOpen(true)}
          />
        </CardBody>
      </Card>

      <details className="mb-4">
        <summary className="cursor-pointer text-[12px] text-ink-2 hover:text-ink px-1 py-2 select-none">
          {t("raw_jws_label")} {t("raw_jws_expand")}
        </summary>
        <pre className="mt-2 p-4 bg-surface-2 border border-line rounded-xl text-[11px] mono overflow-x-auto whitespace-pre-wrap break-all">
          {props.draft.rawJws ??
            JSON.stringify(
              {
                credential_type: "ap2.IntentMandate",
                version: "0.2.0",
                jti: props.draft.jti,
                exp: props.draft.exp,
                shopping_intent: props.draft.intent,
                delegation_mode: props.draft.delegation_mode,
              },
              null,
              2,
            )}
        </pre>
      </details>

      <div className="flex justify-end gap-2">
        <Button
          variant="secondary"
          tone="reject"
          onClick={() => setShowRejectModal(true)}
          aria-describedby="ap2-action-hint-reject"
        >
          {t("button_reject")}
        </Button>
        <Button
          variant="secondary"
          onClick={() => setEditDrawerOpen(true)}
          disabled={submitBlocked}
        >
          {t("button_edit_then_sign")}
        </Button>
        <Button
          variant="primary"
          tone="approve"
          // If the operator already applied edits and cancelled the WebAuthn
          // dialog, the button label flips to "Sign with edits". In that case
          // we must route to a handler that preserves the saved `edits` state
          // — otherwise WebAuthnStepUp receives `edits=undefined` and the
          // server signs the original mandate, silently dropping reviewed
          // amount/recipient/TTL changes.
          // Codex PR-fix: https://github.com/Two-Weeks-Team/social-seeding-v2/pull/1#discussion_r3266224729
          onClick={edits && changeCount > 0 ? handleSignWithSavedEdits : handleSignAll}
          disabled={submitBlocked}
          aria-describedby="ap2-action-hint-sign"
        >
          {edits && changeCount > 0
            ? t("button_sign_with_edits", { changeCount })
            : t("button_sign_all")}
        </Button>
      </div>
      <span id="ap2-action-hint-reject" className="sr-only">
        Reject this Mandate. Track terminates without payment.
      </span>
      <span id="ap2-action-hint-sign" className="sr-only">
        {t("sr_critical_action_hint", {
          count: props.draft.recipients.length,
          amount: formatMoneyAriaLabel(props.draft.totalAmount as Money, props.locale),
        })}
      </span>

      {editDrawerOpen && (
        <EditThenSignDrawer
          draft={props.draft}
          initialEdits={edits ?? undefined}
          locale={props.locale}
          onCancel={() => setEditDrawerOpen(false)}
          onApply={handleEditThenSign}
        />
      )}

      {signKind !== null && signNonce !== null && (
        <WebAuthnStepUp
          approvalId={props.approvalId}
          amount={props.draft.totalAmount as Money}
          locale={props.locale}
          highValueThreshold={props.highValueThreshold}
          nonce={signNonce}
          edits={signKind === "sign-with-edits" ? (edits ?? undefined) : undefined}
          onCancel={() => {
            setSignKind(null);
            setSignNonce(null);
          }}
          onSuccess={handleStepUpResult}
          testHook={props.webAuthnTestHook}
        />
      )}

      {showRejectModal && (
        <RejectModal
          locale={props.locale}
          onCancel={() => setShowRejectModal(false)}
          onConfirm={(reason, note) => {
            setShowRejectModal(false);
            void handleReject(reason, note);
          }}
        />
      )}
    </div>
  );
}

function shortJti(jti: string): string {
  return jti.length > 10 ? `${jti.slice(0, 8)}…` : jti;
}

function formatDuration(seconds: number, locale: AP2Locale): string {
  if (seconds <= 0) {
    return locale === "ko" ? "만료됨" : locale === "ja" ? "期限切れ" : locale === "zh" ? "已过期" : "expired";
  }
  const totalSec = Math.floor(seconds);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return locale === "ko"
      ? `${h}시간 ${m}분`
      : locale === "ja"
        ? `${h}時間 ${m}分`
        : locale === "zh"
          ? `${h} 小时 ${m} 分钟`
          : `${h}h ${m}m`;
  }
  if (m > 0) {
    return locale === "ko"
      ? `${m}분 ${s}초`
      : locale === "ja"
        ? `${m}分 ${s}秒`
        : locale === "zh"
          ? `${m} 分钟 ${s} 秒`
          : `${m}m ${s}s`;
  }
  return locale === "ko"
    ? `${s}초`
    : locale === "ja"
      ? `${s}秒`
      : locale === "zh"
        ? `${s} 秒`
        : `${s}s`;
}

function SummaryGrid({
  draft,
  locale,
}: {
  draft: PaymentMandateDraft;
  locale: AP2Locale;
}) {
  const t = createTranslator(locale);
  const categoryKey = `category_${draft.intent.category}`;
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[12px]">
      <Row label={t("summary_category")} value={t(categoryKey)} />
      <Row
        label={t("summary_price_max")}
        value={formatMoney(draft.intent.price_max as Money, locale)}
        mono
      />
      <Row
        label={t("summary_delegation")}
        value={
          draft.delegation_mode === "human_present"
            ? t("delegation_human_present")
            : t("delegation_human_not_present")
        }
      />
      <Row
        label={t("summary_merchant_allowlist")}
        value={draft.intent.merchant_allowlist.join(", ")}
        mono
      />
      <Row
        label={t("summary_refundable")}
        value={draft.intent.refundable_required ? "true" : "false"}
        mono
      />
      <Row label={t("summary_jti")} value={shortJti(draft.jti)} mono />
    </dl>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <>
      <dt className="text-ink-3">{label}:</dt>
      <dd className={mono ? "mono text-ink" : "text-ink"}>{value}</dd>
    </>
  );
}

function ChipGrid({
  chips,
  locale,
}: {
  chips: import("@/lib/ap2/mandate").ChipState[];
  locale: AP2Locale;
}) {
  const t = createTranslator(locale);
  return (
    <div
      className="flex flex-wrap gap-1.5"
      role="group"
      aria-label={t("sr_judge_chips_group")}
    >
      {chips.map((c) => {
        const tone = c.passed
          ? (c.chip === "first-time" ||
            c.chip === "first-time-partner" ||
            c.chip === "post-30-day-TTL" ||
            c.chip === "high-value"
              ? "amber"
              : "emerald")
          : "rose";
        const glyph = c.passed
          ? c.chip === "first-time" ||
            c.chip === "first-time-partner" ||
            c.chip === "post-30-day-TTL" ||
            c.chip === "high-value"
            ? "⚠"
            : "✓"
          : "✗";
        const labelKey = `chip_${c.chip.replaceAll("-", "_")}`;
        return (
          <span
            key={c.chip}
            role="status"
            aria-label={`${t(labelKey)}: ${c.passed ? "passed" : "failed"}${c.detail ? `; ${c.detail}` : ""}`}
            title={c.detail}
          >
            <Badge variant={tone}>
              <span aria-hidden="true">{glyph}</span> {t(labelKey)}
            </Badge>
          </span>
        );
      })}
    </div>
  );
}

function RecipientTable({
  recipients,
  edits,
  locale,
  onEditClick,
}: {
  recipients: MandateRecipient[];
  edits: MandateEdit | null;
  locale: AP2Locale;
  onEditClick: () => void;
}) {
  const t = createTranslator(locale);
  const editsByCreator = new Map(
    (edits?.recipientEdits ?? []).map((e) => [e.creatorId, e] as const),
  );

  const totalAmount = recipients.reduce<Money | null>((acc, r) => {
    const e = editsByCreator.get(r.creatorId);
    if (e && e.amount === null) return acc; // dropped
    const m = e?.amount ?? r.proposedAmount;
    if (!acc) return m;
    if (acc.currency !== m.currency) return acc;
    const sum = Number(acc.amount) + Number(m.amount);
    return { amount: sum.toFixed(acc.currency === "KRW" || acc.currency === "JPY" ? 0 : 2), currency: acc.currency };
  }, null);

  return (
    <table className="w-full text-[13px]">
      <caption className="sr-only">{t("sr_recipient_table_caption")}</caption>
      <thead className="text-[11px] uppercase tracking-wider text-ink-3 border-b border-line bg-surface-2/60">
        <tr>
          <th className="text-left px-3 py-2 font-medium w-8">
            <span className="sr-only">included</span>
          </th>
          <th scope="col" className="text-left px-3 py-2 font-medium">
            {t("recipient_table_creator")}
          </th>
          <th scope="col" className="text-right px-3 py-2 font-medium">
            {t("recipient_table_amount")}
          </th>
          <th scope="col" className="text-left px-3 py-2 font-medium">
            {t("recipient_table_judge")}
          </th>
          <th scope="col" className="text-left px-3 py-2 font-medium">
            {t("recipient_table_contract")}
          </th>
          <th scope="col" className="text-left px-3 py-2 font-medium">
            <span className="sr-only">edit</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {recipients.map((r) => {
          const edit = editsByCreator.get(r.creatorId);
          const dropped = edit?.amount === null;
          const amount = dropped ? null : edit?.amount ?? r.proposedAmount;
          return (
            <tr
              key={r.creatorId}
              className={
                dropped ? "border-b border-line-2 opacity-40 line-through" : "border-b border-line-2"
              }
            >
              <td className="px-3 py-2.5">
                <input
                  type="checkbox"
                  defaultChecked={!dropped}
                  className="cursor-pointer"
                  aria-label={`include ${r.uniqueId}`}
                  readOnly
                />
              </td>
              <th scope="row" className="px-3 py-2.5 mono font-normal text-left">
                @{r.uniqueId}
              </th>
              <td className="px-3 py-2.5 text-right">
                {amount ? (
                  <span
                    className="mono"
                    aria-label={formatMoneyAriaLabel(amount, locale)}
                  >
                    {formatMoney(amount, locale)}
                  </span>
                ) : (
                  <span className="text-ink-3">—</span>
                )}
                {edit?.amount && (
                  <div
                    className="text-[11px] text-ink-3 mono"
                    aria-label={`agent proposed ${formatMoneyAriaLabel(r.proposedAmount, locale)}`}
                  >
                    (was {formatMoney(r.proposedAmount, locale)})
                  </div>
                )}
              </td>
              <td className="px-3 py-2.5">
                <span aria-label={`judges: ${r.judgeSummary.join(", ")}`}>
                  {r.judgeSummary.map((j, idx) => (
                    <span
                      key={idx}
                      aria-hidden="true"
                      className={
                        j === "pass"
                          ? "text-ok"
                          : j === "neutral"
                            ? "text-ink-3"
                            : "text-stop"
                      }
                    >
                      {j === "pass" ? "✓" : j === "neutral" ? "·" : "✗"}
                    </span>
                  ))}
                </span>
              </td>
              <td className="px-3 py-2.5 text-ink-2 text-[12px] mono">
                {r.contractId ?? "—"}
              </td>
              <td className="px-3 py-2.5">
                <button
                  type="button"
                  onClick={onEditClick}
                  className="text-[12px] text-ink-3 hover:text-ink hover:underline underline-offset-2 mono"
                >
                  {t("recipient_table_edit")}
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-line">
          <td colSpan={2} className="px-3 py-2.5 text-right text-[11px] uppercase tracking-wider text-ink-3">
            {t("recipient_table_total")}
          </td>
          <td className="px-3 py-2.5 text-right font-semibold mono">
            {totalAmount ? formatMoney(totalAmount, locale) : "—"}
          </td>
          <td colSpan={3} />
        </tr>
      </tfoot>
    </table>
  );
}

/** Reject modal — structured picklist (§9.8 anti-pattern) + free-text note. */
function RejectModal({
  locale,
  onCancel,
  onConfirm,
}: {
  locale: AP2Locale;
  onCancel: () => void;
  onConfirm: (reason: RejectReason, note?: string) => void;
}) {
  const t = createTranslator(locale);
  const [reason, setReason] = useState<RejectReason>("amount_too_high");
  const [note, setNote] = useState<string>("");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reject-modal-title"
    >
      <div className="bg-surface border border-line rounded-2xl shadow-soft w-full max-w-md p-5">
        <h2 id="reject-modal-title" className="text-[16px] font-semibold mb-3 text-ink">
          {t("reject_modal_title")}
        </h2>
        <label className="block">
          <span className="text-[12px] text-ink-3 block mb-1">
            {t("reject_reason_label")}
          </span>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value as RejectReason)}
            className="w-full bg-surface border border-line rounded-xl px-2 py-1.5 text-[13px] text-ink"
          >
            <option value="amount_too_high">{t("reject_reason_amount_too_high")}</option>
            <option value="wrong_recipient">{t("reject_reason_wrong_recipient")}</option>
            <option value="partner_concern">{t("reject_reason_partner_concern")}</option>
            <option value="policy_violation">{t("reject_reason_policy_violation")}</option>
            <option value="other">{t("reject_reason_other")}</option>
          </select>
        </label>
        <label className="block mt-3">
          <span className="text-[12px] text-ink-3 block mb-1">
            {t("reject_note_label")}
          </span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 500))}
            maxLength={500}
            rows={3}
            className="w-full bg-surface border border-line rounded-xl px-2 py-1.5 text-[13px] text-ink"
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {t("button_cancel")}
          </Button>
          <Button
            variant="primary"
            tone="reject"
            onClick={() => onConfirm(reason, note || undefined)}
          >
            {t("reject_button_confirm")}
          </Button>
        </div>
      </div>
    </div>
  );
}
