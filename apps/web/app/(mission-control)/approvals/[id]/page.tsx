import type React from "react";
import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
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

/**
 * Approval drill-in. Server component (form) + server action for resolve.
 * Branches by `approval.kind`:
 *   · shortlist        — candidate table with per-row keep/drop (Phase 1, W4).
 *   · outreach_send    — OutreachDraft preview + judge meters + editable
 *                        subject/body. (P2-C6a)
 *   · reply_response   — split shape: ConversationTurn (negotiating, no edit)
 *                        OR responder draft {subject, body, deliverabilityScore}
 *                        with editable subject/body. (P2-C6b)
 *   · shipment / stage_advance — placeholder until Phases 3-4.
 *
 * Decisions submitted to one of: approveAll · approveSelected (shortlist
 * subset) · approveEdited (outreach/reply with subject/body diff) · reject.
 * All paths call approvalRepo.resolve + inngest.send("approval/resolved")
 * which unblocks the workflow's gate.
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

function FitScoreMeter({ score }: { score: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, score)) * 100);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block w-14 h-1.5 bg-slate-200 rounded-full overflow-hidden">
        <span
          className="block h-full"
          style={{ width: `${pct}%`, background: `linear-gradient(90deg, #f59e0b, #10b981)` }}
        />
      </span>
      <span className="mono text-[12px] text-slate-700">{score.toFixed(2)}</span>
    </span>
  );
}

/**
 * Bar meter for 0-1 judge scores (or 0-10 spam scores normalized). Color
 * gradient flips: green=good (high) for judges, green=good (low) for spam.
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
  const pct = Math.round(Math.max(0, Math.min(max, value)) / max * 100);
  // invert=true (spam): low is good (left = green), high is bad (right = rose).
  // invert=false (judge): high is good (right = green), low is bad (left = amber).
  const gradient = invert
    ? "linear-gradient(90deg, #10b981, #f59e0b 50%, #f43f5e)"
    : "linear-gradient(90deg, #f59e0b, #10b981)";
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="w-28 text-slate-600">{label}</span>
      <span className="flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden">
        <span className="block h-full" style={{ width: `${pct}%`, background: gradient }} />
      </span>
      <span className="mono text-slate-700 w-12 text-right">
        {value.toFixed(max === 1 ? 2 : 1)}
        {max !== 1 && <span className="text-slate-400">/{max}</span>}
      </span>
    </div>
  );
}

/**
 * HTML body preview — renders inside a sandboxed iframe so the parent DOM is
 * isolated from anything in the agent-generated body (style leaks, embedded
 * <script>, etc.). srcdoc is the right tool here; we don't need a same-origin
 * frame for read-only preview. Sandbox = no scripts, no navigation, no forms.
 */
