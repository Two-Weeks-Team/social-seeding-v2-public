import type React from "react";
import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { StatusTag } from "@/components/ui/status-tag";
import { Avatar } from "@/components/ui/avatar";
import { Stat } from "@/components/ui/stat";
import { DiagnosticBanner } from "@/components/ui/diagnostic";
import { getServerSession } from "@/lib/auth";
import { approvalRepo, campaignRepo } from "@ss/db";
import { inngest } from "@ss/workflows";
import {
  Events,
  ConversationTurnSchema,
  OutreachDraftSchema,
  type Approval,
  type Candidate,
  type ConversationTurn,
  type OutreachDraft,
} from "@ss/contracts";
import { approvalKindKo } from "@/lib/labels";
import { fmtAgo, fmtNum, creatorHandle } from "@/lib/format";
import { renderPaymentMandateApproval } from "./_ap2/render-payment-mandate";

/**
 * Approval drill-in (C2). Server component forms + resolve server action.
 * Branches by `approval.kind`:
 *   · shortlist      — candidate table with per-row keep/remove checks.
 *   · outreach send  — draft preview + evaluation scores + editable subject/body.
 *   · reply response — negotiation escalation (no edits) or editable auto-reply draft.
 *   · shipment       — address + item confirmation.
 *   · payment        — AP2 payment mandate drill-in (_ap2).
 *
 * Every path ends with approvalRepo.resolve + an event that releases the workflow gate.
 */

async function resolveAction(formData: FormData): Promise<void> {
  "use server";
  const session = await getServerSession();
  if (!session) redirect("/sign-in");

  const Form = z.object({
    approvalId: z.string().min(1),
    decision: z.enum(["approveAll", "approveSelected", "approveEdited", "reject"]),
    creatorIds: z.array(z.string()).optional(),
    // outreach/reply edits — kept in plain strings; the discriminator on the
    // approval's recommendation shape decides whether they apply.
    editedSubject: z.string().min(1).max(120).optional(),
    editedBody: z.string().min(1).optional(),
  });
  const raw: Record<string, unknown> = {
    approvalId: formData.get("approvalId"),
    decision: formData.get("decision"),
    creatorIds: formData.getAll("creatorId").map(String),
    editedSubject: formData.get("editedSubject") ?? undefined,
    editedBody: formData.get("editedBody") ?? undefined,
  };
  const parsed = Form.safeParse(raw);
  if (!parsed.success) return;
  const { approvalId, decision, creatorIds = [], editedSubject, editedBody } = parsed.data;

  const approval = await approvalRepo.get(approvalId);
  if (!approval || approval.workspaceId !== session.workspaceId) redirect("/approvals");
  if (!approval || approval.status !== "pending") redirect(`/approvals`);

  let resolvedDecision: "approved" | "edited" | "rejected" = "approved";
  let editedPayload: unknown = undefined;

  if (decision === "reject") {
    resolvedDecision = "rejected";
  } else if (decision === "approveAll") {
    resolvedDecision = "approved";
  } else if (decision === "approveSelected") {
    if (Array.isArray(approval.recommendation)) {
      const filtered = (approval.recommendation as Candidate[]).filter((c) =>
        creatorIds.includes(c.creator.id),
      );
      if (filtered.length === (approval.recommendation as Candidate[]).length) {
        resolvedDecision = "approved";
      } else {
        resolvedDecision = "edited";
        editedPayload = filtered;
      }
    } else {
      resolvedDecision = "approved";
    }
  } else if (decision === "approveEdited") {
    // outreach_send: recommendation = OutreachDraft; we merge edited subject/body.
    // reply_response (responder draft): recommendation = { subject, body, deliverabilityScore? };
    //                                  same merge applies.
    const rec = approval.recommendation as Record<string, unknown> | undefined;
    if (rec && typeof rec === "object" && !Array.isArray(rec)) {
      const merged = { ...rec, subject: editedSubject ?? rec.subject, body: editedBody ?? rec.body };
      const draftCheck = OutreachDraftSchema.partial().safeParse(merged);
      const dirty =
        (editedSubject !== undefined && editedSubject !== rec.subject) ||
        (editedBody !== undefined && editedBody !== rec.body);
      resolvedDecision = dirty ? "edited" : "approved";
      editedPayload = dirty ? merged : undefined;
      void draftCheck; // shape best-effort; the workflow re-validates downstream.
    } else {
      resolvedDecision = "approved";
    }
  }

  await approvalRepo.resolve(approvalId, resolvedDecision, session.userId, editedPayload);
  await inngest.send({
    name: Events.ApprovalResolved,
    data: {
      approvalId,
      campaignId: approval.campaignId,
      decision: resolvedDecision,
      ...(editedPayload !== undefined ? { editedPayload } : {}),
    },
  });
  revalidatePath(`/campaigns/${approval.campaignId}`);
  revalidatePath("/approvals");
  redirect(`/campaigns/${approval.campaignId}`);
}

