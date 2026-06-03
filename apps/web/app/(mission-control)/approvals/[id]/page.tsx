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
 * 승인 드릴인 (C2). 서버 컴포넌트(폼) + resolve 서버 액션.
 * `approval.kind` 별로 분기:
 *   · 후보 리스트   — 행별 유지/제외 체크가 있는 후보 테이블.
 *   · 아웃리치 발송 — 초안 미리보기 + 평가 점수 + 편집 가능한 제목/본문.
 *   · 회신 응답     — 협의 에스컬레이션(편집 없음) 또는 자동 회신 초안(편집 가능).
 *   · 배송 확인     — 주소 + 품목 확인.
 *   · 결제 승인     — AP2 결제 위임 드릴인(_ap2).
 *
 * 모든 경로는 approvalRepo.resolve + 워크플로 게이트를 푸는 이벤트로 끝납니다.
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

/** 적합도 바 — 0~1 점수. 낮음(주의색)→높음(달성색) 그라데이션 없이 단색 바. */
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
 * 0~1(또는 0~max) 점수 바. invert=true(스팸)는 낮을수록 좋음(주의→미달),
 * invert=false(평가)는 높을수록 좋음.
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
  // invert (스팸): 낮음=양호. 그 외(평가): 높음=양호.
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
 * HTML 본문 미리보기 — 샌드박스 iframe 안에서 렌더해 부모 DOM을 에이전트 생성
 * HTML(스타일 누수, 임베드 <script> 등)로부터 격리합니다. srcdoc + sandbox(""):
 * 스크립트/네비게이션/폼 모두 차단된 읽기 전용 미리보기.
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

/** 평가 항목 한글 라벨. */
const JUDGE_LABEL: Record<string, string> = {
  brand: "브랜드 적합",
  conversion: "전환력",
  deliverability: "도달성",
  skeptic: "신뢰도",
};

/** 아웃리치 각도(angle) 한글 라벨. */
const ANGLE_LABEL: Record<string, string> = {
  free_tier_announcement: "무료 제공 안내",
  pain_killer: "문제 해결 제안",
  peer_proof: "동료 사례",
  data_specific: "데이터 기반",
  contrarian_hook: "역발상 훅",
  aspirational: "비전 제안",
};

/** 후보 플래그 한글 라벨 + 색 톤. */
const FLAG_LABEL: Record<string, { label: string; tone: "warn" | "stop" }> = {
  below_engagement_floor: { label: "참여율 미달", tone: "warn" },
  blacklisted: { label: "블랙리스트", tone: "stop" },
  wrong_language: { label: "언어 불일치", tone: "warn" },
  brand_unsafe: { label: "브랜드 부적합", tone: "stop" },
  prior_flake: { label: "과거 이탈 이력", tone: "warn" },
  data_stale: { label: "데이터 오래됨", tone: "warn" },
};

/** 회신 분류 한글 라벨 + StatusTag 톤. */
const CLASSIFICATION_LABEL: Record<ConversationTurn["classification"], string> = {
  interested: "관심 있음",
  needs_info: "정보 요청",
  negotiating: "협의 중",
  not_now: "지금은 아님",
  declined: "거절",
  out_of_office: "부재중",
  unsubscribe: "수신 거부",
  unrelated: "무관",
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

/** 드릴인 공통 헤더 — 뒤로가기 + 종류 라벨 + 제목 + 대기 시간 + 캠페인 링크. */
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
      <Link href="/approvals" className="text-[12px] text-ink-3 hover:text-ink-2">← 승인 인박스</Link>
      <div className="mt-2 flex items-end justify-between flex-wrap gap-3">
        <div>
          <SectionLabel>{approvalKindKo(kind)}</SectionLabel>
          <h1 className="mt-1 text-[24px] font-bold tracking-[-0.01em]">{title}</h1>
          <div className="mt-1 text-[12.5px] text-ink-3">
            {fmtAgo(approval.createdAt)} 대기 시작 ·{" "}
            <Link className="text-ink-2 hover:text-ink underline underline-offset-2" href={`/campaigns/${approval.campaignId}`}>
              캠페인으로 이동
            </Link>
          </div>
        </div>
        {right}
      </div>
    </header>
  );
}

/** 추천 사유 카드 — 모든 드릴인에서 재사용. */
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