function HtmlPreview({ html, height = 260 }: { html: string; height?: number }) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font: 13px/1.5 ui-sans-serif, system-ui; color: #1e293b; padding: 12px; margin: 0; }
    p { margin: 0 0 8px; }
    a { color: #2563eb; }
  </style></head><body>${html}</body></html>`;
  return (
    <iframe
      title="email-preview"
      sandbox=""
      srcDoc={doc}
      className="w-full bg-white border border-slate-200 rounded-md"
      style={{ height }}
    />
  );
}

const ANGLE_LABEL: Record<string, string> = {
  free_tier_announcement: "free-tier",
  pain_killer: "pain killer",
  peer_proof: "peer proof",
  data_specific: "data-specific",
  contrarian_hook: "contrarian hook",
  aspirational: "aspirational",
};

export default async function ApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  const { id } = await params;
  const approval = await approvalRepo.get(id);
  if (!approval || approval.workspaceId !== session.workspaceId) notFound();
  const campaign = await campaignRepo.get(approval.campaignId);

  if (approval.kind === "outreach_send") {
    return renderOutreachSendApproval(approval, campaign?.brief.brandProduct.name);
  }
  if (approval.kind === "reply_response") {
    return renderReplyResponseApproval(approval, campaign?.brief.brandProduct.name);
  }
  if (approval.kind === "shipment") {
    return renderShipmentApproval(approval, campaign?.brief.brandProduct.name);
  }

  if (approval.kind !== "shortlist") {
    return (
      <div className="max-w-3xl mx-auto px-8 py-8">
        <Link href="/approvals" className="text-[11px] text-slate-500 hover:text-slate-900">← 승인 인박스</Link>
        <h1 className="mt-2 text-[18px] font-semibold">{approval.kind}</h1>
        <p className="mt-1 text-[13px] text-slate-500">이 종류의 승인 검토 화면은 Phase 2/3에서 추가됩니다.</p>
      </div>
    );
  }

  const candidates = Array.isArray(approval.recommendation) ? (approval.recommendation as Candidate[]) : [];

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <header className="mb-4">
        <Link href="/approvals" className="text-[11px] text-slate-500 hover:text-slate-900">← 승인 인박스</Link>
        <div className="mt-2 flex items-end justify-between flex-wrap gap-3">
          <div>
            <SectionLabel>SHORTLIST · approveShortlist</SectionLabel>
            <h1 className="mt-1 text-[22px] font-semibold">
              {campaign?.brief.brandProduct.name ?? "(unknown campaign)"} · {candidates.length}명 후보 검토
            </h1>
            <div className="mt-1 text-[12px] text-slate-500">
              대기 시작 {Math.floor((Date.now() - approval.createdAt.getTime()) / 60000)}분 전 · 캠페인{" "}
              <Link className="underline hover:text-slate-900 mono" href={`/campaigns/${approval.campaignId}`}>
                camp_{approval.campaignId.slice(0, 12)}
              </Link>
            </div>
          </div>
        </div>
      </header>

      <Card className="mb-5">
        <CardBody>
          <SectionLabel className="mb-2">에이전트가 추천한 이유</SectionLabel>
          <p className="text-[13px] text-slate-700 leading-relaxed">{approval.rationale}</p>
        </CardBody>
      </Card>

      <form action={resolveAction}>
        <input type="hidden" name="approvalId" value={approval.id} />

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-[13px]">
            <thead className="text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="w-10 px-3 py-2"></th>
                <th className="text-left px-3 py-2 font-medium">크리에이터</th>
                <th className="text-right px-3 py-2 font-medium">팔로워</th>
                <th className="text-left px-3 py-2 font-medium">fitScore</th>
                <th className="text-left px-3 py-2 font-medium">flags</th>
                <th className="text-left px-3 py-2 font-medium">매칭 사유</th>
              </tr>
            </thead>
            <tbody>
              {candidates.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">후보가 없습니다.</td></tr>
              )}
              {candidates.map((c) => (
                <tr key={c.creator.id} className="border-b border-slate-100 hover:bg-slate-50/60">
                  <td className="px-3 py-2.5">
                    <input type="checkbox" name="creatorId" value={c.creator.id} defaultChecked className="cursor-pointer" />
                  </td>
                  <td className="px-3 py-2.5 mono">{c.creator.uniqueId}</td>
                  <td className="px-3 py-2.5 text-right mono">{c.creator.followerCount.toLocaleString()}</td>
                  <td className="px-3 py-2.5">
                    <FitScoreMeter score={c.fitScore} />
                  </td>
                  <td className="px-3 py-2.5">
                    {c.flags.length === 0 ? (
                      <Badge variant="emerald">clean</Badge>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {c.flags.map((f) => (
                          <Badge
                            key={f}
                            variant={f === "blacklisted" || f === "brand_unsafe" ? "rose" : "amber"}
                          >
                            {f}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-slate-600 text-[12px]">{c.matchReasons[0] ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button type="submit" name="decision" value="reject" tone="reject">거부</Button>
          <Button type="submit" name="decision" value="approveSelected" variant="primary">선택한 행으로 승인</Button>
          <Button type="submit" name="decision" value="approveAll" variant="primary" tone="approve">전체 승인</Button>
        </div>
      </form>
    </div>
  );
}

/**
 * outreach_send drill-in. Shows the OutreachDraft the writer agent's
 * tournament produced: angle + spam meter + 4 judge bars + grounded facts +
 * editable subject/body. The body renders inside a sandboxed iframe so we
 * can show the styled email exactly as the creator will see it without
 * trusting the agent's HTML to be safe in the parent DOM.
 */
function renderOutreachSendApproval(approval: Approval, brandName: string | undefined): React.ReactElement {
  const parsed = OutreachDraftSchema.safeParse(approval.recommendation);
  if (!parsed.success) {
    return (
      <div className="max-w-3xl mx-auto px-8 py-8">
        <Link href="/approvals" className="text-[11px] text-slate-500 hover:text-slate-900">← 승인 인박스</Link>
        <h1 className="mt-2 text-[18px] font-semibold">outreach_send</h1>
        <p className="mt-1 text-[13px] text-rose-600">
          승인에 첨부된 draft가 OutreachDraft 형식이 아닙니다 (ID: {approval.id}). 워크플로 로그를 확인해주세요.
        </p>
      </div>
    );
  }
  const draft: OutreachDraft = parsed.data;
  const judge = draft.judgeScores ?? {};

  return (
    <div className="max-w-4xl mx-auto px-8 py-8">
      <header className="mb-4">
        <Link href="/approvals" className="text-[11px] text-slate-500 hover:text-slate-900">← 승인 인박스</Link>
        <div className="mt-2 flex items-end justify-between flex-wrap gap-3">
          <div>
            <SectionLabel>OUTREACH_SEND · approveOutreachSend</SectionLabel>
            <h1 className="mt-1 text-[22px] font-semibold">
              {brandName ?? "(unknown campaign)"} · 첫 outreach 검토
            </h1>
            <div className="mt-1 text-[12px] text-slate-500">
              대기 시작 {Math.floor((Date.now() - approval.createdAt.getTime()) / 60000)}분 전 · 캠페인{" "}
              <Link className="underline hover:text-slate-900 mono" href={`/campaigns/${approval.campaignId}`}>
                camp_{approval.campaignId.slice(0, 12)}
              </Link>
            </div>
          </div>
          <Badge variant={draft.spamScore <= 2 ? "emerald" : draft.spamScore <= 5 ? "amber" : "rose"}>
            angle: {ANGLE_LABEL[draft.angle] ?? draft.angle}
          </Badge>
        </div>
      </header>

      <Card className="mb-4">
        <CardBody>
          <SectionLabel className="mb-2">에이전트가 이 안을 고른 이유</SectionLabel>
          <p className="text-[13px] text-slate-700 leading-relaxed">{approval.rationale}</p>
        </CardBody>
      </Card>

      <div className="grid grid-cols-3 gap-4 mb-4">
        <Card className="col-span-2">
          <CardBody>
            <SectionLabel className="mb-2">judge 점수</SectionLabel>
            <div className="space-y-2">
              <ScoreBar label="brand" value={judge.brand ?? 0} />
              <ScoreBar label="conversion" value={judge.conversion ?? 0} />
              <ScoreBar label="deliverability" value={judge.deliverability ?? 0} />
              <ScoreBar label="skeptic" value={judge.skeptic ?? 0} />
              <div className="border-t border-slate-100 mt-2 pt-2">
                <ScoreBar label="spam score" value={draft.spamScore} max={10} invert />
              </div>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <SectionLabel className="mb-2">grounded facts ({draft.groundedFacts.length})</SectionLabel>
            {draft.groundedFacts.length === 0 ? (
              <div className="text-[12px] text-slate-500">(none)</div>
            ) : (
              <ul className="text-[12px] mono text-slate-700 space-y-1">
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

        <Card className="mb-4">
          <CardBody>
            <SectionLabel className="mb-2">subject</SectionLabel>
            <input
              type="text"
              name="editedSubject"
              defaultValue={draft.subject}
              maxLength={120}
              className="w-full border border-slate-200 rounded px-3 py-2 text-[14px]"
            />
            <SectionLabel className="mt-4 mb-2">body (HTML)</SectionLabel>
            <textarea
              name="editedBody"
              defaultValue={draft.body}
              rows={10}
              className="w-full border border-slate-200 rounded p-3 text-[12px] mono"
            />
          </CardBody>
        </Card>

        <Card className="mb-4">
          <CardBody>
            <SectionLabel className="mb-2">preview (sandboxed)</SectionLabel>
            <HtmlPreview html={draft.body} />
            <p className="mt-2 text-[11px] text-slate-500">
              실제 발송 시 gmail.send 가 tracking pixel + unsubscribe footer 를 자동 추가합니다 — preview에는 빠져 있습니다.
            </p>
          </CardBody>
        </Card>

        <div className="flex justify-end gap-2">
          <Button type="submit" name="decision" value="reject" tone="reject">거부</Button>
          <Button type="submit" name="decision" value="approveEdited" variant="primary" tone="approve">
            승인 (편집 반영)
          </Button>
        </div>
      </form>
    </div>
  );
}

const CLASSIFICATION_LABEL: Record<ConversationTurn["classification"], string> = {
  interested: "interested",
  needs_info: "needs_info",
  negotiating: "negotiating",
  not_now: "not_now",
  declined: "declined",
  out_of_office: "out_of_office",
  unsubscribe: "unsubscribe",
  unrelated: "unrelated",
};

const CLASSIFICATION_TONE: Record<ConversationTurn["classification"], "emerald" | "blue" | "amber" | "rose" | "slate"> = {
  interested: "emerald",
  needs_info: "blue",
  negotiating: "amber",
  not_now: "slate",
  declined: "rose",
  out_of_office: "slate",
  unsubscribe: "rose",
  unrelated: "slate",
};

/**
 * reply_response drill-in. The approval's `recommendation` can be either
 * shape depending on which workflow branch surfaced it:
 *   · ConversationTurn  — fired by creator-track's escalate-negotiating step
 *                         when the classifier returned 'negotiating'. No reply
 *                         was drafted; the human writes one in MC (or rejects
 *                         to close the track).
 *   · responder draft   — fired by the approveReplyResponse gate when the
 *                         responder agent produced { subject, body,
 *                         deliverabilityScore? }. Editable + sendable.
 *
 * We detect the shape via Zod safeParse; whichever parses successfully wins.
 * The "incoming" message body isn't on the approval directly — but the
 * workflow records it on the trace, and the rationale carries the gist. We
 * surface the extracted signals (question / proposedRateUsd / shippingAddress)
 * verbatim instead.
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
    <div className="max-w-3xl mx-auto px-8 py-8">
      <Link href="/approvals" className="text-[11px] text-slate-500 hover:text-slate-900">← 승인 인박스</Link>
      <h1 className="mt-2 text-[18px] font-semibold">reply_response</h1>
      <p className="mt-1 text-[13px] text-rose-600">
        승인에 첨부된 데이터가 ConversationTurn 도 responder draft 도 아닙니다 (ID: {approval.id}). 워크플로 로그를 확인해주세요.
      </p>
    </div>
  );
}

function renderReplyResponseEscalation(
  approval: Approval,
  brandName: string | undefined,
  turn: ConversationTurn,
): React.ReactElement {
  return (
    <div className="max-w-4xl mx-auto px-8 py-8">
      <header className="mb-4">
        <Link href="/approvals" className="text-[11px] text-slate-500 hover:text-slate-900">← 승인 인박스</Link>
        <div className="mt-2 flex items-end justify-between flex-wrap gap-3">
          <div>
            <SectionLabel>REPLY_RESPONSE · escalated</SectionLabel>
            <h1 className="mt-1 text-[22px] font-semibold">
              {brandName ?? "(unknown campaign)"} · 사람 검토 필요
            </h1>
            <div className="mt-1 text-[12px] text-slate-500">
              대기 시작 {Math.floor((Date.now() - approval.createdAt.getTime()) / 60000)}분 전 · 캠페인{" "}
              <Link className="underline hover:text-slate-900 mono" href={`/campaigns/${approval.campaignId}`}>
                camp_{approval.campaignId.slice(0, 12)}
              </Link>
            </div>
          </div>
          <Badge variant={CLASSIFICATION_TONE[turn.classification]}>
            classification: {CLASSIFICATION_LABEL[turn.classification]}
          </Badge>
        </div>
      </header>

      <Card className="mb-4">
        <CardBody>
          <SectionLabel className="mb-2">분류기가 escalate 한 이유</SectionLabel>
          <p className="text-[13px] text-slate-700 leading-relaxed">
            {turn.needsHumanReason ?? approval.rationale}
          </p>
        </CardBody>
      </Card>

      <Card className="mb-4">
        <CardBody>
          <SectionLabel className="mb-2">추출된 신호</SectionLabel>
          <dl className="text-[13px] space-y-2">
            {turn.extracted.proposedRateUsd !== undefined && (
              <div>
                <dt className="text-[11px] text-slate-500">제안된 단가</dt>
                <dd className="mono">USD {turn.extracted.proposedRateUsd.toLocaleString()}</dd>
              </div>
            )}
            {turn.extracted.question && (
              <div>
                <dt className="text-[11px] text-slate-500">질문 (verbatim)</dt>
                <dd className="bg-slate-50 border border-slate-200 rounded px-3 py-2">
                  {turn.extracted.question}
                </dd>
              </div>
            )}
            {turn.extracted.shippingAddress && (
              <div>
                <dt className="text-[11px] text-slate-500">공유된 배송지</dt>
                <dd className="mono">{turn.extracted.shippingAddress}</dd>
              </div>
            )}
            {Object.values(turn.extracted).every((v) => v === undefined) && (
              <div className="text-[12px] text-slate-500">(추출된 신호 없음 — body 전체를 트레이스에서 확인해주세요)</div>
            )}
          </dl>
        </CardBody>
      </Card>

      <Card className="mb-4">
        <CardBody>
          <SectionLabel className="mb-2">thread 정보</SectionLabel>
          <dl className="text-[12px] mono text-slate-600 space-y-1">
            <div>thread_id: {turn.threadId}</div>
            <div>creator_id: {turn.creatorId}</div>
            <div>incoming_message_id: {turn.incomingMessageId}</div>
          </dl>
          <p className="mt-3 text-[12px] text-slate-500">
            이 단계는 자동 응답이 없습니다. <strong>거부</strong>는 트랙을 종료하고, <strong>승인</strong>은 단순히 사람 검토 완료 표시입니다 — 실제 회신은 별도로 처리해주세요 (P2.5 follow-up: thread view 에서 수동 reply).
          </p>
        </CardBody>
      </Card>

      <form action={resolveAction} className="flex justify-end gap-2">
        <input type="hidden" name="approvalId" value={approval.id} />
        <Button type="submit" name="decision" value="reject" tone="reject">거부 (트랙 종료)</Button>
        <Button type="submit" name="decision" value="approveAll" variant="primary" tone="approve">
          확인 완료
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
  return (
    <div className="max-w-4xl mx-auto px-8 py-8">
      <header className="mb-4">
        <Link href="/approvals" className="text-[11px] text-slate-500 hover:text-slate-900">← 승인 인박스</Link>
        <div className="mt-2 flex items-end justify-between flex-wrap gap-3">
          <div>
            <SectionLabel>REPLY_RESPONSE · drafted reply</SectionLabel>
            <h1 className="mt-1 text-[22px] font-semibold">
              {brandName ?? "(unknown campaign)"} · 자동 회신 검토
            </h1>
            <div className="mt-1 text-[12px] text-slate-500">
              대기 시작 {Math.floor((Date.now() - approval.createdAt.getTime()) / 60000)}분 전 · 캠페인{" "}
              <Link className="underline hover:text-slate-900 mono" href={`/campaigns/${approval.campaignId}`}>
                camp_{approval.campaignId.slice(0, 12)}
              </Link>
            </div>
          </div>
          {draft.deliverabilityScore !== undefined && (
            <Badge variant={draft.deliverabilityScore >= 0.8 ? "emerald" : draft.deliverabilityScore >= 0.5 ? "amber" : "rose"}>
              deliverability {draft.deliverabilityScore.toFixed(2)}
            </Badge>
          )}
        </div>
      </header>

      <Card className="mb-4">
        <CardBody>
          <SectionLabel className="mb-2">에이전트가 이 안을 고른 이유</SectionLabel>
          <p className="text-[13px] text-slate-700 leading-relaxed">{approval.rationale}</p>
        </CardBody>
      </Card>

      {draft.deliverabilityScore !== undefined && (
        <Card className="mb-4">
          <CardBody>
            <SectionLabel className="mb-2">deliverability self-check</SectionLabel>
            <ScoreBar label="deliverability" value={draft.deliverabilityScore} />
          </CardBody>
        </Card>
      )}

      <form action={resolveAction}>
        <input type="hidden" name="approvalId" value={approval.id} />

        <Card className="mb-4">
          <CardBody>
            <SectionLabel className="mb-2">subject</SectionLabel>
            <input
              type="text"
              name="editedSubject"
              defaultValue={draft.subject}
              maxLength={120}
              className="w-full border border-slate-200 rounded px-3 py-2 text-[14px]"
            />
            <SectionLabel className="mt-4 mb-2">body (HTML)</SectionLabel>
            <textarea
              name="editedBody"
              defaultValue={draft.body}
              rows={8}
              className="w-full border border-slate-200 rounded p-3 text-[12px] mono"
            />
          </CardBody>
        </Card>

        <Card className="mb-4">
          <CardBody>
            <SectionLabel className="mb-2">preview (sandboxed)</SectionLabel>
            <HtmlPreview html={draft.body} height={200} />
            <p className="mt-2 text-[11px] text-slate-500">
              tracking pixel + unsubscribe footer 는 발송 시 gmail.send 가 추가합니다.
            </p>
          </CardBody>
        </Card>

        <div className="flex justify-end gap-2">
          <Button type="submit" name="decision" value="reject" tone="reject">거부</Button>
          <Button type="submit" name="decision" value="approveEdited" variant="primary" tone="approve">
            승인 (편집 반영 후 발송)
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * P3-C7a — shipment drill-in. The approveShipment gate's recommendation is
 * `{ rawAddress, brand, products[] }` (set by creator-track's shipping leg).
 * The human reviews the raw address text + the product manifest before the
 * workflow hands the package to the carrier (gate is PRE-shipment.create,
 * so a rejection here means no package physically ships).
 *
 * The drill-in deliberately doesn't allow editing the address — that's the
 * logistics agent's job (the agent parses raw text into structured fields,
 * which is hard to do correctly through a form). The reviewer's choice is
 * binary: approve (let the logistics agent run + the carrier get the
 * package) or reject (kill the track without shipping).
 */
function renderShipmentApproval(approval: Approval, brandName: string | undefined): React.ReactElement {
  const rec = approval.recommendation as
    | { rawAddress?: unknown; brand?: unknown; products?: unknown }
    | undefined;
  const rawAddress = typeof rec?.rawAddress === "string" ? rec.rawAddress : "";
  const brand = typeof rec?.brand === "string" ? rec.brand : brandName ?? "";
  const products = Array.isArray(rec?.products)
    ? (rec!.products as Array<{ sku?: unknown; name?: unknown; valueUsdCents?: unknown; weightGrams?: unknown }>).map((p) => ({
        sku: typeof p.sku === "string" ? p.sku : "?",
        name: typeof p.name === "string" ? p.name : "?",
        valueUsdCents: typeof p.valueUsdCents === "number" ? p.valueUsdCents : 0,
        weightGrams: typeof p.weightGrams === "number" ? p.weightGrams : 0,
      }))
    : [];

  return (
    <div className="max-w-3xl mx-auto px-8 py-8">
      <header className="mb-4">
        <Link href="/approvals" className="text-[11px] text-slate-500 hover:text-slate-900">← 승인 인박스</Link>
        <div className="mt-2 flex items-end justify-between flex-wrap gap-3">
          <div>
            <SectionLabel>SHIPMENT · approveShipment</SectionLabel>
            <h1 className="mt-1 text-[22px] font-semibold">
              {brandName ?? "(unknown campaign)"} · 샘플 발송 직전 검토
            </h1>
            <div className="mt-1 text-[12px] text-slate-500">
              대기 시작 {Math.floor((Date.now() - approval.createdAt.getTime()) / 60000)}분 전 · 캠페인{" "}
              <Link className="underline hover:text-slate-900 mono" href={`/campaigns/${approval.campaignId}`}>
                camp_{approval.campaignId.slice(0, 12)}
              </Link>
            </div>
          </div>
          <Badge variant="amber">PRE-SHIPMENT</Badge>
        </div>
      </header>

      <Card className="mb-4">
        <CardBody>
          <SectionLabel className="mb-2">에이전트가 보낸 사유</SectionLabel>
          <p className="text-[13px] text-slate-700 leading-relaxed">{approval.rationale}</p>
        </CardBody>
      </Card>

      <Card className="mb-4">
        <CardBody>
          <SectionLabel className="mb-2">크리에이터가 공유한 주소 (verbatim)</SectionLabel>
          {rawAddress ? (
            <pre className="bg-slate-50 border border-slate-200 rounded p-3 text-[13px] whitespace-pre-wrap break-words">
              {rawAddress}
            </pre>
          ) : (
            <div className="text-[12px] text-rose-600">주소 데이터가 없습니다 (워크플로 로그 확인 필요).</div>
          )}
          <p className="mt-2 text-[11px] text-slate-500">
            승인하시면 logistics 에이전트가 위 텍스트를 구조화된 주소로 파싱한 다음 carrier API 에 핸드오프합니다. 거부하시면 트랙은 종료되고 패키지는 발송되지 않습니다.
          </p>
        </CardBody>
      </Card>

      <Card className="mb-4">
        <CardBody>
          <SectionLabel className="mb-2">발송 품목 ({products.length})</SectionLabel>
          {products.length === 0 ? (
            <div className="text-[12px] text-slate-500">(품목 없음)</div>
          ) : (
            <table className="w-full text-[13px]">
              <thead className="text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="text-left py-2 font-medium">SKU</th>
                  <th className="text-left py-2 font-medium">이름</th>
                  <th className="text-right py-2 font-medium">신고가 (USD)</th>
                  <th className="text-right py-2 font-medium">중량 (g)</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    <td className="py-2 mono text-slate-700">{p.sku}</td>
                    <td className="py-2">{p.name}</td>
                    <td className="py-2 text-right mono">${(p.valueUsdCents / 100).toFixed(2)}</td>
                    <td className="py-2 text-right mono">{p.weightGrams.toLocaleString()} g</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-2 text-[11px] text-slate-500">
            품목 / 가격 / 중량은 캠페인 설정과 워크플로의 product manifest 에서 옵니다 — 이 화면에서 편집할 수 없습니다 (현장에서 다르게 보내야 하면 트랙 거부 → 캠페인 정책 수정).
          </p>
        </CardBody>
      </Card>

      <Card className="mb-4">
        <CardBody>
          <SectionLabel className="mb-2">브랜드 / 캠페인 식별</SectionLabel>
          <dl className="text-[12px] mono text-slate-600 space-y-1">
            <div>brand: {brand}</div>
            <div>approval_id: {approval.id}</div>
            <div>campaign_id: {approval.campaignId}</div>
          </dl>
        </CardBody>
      </Card>

      <form action={resolveAction} className="flex justify-end gap-2">
        <input type="hidden" name="approvalId" value={approval.id} />
        <Button type="submit" name="decision" value="reject" tone="reject">거부 (발송 안 함)</Button>
        <Button type="submit" name="decision" value="approveAll" variant="primary" tone="approve">
          발송 승인
        </Button>
      </form>
    </div>
  );
}