/** Fit meter — 0-1 score. Uses a single color bar instead of a low-to-high gradient. */
function FitScoreMeter({ score }: { score: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, score)) * 100);
  const tone = score >= 0.7 ? "bg-ok" : score >= 0.4 ? "bg-warn" : "bg-stop";
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-block w-16 h-1.5 bg-surface-2 rounded-full overflow-hidden">
        <span className={`block h-full ${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="mono text-[12px] text-ink-2 tnum">{score.toFixed(2)}</span>
    </span>
  );
}

/**
 * 0-1 (or 0-max) score bar. invert=true means lower is better (spam);
 * invert=false means higher is better.
 */
function ScoreBar({
  value,
  max = 1,
  invert = false,
  label,
}: {
  value: number;
  max?: number;
  invert?: boolean;
  label: string;
}) {
  const ratio = Math.max(0, Math.min(max, value)) / max;
  const pct = Math.round(ratio * 100);
  // invert (spam): lower is better. Otherwise (evaluation): higher is better.
  const good = invert ? ratio <= 0.25 : ratio >= 0.7;
  const mid = invert ? ratio <= 0.5 : ratio >= 0.4;
  const tone = good ? "bg-ok" : mid ? "bg-warn" : "bg-stop";
  return (
    <div className="flex items-center gap-2.5 text-[12px]">
      <span className="w-28 text-ink-2">{label}</span>
      <span className="flex-1 h-1.5 bg-surface-2 rounded-full overflow-hidden">
        <span className={`block h-full ${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="mono text-ink-2 w-12 text-right tnum">
        {value.toFixed(max === 1 ? 2 : 1)}
        {max !== 1 && <span className="text-ink-3">/{max}</span>}
      </span>
    </div>
  );
}

/**
 * HTML body preview — rendered in a sandboxed iframe so agent-generated HTML
 * cannot leak styles, scripts, navigation, or forms into the parent DOM.
 */