/** 형식 불일치 등 검토 불가 상황 — 초록 위장 없이 정직한 진단 배너. */
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
      <DiagnosticBanner tone="stop" title="이 항목은 지금 검토할 수 없습니다">
        {detail} 워크플로 기록을 확인한 뒤 다시 시도해주세요.
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
  // AP2 결제 위임 — 5번째 종류. recommendation은 render 시점에 Zod로 검증됩니다.
  if (approval.kind === "payment_mandate") {
    return renderPaymentMandateApproval(approval, brandName);
  }

  if (approval.kind !== "shortlist") {
    return (
      <div className="max-w-3xl mx-auto px-8 py-8">
        <DrillHeader kind={approval.kind} title={brandName ?? "이름 미상 캠페인"} approval={approval} />
        <Card flat>
          <CardBody>
            <p className="text-[13.5px] text-ink-2">이 종류의 검토 화면은 곧 추가됩니다.</p>
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
        title={`${brandName ?? "이름 미상 캠페인"} · 후보 ${candidates.length}명 검토`}
        approval={approval}
      />

      <RationaleCard title="에이전트가 추천한 이유">{approval.rationale}</RationaleCard>

      <form action={resolveAction}>
        <input type="hidden" name="approvalId" value={approval.id} />

        <Card className="overflow-hidden">
          <table className="w-full text-[13px]">
            <thead className="text-[10px] uppercase tracking-[0.06em] text-ink-3 border-b border-line bg-surface-2">
              <tr>
                <th className="w-10 px-4 py-3"></th>
                <th className="text-left px-4 py-3 font-semibold">크리에이터</th>
                <th className="text-right px-4 py-3 font-semibold">팔로워</th>
                <th className="text-left px-4 py-3 font-semibold">적합도</th>
                <th className="text-left px-4 py-3 font-semibold">주의 사항</th>
                <th className="text-left px-4 py-3 font-semibold">매칭 사유</th>
              </tr>
            </thead>
            <tbody>
              {candidates.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-ink-3">후보가 없습니다.</td></tr>
              )}
              {candidates.map((c) => {
                const handle = creatorHandle({ uniqueId: c.creator.uniqueId });
                return (
                  <tr key={c.creator.id} className="border-b border-line-2 last:border-0 hover:bg-surface-2/60">
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
                        <StatusTag tone="ok" size="sm">문제 없음</StatusTag>
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
          <Button type="submit" name="decision" value="reject" variant="secondary" tone="reject">거부</Button>
          <Button type="submit" name="decision" value="approveSelected" variant="secondary">선택한 후보만 승인</Button>
          <Button type="submit" name="decision" value="approveAll" variant="primary" tone="approve">전체 승인</Button>
        </div>
      </form>
    </div>
  );
}

/**
 * 아웃리치 발송 드릴인. 작성 에이전트 토너먼트가 만든 초안을 보여줍니다:
 * 각도 + 스팸 점수 + 평가 4종 바 + 인용 가능한 근거 + 편집 가능한 제목/본문.
 * 본문은 샌드박스 iframe으로 안전하게 미리보기합니다.
 */
function renderOutreachSendApproval(approval: Approval, brandName: string | undefined): React.ReactElement {
  const parsed = OutreachDraftSchema.safeParse(approval.recommendation);
  if (!parsed.success) {
    return (
      <DrillError
        kind="outreach_send"
        title={brandName ?? "이름 미상 캠페인"}
        detail="첨부된 초안이 아웃리치 형식과 맞지 않습니다."
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
        title={`${brandName ?? "이름 미상 캠페인"} · 첫 아웃리치 검토`}
        approval={approval}
        right={
          <StatusTag tone={spamTone}>접근 각도 · {ANGLE_LABEL[draft.angle] ?? draft.angle}</StatusTag>
        }
      />

      <RationaleCard title="에이전트가 이 안을 고른 이유">{approval.rationale}</RationaleCard>

      <div className="grid grid-cols-3 gap-5 mb-5">
        <Card className="col-span-2">
          <CardBody>
            <SectionLabel className="mb-3">평가 점수</SectionLabel>
            <div className="space-y-2.5">
              <ScoreBar label={JUDGE_LABEL.brand!} value={judge.brand ?? 0} />
              <ScoreBar label={JUDGE_LABEL.conversion!} value={judge.conversion ?? 0} />
              <ScoreBar label={JUDGE_LABEL.deliverability!} value={judge.deliverability ?? 0} />
              <ScoreBar label={JUDGE_LABEL.skeptic!} value={judge.skeptic ?? 0} />
              <div className="border-t border-line-2 mt-3 pt-3">
                <ScoreBar label="스팸 위험도" value={draft.spamScore} max={10} invert />
              </div>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <SectionLabel className="mb-2">인용 근거 ({draft.groundedFacts.length})</SectionLabel>
            {draft.groundedFacts.length === 0 ? (
              <div className="text-[12.5px] text-ink-3">근거 없음</div>
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
            <SectionLabel className="mb-2">제목</SectionLabel>
            <input
              type="text"
              name="editedSubject"
              defaultValue={draft.subject}
              maxLength={120}
              className="w-full bg-surface border border-line rounded-xl px-3.5 py-2.5 text-[14px] text-ink outline-none"
            />
            <SectionLabel className="mt-4 mb-2">본문 (HTML)</SectionLabel>
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
            <SectionLabel className="mb-2">미리보기 (격리 렌더)</SectionLabel>
            <HtmlPreview html={draft.body} />
            <p className="mt-2.5 text-[11.5px] text-ink-3">
              실제 발송 시 추적 픽셀과 수신거부 안내가 자동으로 덧붙습니다 — 미리보기에는 빠져 있습니다.
            </p>
          </CardBody>
        </Card>

        <div className="flex justify-end gap-2.5">
          <Button type="submit" name="decision" value="reject" variant="secondary" tone="reject">거부</Button>
          <Button type="submit" name="decision" value="approveEdited" variant="primary" tone="approve">
            승인 (편집 반영)
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * 회신 응답 드릴인. recommendation 형태가 둘 중 하나:
 *   · ConversationTurn — 협의 분류로 에스컬레이션됨. 자동 회신 없음, 사람이 검토만.
 *   · 회신 초안 { subject, body, deliverabilityScore? } — 편집 후 발송 가능.
 * Zod safeParse로 형태를 판별합니다.
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
      title={brandName ?? "이름 미상 캠페인"}
      detail="첨부된 데이터가 회신 형식과 맞지 않습니다."
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
        title={`${brandName ?? "이름 미상 캠페인"} · 사람 검토 필요`}
        approval={approval}
        right={
          <StatusTag tone={CLASSIFICATION_TONE[turn.classification]}>
            {CLASSIFICATION_LABEL[turn.classification]}
          </StatusTag>
        }
      />

      <RationaleCard title="에이전트가 사람에게 넘긴 이유">
        {turn.needsHumanReason ?? approval.rationale}
      </RationaleCard>

      <Card className="mb-5">
        <CardBody>
          <SectionLabel className="mb-3">추출된 신호</SectionLabel>
          {noSignals ? (
            <div className="text-[12.5px] text-ink-3">추출된 신호가 없습니다 — 전체 내용은 캠페인 타임라인에서 확인해주세요.</div>
          ) : (
            <dl className="text-[13.5px] space-y-3">
              {turn.extracted.proposedRateUsd !== undefined && (
                <div>
                  <dt className="text-[11px] text-ink-3">제안된 단가</dt>
                  <dd className="mono tnum text-ink">USD {fmtNum(turn.extracted.proposedRateUsd)}</dd>
                </div>
              )}
              {turn.extracted.question && (
                <div>
                  <dt className="text-[11px] text-ink-3">질문 (원문)</dt>
                  <dd className="mt-1 bg-surface-2 border border-line rounded-xl px-3.5 py-2.5 text-ink-2">
                    {turn.extracted.question}
                  </dd>
                </div>
              )}
              {turn.extracted.shippingAddress && (
                <div>
                  <dt className="text-[11px] text-ink-3">공유된 배송지</dt>
                  <dd className="mono text-ink-2">{turn.extracted.shippingAddress}</dd>
                </div>
              )}
            </dl>
          )}
          <p className="mt-4 text-[12px] text-ink-3 leading-relaxed">
            이 단계는 자동 회신이 없습니다. <strong className="text-ink-2">거부</strong>는 이 크리에이터와의 진행을 종료하고,
            {" "}<strong className="text-ink-2">확인 완료</strong>는 사람 검토를 마쳤다는 표시입니다 — 실제 회신은 따로 보내주세요.
          </p>
        </CardBody>
      </Card>

      <form action={resolveAction} className="flex justify-end gap-2.5">
        <input type="hidden" name="approvalId" value={approval.id} />
        <Button type="submit" name="decision" value="reject" variant="secondary" tone="reject">거부 (진행 종료)</Button>
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
  const ds = draft.deliverabilityScore;
  const dsTone = ds === undefined ? "neutral" : ds >= 0.8 ? "ok" : ds >= 0.5 ? "warn" : "stop";
  return (
    <div className="max-w-4xl mx-auto px-8 py-8">
      <DrillHeader
        kind="reply_response"
        title={`${brandName ?? "이름 미상 캠페인"} · 자동 회신 검토`}
        approval={approval}
        right={
          ds !== undefined ? (
            <StatusTag tone={dsTone}>도달성 {ds.toFixed(2)}</StatusTag>
          ) : undefined
        }
      />

      <RationaleCard title="에이전트가 이 안을 고른 이유">{approval.rationale}</RationaleCard>

      {ds !== undefined && (
        <Card className="mb-5">
          <CardBody>
            <SectionLabel className="mb-3">도달성 자가 점검</SectionLabel>
            <ScoreBar label="도달성" value={ds} />
          </CardBody>
        </Card>
      )}

      <form action={resolveAction}>
        <input type="hidden" name="approvalId" value={approval.id} />

        <Card className="mb-5">
          <CardBody>
            <SectionLabel className="mb-2">제목</SectionLabel>
            <input
              type="text"
              name="editedSubject"
              defaultValue={draft.subject}
              maxLength={120}
              className="w-full bg-surface border border-line rounded-xl px-3.5 py-2.5 text-[14px] text-ink outline-none"
            />
            <SectionLabel className="mt-4 mb-2">본문 (HTML)</SectionLabel>
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
            <SectionLabel className="mb-2">미리보기 (격리 렌더)</SectionLabel>
            <HtmlPreview html={draft.body} height={200} />
            <p className="mt-2.5 text-[11.5px] text-ink-3">
              추적 픽셀과 수신거부 안내는 발송 시 자동으로 덧붙습니다.
            </p>
          </CardBody>
        </Card>

        <div className="flex justify-end gap-2.5">
          <Button type="submit" name="decision" value="reject" variant="secondary" tone="reject">거부</Button>
          <Button type="submit" name="decision" value="approveEdited" variant="primary" tone="approve">
            승인 (편집 반영 후 발송)
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * 배송 확인 드릴인. recommendation = { rawAddress, brand, products[] }.
 * 사람이 원문 주소 + 품목 명세를 확인한 뒤 패키지가 배송됩니다(게이트는 배송 직전).
 * 거부하면 패키지는 실제로 발송되지 않습니다. 주소 편집은 불가(물류 에이전트 담당).
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
        title={`${brandName ?? "이름 미상 캠페인"} · 샘플 발송 직전 확인`}
        approval={approval}
        right={<StatusTag tone="warn">발송 대기</StatusTag>}
      />

      <RationaleCard title="에이전트가 보낸 사유">{approval.rationale}</RationaleCard>

      <Card className="mb-5">
        <CardBody>
          <SectionLabel className="mb-2">크리에이터가 공유한 주소 (원문)</SectionLabel>
          {rawAddress ? (
            <pre className="bg-surface-2 border border-line rounded-xl p-3.5 text-[13px] text-ink-2 whitespace-pre-wrap break-words font-sans">
              {rawAddress}
            </pre>
          ) : (
            <DiagnosticBanner tone="stop" title="주소 데이터가 없습니다">
              캠페인 타임라인에서 배송지 수집 단계를 확인해주세요.
            </DiagnosticBanner>
          )}
          <p className="mt-2.5 text-[11.5px] text-ink-3 leading-relaxed">
            승인하시면 물류 에이전트가 위 텍스트를 정형화된 주소로 변환해 배송사에 전달합니다. 거부하시면 진행이 종료되고 패키지는 발송되지 않습니다.
          </p>
        </CardBody>
      </Card>

      <Card className="mb-5">
        <CardBody>
          <SectionLabel className="mb-3">발송 품목 ({products.length})</SectionLabel>
          {products.length === 0 ? (
            <div className="text-[12.5px] text-ink-3">품목이 없습니다.</div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 mb-4">
                <Stat label="신고가 합계" value={`$${totalValueUsd.toFixed(2)}`} tone="brand" />
                <Stat label="중량 합계" value={fmtNum(totalWeight)} unit="g" />
              </div>
              <table className="w-full text-[13px]">
                <thead className="text-[10px] uppercase tracking-[0.06em] text-ink-3 border-b border-line">
                  <tr>
                    <th className="text-left py-2.5 font-semibold">품목</th>
                    <th className="text-left py-2.5 font-semibold">코드</th>
                    <th className="text-right py-2.5 font-semibold">신고가</th>
                    <th className="text-right py-2.5 font-semibold">중량</th>
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
            품목 · 신고가 · 중량은 캠페인 설정에서 옵니다 — 이 화면에서는 편집할 수 없습니다. 다르게 보내야 한다면 거부 후 캠페인 정책을 수정해주세요.
          </p>
        </CardBody>
      </Card>

      <form action={resolveAction} className="flex justify-end gap-2.5">
        <input type="hidden" name="approvalId" value={approval.id} />
        <Button type="submit" name="decision" value="reject" variant="secondary" tone="reject">거부 (발송 안 함)</Button>
        <Button type="submit" name="decision" value="approveAll" variant="primary" tone="approve">
          발송 승인
        </Button>
      </form>
    </div>
  );
}