function HtmlPreview({ html, height = 260 }: { html: string; height?: number }) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font: 13px/1.5 ui-sans-serif, system-ui; color: #1b1813; padding: 12px; margin: 0; }
    p { margin: 0 0 8px; }
    a { color: #8a6c2e; }
  </style></head><body>${html}</body></html>`;
  return (
    <iframe
      title="email-preview"
      sandbox=""
      srcDoc={doc}
      className="w-full bg-surface border border-line rounded-xl"
      style={{ height }}
    />
  );
}

/** Evaluation labels. */
const JUDGE_LABEL: Record<string, string> = {
  brand: "Brand fit",
  conversion: "Conversion",
  deliverability: "Deliverability",
  skeptic: "Trust",
};

/** Outreach angle labels. */
const ANGLE_LABEL: Record<string, string> = {
  free_tier_announcement: "Free-tier announcement",
  pain_killer: "Pain killer",
  peer_proof: "Peer proof",
  data_specific: "Data specific",
  contrarian_hook: "Contrarian hook",
  aspirational: "Aspirational",
};

/** Candidate flag labels + color tone. */
const FLAG_LABEL: Record<string, { label: string; tone: "warn" | "stop" }> = {
  below_engagement_floor: { label: "Below engagement floor", tone: "warn" },
  blacklisted: { label: "Blacklisted", tone: "stop" },
  wrong_language: { label: "Language mismatch", tone: "warn" },
  brand_unsafe: { label: "Brand unsafe", tone: "stop" },
  prior_flake: { label: "Prior flake history", tone: "warn" },
  data_stale: { label: "Stale data", tone: "warn" },
};

/** Reply classification labels + StatusTag tone. */
const CLASSIFICATION_LABEL: Record<ConversationTurn["classification"], string> = {
  interested: "Interested",
  needs_info: "Needs info",
  negotiating: "Negotiating",
  not_now: "Not now",
  declined: "Declined",
  out_of_office: "Out of office",
  unsubscribe: "Unsubscribe",
  unrelated: "Unrelated",
};

const CLASSIFICATION_TONE: Record<ConversationTurn["classification"], "ok" | "run" | "warn" | "stop" | "neutral"> = {
  interested: "ok",
  needs_info: "run",
  negotiating: "warn",
  not_now: "neutral",
  declined: "stop",
  out_of_office: "neutral",
  unsubscribe: "stop",
  unrelated: "neutral",
};

/** Shared drill-in header — back link + kind label + title + wait time + campaign link. */
function DrillHeader({
  kind,
  title,
  approval,
  right,
}: {
  kind: Approval["kind"];
  title: string;
  approval: Approval;
  right?: React.ReactNode;
}) {
  return (
    <header className="mb-5">
      <Link href="/approvals" className="text-[12px] text-ink-3 hover:text-ink-2">← Approval inbox</Link>
      <div className="mt-2 flex items-end justify-between flex-wrap gap-3">
        <div>
          <SectionLabel>{approvalKindKo(kind)}</SectionLabel>
          <h1 className="mt-1 text-[24px] font-bold tracking-[-0.01em]">{title}</h1>
          <div className="mt-1 text-[12.5px] text-ink-3">
            Waiting since {fmtAgo(approval.createdAt)} ·{" "}
            <Link className="text-ink-2 hover:text-ink underline underline-offset-2" href={`/campaigns/${approval.campaignId}`}>
              Go to campaign
            </Link>
          </div>
        </div>
        {right}
      </div>
    </header>
  );
}

/** Rationale card reused by every drill-in. */
function RationaleCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="mb-5">
      <CardBody>
        <SectionLabel className="mb-2">{title}</SectionLabel>
        <p className="text-[13.5px] text-ink-2 leading-relaxed">{children}</p>
      </CardBody>
    </Card>
  );
}

/** Honest diagnostic banner for invalid shapes or other unreviewable items. */
function DrillError({
  kind,
  title,
  detail,
  approval,
}: {
  kind: Approval["kind"];
  title: string;
  detail: string;
  approval: Approval;
}) {
  return (
    <div className="max-w-3xl mx-auto px-8 py-8">
      <DrillHeader kind={kind} title={title} approval={approval} />
      <DiagnosticBanner tone="stop" title="This item cannot be reviewed right now">
        {detail} Check the workflow record and try again.
      </DiagnosticBanner>
    </div>
  );
}

export default async function ApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  const { id } = await params;
  const approval = await approvalRepo.get(id);
  if (!approval || approval.workspaceId !== session.workspaceId) notFound();
  const campaign = await campaignRepo.get(approval.campaignId);
  const brandName = campaign?.brief.brandProduct.name;

  if (approval.kind === "outreach_send") {
    return renderOutreachSendApproval(approval, brandName);
  }
  if (approval.kind === "reply_response") {
    return renderReplyResponseApproval(approval, brandName);
  }
  if (approval.kind === "shipment") {
    return renderShipmentApproval(approval, brandName);
  }
  // AP2 payment mandate — fifth kind. The recommendation is validated with Zod at render time.
  if (approval.kind === "payment_mandate") {
    return renderPaymentMandateApproval(approval, brandName);
  }

  if (approval.kind !== "shortlist") {
    return (
      <div className="max-w-3xl mx-auto px-8 py-8">
        <DrillHeader kind={approval.kind} title={brandName ?? "Unnamed campaign"} approval={approval} />
        <Card flat>
          <CardBody>
            <p className="text-[13.5px] text-ink-2">A review screen for this approval type is coming soon.</p>
          </CardBody>
        </Card>
      </div>
    );
  }

  const candidates = Array.isArray(approval.recommendation) ? (approval.recommendation as Candidate[]) : [];

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <DrillHeader
        kind="shortlist"
        title={`${brandName ?? "Unnamed campaign"} · review ${candidates.length} candidates`}
        approval={approval}
      />

      <RationaleCard title="Why the agent recommended this">{approval.rationale}</RationaleCard>

      <form action={resolveAction}>
        <input type="hidden" name="approvalId" value={approval.id} />

        <Card className="overflow-hidden">
          <table className="w-full text-[13px]">
            <thead className="text-[10px] uppercase tracking-[0.06em] text-ink-3 border-b border-line bg-surface-2">
              <tr>
                <th className="w-10 px-4 py-3"></th>
                <th className="text-left px-4 py-3 font-semibold">Creator</th>
                <th className="text-right px-4 py-3 font-semibold">Followers</th>
                <th className="text-left px-4 py-3 font-semibold">Fit</th>
                <th className="text-left px-4 py-3 font-semibold">Warnings</th>
                <th className="text-left px-4 py-3 font-semibold">Match reason</th>
              </tr>
            </thead>
            <tbody>
              {candidates.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-ink-3">No candidates.</td></tr>
              )}
              {candidates.map((c, i) => {
                const handle = creatorHandle({ uniqueId: c.creator?.uniqueId });
                return (
                  <tr key={c.creator?.id ?? c.creator?.uniqueId ?? i} className="border-b border-line-2 last:border-0 hover:bg-surface-2/60">
                    <td className="px-4 py-3">
                      <input type="checkbox" name="creatorId" value={c.creator.id} defaultChecked className="cursor-pointer accent-brand" />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={handle} size="sm" />
                        <span className="text-ink font-medium truncate">{handle}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right mono tnum text-ink-2">{fmtNum(c.creator.followerCount)}</td>
                    <td className="px-4 py-3">
                      <FitScoreMeter score={c.fitScore} />
                    </td>
                    <td className="px-4 py-3">
                      {c.flags.length === 0 ? (
                        <StatusTag tone="ok" size="sm">No issues</StatusTag>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {c.flags.map((f) => {
                            const meta = FLAG_LABEL[f] ?? { label: f, tone: "warn" as const };
                            return (
                              <StatusTag key={f} tone={meta.tone} size="sm">{meta.label}</StatusTag>
                            );
                          })}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-ink-2 text-[12.5px]">{c.matchReasons[0] ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>

        <div className="mt-5 flex justify-end gap-2.5">
          <Button type="submit" name="decision" value="reject" variant="secondary" tone="reject">Reject</Button>
          <Button type="submit" name="decision" value="approveSelected" variant="secondary">Approve selected only</Button>
          <Button type="submit" name="decision" value="approveAll" variant="primary" tone="approve">Approve all</Button>
        </div>
      </form>
    </div>
  );
}

/**
 * Outreach send drill-in. Shows the draft produced by the writer-agent tournament:
 * angle + spam score + four evaluation bars + grounded facts + editable subject/body.
 * The body is previewed safely in a sandboxed iframe.
 */
function renderOutreachSendApproval(approval: Approval, brandName: string | undefined): React.ReactElement {
  const parsed = OutreachDraftSchema.safeParse(approval.recommendation);
  if (!parsed.success) {
    return (
      <DrillError
        kind="outreach_send"
        title={brandName ?? "Unnamed campaign"}
        detail="The attached draft does not match the outreach format."
        approval={approval}
      />
    );
  }
  const draft: OutreachDraft = parsed.data;
  const judge = draft.judgeScores ?? {};
  const spamTone = draft.spamScore <= 2 ? "ok" : draft.spamScore <= 5 ? "warn" : "stop";

  return (
    <div className="max-w-4xl mx-auto px-8 py-8">
      <DrillHeader
        kind="outreach_send"
        title={`${brandName ?? "Unnamed campaign"} · review first outreach`}
        approval={approval}
        right={
          <StatusTag tone={spamTone}>Angle · {ANGLE_LABEL[draft.angle] ?? draft.angle}</StatusTag>
        }
      />

      <RationaleCard title="Why the agent chose this draft">{approval.rationale}</RationaleCard>

      <div className="grid grid-cols-3 gap-5 mb-5">
        <Card className="col-span-2">
          <CardBody>
            <SectionLabel className="mb-3">Evaluation scores</SectionLabel>
            <div className="space-y-2.5">
              <ScoreBar label={JUDGE_LABEL.brand!} value={judge.brand ?? 0} />
              <ScoreBar label={JUDGE_LABEL.conversion!} value={judge.conversion ?? 0} />
              <ScoreBar label={JUDGE_LABEL.deliverability!} value={judge.deliverability ?? 0} />
              <ScoreBar label={JUDGE_LABEL.skeptic!} value={judge.skeptic ?? 0} />
              <div className="border-t border-line-2 mt-3 pt-3">
                <ScoreBar label="Spam risk" value={draft.spamScore} max={10} invert />
              </div>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <SectionLabel className="mb-2">Grounded facts ({draft.groundedFacts.length})</SectionLabel>
            {draft.groundedFacts.length === 0 ? (
              <div className="text-[12.5px] text-ink-3">No facts</div>
            ) : (
              <ul className="text-[12px] text-ink-2 space-y-1.5">
                {draft.groundedFacts.map((f) => (
                  <li key={f} className="truncate">· {f}</li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <form action={resolveAction}>
        <input type="hidden" name="approvalId" value={approval.id} />

        <Card className="mb-5">
          <CardBody>
            <SectionLabel className="mb-2">Subject</SectionLabel>
            <input
              type="text"
              name="editedSubject"
              defaultValue={draft.subject}
              maxLength={120}
              className="w-full bg-surface border border-line rounded-xl px-3.5 py-2.5 text-[14px] text-ink outline-none"
            />
            <SectionLabel className="mt-4 mb-2">Body (HTML)</SectionLabel>
            <textarea
              name="editedBody"
              defaultValue={draft.body}
              rows={10}
              className="w-full bg-surface border border-line rounded-xl p-3.5 text-[12px] mono text-ink outline-none"
            />
          </CardBody>
        </Card>

        <Card className="mb-5">
          <CardBody>
            <SectionLabel className="mb-2">Preview (isolated render)</SectionLabel>
            <HtmlPreview html={draft.body} />
            <p className="mt-2.5 text-[11.5px] text-ink-3">
              Tracking pixels and unsubscribe copy are added automatically at send time — they are not shown in this preview.
            </p>
          </CardBody>
        </Card>

        <div className="flex justify-end gap-2.5">
          <Button type="submit" name="decision" value="reject" variant="secondary" tone="reject">Reject</Button>
          <Button type="submit" name="decision" value="approveEdited" variant="primary" tone="approve">
            Approve with edits
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * Reply response drill-in. recommendation is one of:
 *   · ConversationTurn — escalated for negotiation; no auto-reply, human review only.
 *   · reply draft { subject, body, deliverabilityScore? } — editable before send.
 * Zod safeParse distinguishes the shape.
 */
function renderReplyResponseApproval(approval: Approval, brandName: string | undefined): React.ReactElement {
  const asTurn = ConversationTurnSchema.safeParse(approval.recommendation);
  const asDraft = OutreachDraftSchema.pick({ subject: true, body: true }).extend({
    deliverabilityScore: z.number().min(0).max(1).optional(),
  }).safeParse(approval.recommendation);

  if (asTurn.success && !asDraft.success) {
    return renderReplyResponseEscalation(approval, brandName, asTurn.data);
  }
  if (asDraft.success) {
    return renderReplyResponseDraft(approval, brandName, asDraft.data);
  }

  return (
    <DrillError
      kind="reply_response"
      title={brandName ?? "Unnamed campaign"}
      detail="The attached data does not match the reply format."
      approval={approval}
    />
  );
}

function renderReplyResponseEscalation(
  approval: Approval,
  brandName: string | undefined,
  turn: ConversationTurn,
): React.ReactElement {
  const noSignals = Object.values(turn.extracted).every((v) => v === undefined);
  return (
    <div className="max-w-4xl mx-auto px-8 py-8">
      <DrillHeader
        kind="reply_response"
        title={`${brandName ?? "Unnamed campaign"} · human review needed`}
        approval={approval}
        right={
          <StatusTag tone={CLASSIFICATION_TONE[turn.classification]}>
            {CLASSIFICATION_LABEL[turn.classification]}
          </StatusTag>
        }
      />

      <RationaleCard title="Why the agent escalated this">
        {turn.needsHumanReason ?? approval.rationale}
      </RationaleCard>

      <Card className="mb-5">
        <CardBody>
          <SectionLabel className="mb-3">Extracted signals</SectionLabel>
          {noSignals ? (
            <div className="text-[12.5px] text-ink-3">No extracted signals — check the campaign timeline for the full message.</div>
          ) : (
            <dl className="text-[13.5px] space-y-3">
              {turn.extracted.proposedRateUsd !== undefined && (
                <div>
                  <dt className="text-[11px] text-ink-3">Proposed rate</dt>
                  <dd className="mono tnum text-ink">USD {fmtNum(turn.extracted.proposedRateUsd)}</dd>
                </div>
              )}
              {turn.extracted.question && (
                <div>
                  <dt className="text-[11px] text-ink-3">Question (original)</dt>
                  <dd className="mt-1 bg-surface-2 border border-line rounded-xl px-3.5 py-2.5 text-ink-2">
                    {turn.extracted.question}
                  </dd>
                </div>
              )}
              {turn.extracted.shippingAddress && (
                <div>
                  <dt className="text-[11px] text-ink-3">Shared shipping address</dt>
                  <dd className="mono text-ink-2">{turn.extracted.shippingAddress}</dd>
                </div>
              )}
            </dl>
          )}
          <p className="mt-4 text-[12px] text-ink-3 leading-relaxed">
            This step does not send an automatic reply. <strong className="text-ink-2">Reject</strong> ends progress with this creator,
            {" "}<strong className="text-ink-2">Mark reviewed</strong> records that human review is complete — send the actual reply separately.
          </p>
        </CardBody>
      </Card>

      <form action={resolveAction} className="flex justify-end gap-2.5">
        <input type="hidden" name="approvalId" value={approval.id} />
        <Button type="submit" name="decision" value="reject" variant="secondary" tone="reject">Reject and end progress</Button>
        <Button type="submit" name="decision" value="approveAll" variant="primary" tone="approve">
          Mark reviewed
        </Button>
      </form>
    </div>
  );
}

function renderReplyResponseDraft(
  approval: Approval,
  brandName: string | undefined,
  draft: { subject: string; body: string; deliverabilityScore?: number },
): React.ReactElement {
  const ds = draft.deliverabilityScore;
  const dsTone = ds === undefined ? "neutral" : ds >= 0.8 ? "ok" : ds >= 0.5 ? "warn" : "stop";
  return (
    <div className="max-w-4xl mx-auto px-8 py-8">
      <DrillHeader
        kind="reply_response"
        title={`${brandName ?? "Unnamed campaign"} · review auto reply`}
        approval={approval}
        right={
          ds !== undefined ? (
            <StatusTag tone={dsTone}>Deliverability {ds.toFixed(2)}</StatusTag>
          ) : undefined
        }
      />

      <RationaleCard title="Why the agent chose this draft">{approval.rationale}</RationaleCard>

      {ds !== undefined && (
        <Card className="mb-5">
          <CardBody>
            <SectionLabel className="mb-3">Deliverability self-check</SectionLabel>
            <ScoreBar label="Deliverability" value={ds} />
          </CardBody>
        </Card>
      )}

      <form action={resolveAction}>
        <input type="hidden" name="approvalId" value={approval.id} />

        <Card className="mb-5">
          <CardBody>
            <SectionLabel className="mb-2">Subject</SectionLabel>
            <input
              type="text"
              name="editedSubject"
              defaultValue={draft.subject}
              maxLength={120}
              className="w-full bg-surface border border-line rounded-xl px-3.5 py-2.5 text-[14px] text-ink outline-none"
            />
            <SectionLabel className="mt-4 mb-2">Body (HTML)</SectionLabel>
            <textarea
              name="editedBody"
              defaultValue={draft.body}
              rows={8}
              className="w-full bg-surface border border-line rounded-xl p-3.5 text-[12px] mono text-ink outline-none"
            />
          </CardBody>
        </Card>

        <Card className="mb-5">
          <CardBody>
            <SectionLabel className="mb-2">Preview (isolated render)</SectionLabel>
            <HtmlPreview html={draft.body} height={200} />
            <p className="mt-2.5 text-[11.5px] text-ink-3">
              Tracking pixels and unsubscribe copy are added automatically at send time.
            </p>
          </CardBody>
        </Card>

        <div className="flex justify-end gap-2.5">
          <Button type="submit" name="decision" value="reject" variant="secondary" tone="reject">Reject</Button>
          <Button type="submit" name="decision" value="approveEdited" variant="primary" tone="approve">
            Approve with edits and send
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * Shipment confirmation drill-in. recommendation = { rawAddress, brand, products[] }.
 * A human confirms the raw address + item details before the package ships.
 * Rejecting prevents shipment. Address editing is owned by the logistics agent.
 */
function renderShipmentApproval(approval: Approval, brandName: string | undefined): React.ReactElement {
  const rec = approval.recommendation as
    | { rawAddress?: unknown; brand?: unknown; products?: unknown }
    | undefined;
  const rawAddress = typeof rec?.rawAddress === "string" ? rec.rawAddress : "";
  const products = Array.isArray(rec?.products)
    ? (rec!.products as Array<{ sku?: unknown; name?: unknown; valueUsdCents?: unknown; weightGrams?: unknown }>).map((p) => ({
        sku: typeof p.sku === "string" ? p.sku : "?",
        name: typeof p.name === "string" ? p.name : "?",
        valueUsdCents: typeof p.valueUsdCents === "number" ? p.valueUsdCents : 0,
        weightGrams: typeof p.weightGrams === "number" ? p.weightGrams : 0,
      }))
    : [];
  const totalValueUsd = products.reduce((s, p) => s + p.valueUsdCents, 0) / 100;
  const totalWeight = products.reduce((s, p) => s + p.weightGrams, 0);

  return (
    <div className="max-w-3xl mx-auto px-8 py-8">
      <DrillHeader
        kind="shipment"
        title={`${brandName ?? "Unnamed campaign"} · confirm before sample shipment`}
        approval={approval}
        right={<StatusTag tone="warn">Awaiting shipment</StatusTag>}
      />

      <RationaleCard title="Why the agent sent this">{approval.rationale}</RationaleCard>

      <Card className="mb-5">
        <CardBody>
          <SectionLabel className="mb-2">Address shared by creator (raw)</SectionLabel>
          {rawAddress ? (
            <pre className="bg-surface-2 border border-line rounded-xl p-3.5 text-[13px] text-ink-2 whitespace-pre-wrap break-words font-sans">
              {rawAddress}
            </pre>
          ) : (
            <DiagnosticBanner tone="stop" title="No address data">
              Check the shipping-address collection step in the campaign timeline.
            </DiagnosticBanner>
          )}
          <p className="mt-2.5 text-[11.5px] text-ink-3 leading-relaxed">
            If approved, the logistics agent converts the text above into a structured address and sends it to the carrier. Rejecting ends progress and no package is shipped.
          </p>
        </CardBody>
      </Card>

      <Card className="mb-5">
        <CardBody>
          <SectionLabel className="mb-3">Shipment items ({products.length})</SectionLabel>
          {products.length === 0 ? (
            <div className="text-[12.5px] text-ink-3">No items.</div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 mb-4">
                <Stat label="Total declared value" value={`$${totalValueUsd.toFixed(2)}`} tone="brand" />
                <Stat label="Total weight" value={fmtNum(totalWeight)} unit="g" />
              </div>
              <table className="w-full text-[13px]">
                <thead className="text-[10px] uppercase tracking-[0.06em] text-ink-3 border-b border-line">
                  <tr>
                    <th className="text-left py-2.5 font-semibold">Item</th>
                    <th className="text-left py-2.5 font-semibold">Code</th>
                    <th className="text-right py-2.5 font-semibold">Declared value</th>
                    <th className="text-right py-2.5 font-semibold">Weight</th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((p, i) => (
                    <tr key={i} className="border-b border-line-2 last:border-0">
                      <td className="py-2.5 text-ink">{p.name}</td>
                      <td className="py-2.5 mono text-ink-3">{p.sku}</td>
                      <td className="py-2.5 text-right mono tnum text-ink-2">${(p.valueUsdCents / 100).toFixed(2)}</td>
                      <td className="py-2.5 text-right mono tnum text-ink-2">{fmtNum(p.weightGrams)} g</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <p className="mt-3 text-[11.5px] text-ink-3 leading-relaxed">
            Items, declared value, and weight come from campaign settings and cannot be edited here. If the shipment needs to change, reject it and update the campaign policy.
          </p>
        </CardBody>
      </Card>

      <form action={resolveAction} className="flex justify-end gap-2.5">
        <input type="hidden" name="approvalId" value={approval.id} />
        <Button type="submit" name="decision" value="reject" variant="secondary" tone="reject">Reject and do not ship</Button>
        <Button type="submit" name="decision" value="approveAll" variant="primary" tone="approve">
          Approve shipment
        </Button>
      </form>
    </div>
  );
}
