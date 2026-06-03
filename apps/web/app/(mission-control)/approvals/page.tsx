import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { StatusTag } from "@/components/ui/status-tag";
import { EmptyState } from "@/components/ui/empty-state";
import { getServerSession } from "@/lib/auth";
import { approvalRepo, campaignRepo } from "@ss/db";
import { type Approval } from "@ss/contracts";
import { approvalKindKo } from "@/lib/labels";
import { fmtAgo } from "@/lib/format";

/**
 * 승인 인박스 (C2). 워크스페이스 전체의 대기 중인 결정을 종류별로 묶어 보여줍니다.
 * 후보 리스트는 클릭하면 후보 테이블 드릴인이 열립니다.
 * 대기 항목이 0건이면 종류별 빈 박스를 늘어놓는 대신, 한 개의 차분한 EmptyState만 띄웁니다.
 */

// 종류별 헤더 노출 순서 (대기 항목이 있는 종류만 카드로 렌더).
const KIND_ORDER: Approval["kind"][] = [
  "shortlist",
  "outreach_send",
  "reply_response",
  "shipment",
  "content_review",
  "budget",
  "payment_mandate",
  "stage_advance",
];

// 드릴인 검토 화면이 준비된 종류 — "검토" 버튼을 노출합니다.
const REVIEWABLE_KINDS = new Set<Approval["kind"]>([
  "shortlist",
  "outreach_send",
  "reply_response",
  "shipment",
  "content_review",
  "budget",
  "payment_mandate",
]);

/** outreach_send 추천(OutreachDraft)에서 제목만 best-effort 추출. */
function outreachSubject(rec: unknown): string | null {
  if (rec && typeof rec === "object" && !Array.isArray(rec) && "subject" in rec) {
    const s = (rec as { subject: unknown }).subject;
    return typeof s === "string" ? s : null;
  }
  return null;
}

export default async function ApprovalsPage() {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");

  const pending = await approvalRepo.listPendingByWorkspace(session.workspaceId);
  // 화면 표시용 캠페인(브랜드) 이름 매핑.
  const campaigns = await campaignRepo.listByWorkspace(session.workspaceId);
  const byCampaign = new Map(campaigns.map((c) => [c.id, c.brief.brandProduct.name]));

  const grouped = new Map<Approval["kind"], Approval[]>();
  for (const a of pending) grouped.set(a.kind, [...(grouped.get(a.kind) ?? []), a]);

  // 실제로 대기 항목이 있는 종류만, 정해진 순서대로.
  const activeKinds = KIND_ORDER.filter((k) => (grouped.get(k)?.length ?? 0) > 0);

  return (
    <div className="max-w-4xl mx-auto px-8 py-8">
      <header className="mb-6 flex items-start justify-between gap-5">
        <div>
          <h1 className="text-[24px] font-bold tracking-[-0.01em]">승인 인박스</h1>
          <p className="mt-1 text-[13.5px] text-ink-2">
            에이전트가 추천을 미리 채워뒀습니다. 한 종류씩 확인하고 결정만 내려주세요.
          </p>
        </div>
        {pending.length > 0 && (
          <StatusTag tone="warn">{pending.length}건 대기</StatusTag>
        )}
      </header>

      {pending.length === 0 ? (
        <EmptyState
          icon="✓"
          title="0건 대기 · 다 처리했어요"
          hint="새로운 결정이 필요해지면 에이전트가 추천과 함께 여기에 올려둡니다."
          action={<Link href="/campaigns"><Button variant="primary">캠페인 보기</Button></Link>}
        />
      ) : (
        <div className="space-y-6">
          {activeKinds.map((kind) => {
            const rows = grouped.get(kind) ?? [];
            return (
              <section key={kind}>
                <SectionLabel className="mb-2.5">
                  {approvalKindKo(kind)} · {rows.length}건
                </SectionLabel>
                <div className="space-y-2.5">
                  {rows.map((a) => {
                    const subject = kind === "outreach_send" ? outreachSubject(a.recommendation) : null;
                    const candidateCount =
                      kind === "shortlist" && Array.isArray(a.recommendation)
                        ? a.recommendation.length
                        : null;
                    return (
                      <Card key={a.id} hover>
                        <CardBody>
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                              <div className="text-[15px] font-bold text-ink">
                                {byCampaign.get(a.campaignId) ?? "이름 미상 캠페인"}
                                {candidateCount != null && (
                                  <span className="ml-2 text-[13px] font-medium text-ink-2">
                                    후보 {candidateCount}명
                                  </span>
                                )}
                              </div>
                              {subject && (
                                <div className="mt-1 text-[13px] text-ink-2 truncate">
                                  “{subject.slice(0, 70)}”
                                </div>
                              )}
                              {a.rationale && (
                                <p className="mt-1 text-[12.5px] text-ink-3 leading-relaxed line-clamp-2">
                                  {a.rationale}
                                </p>
                              )}
                            </div>
                            <div className="flex flex-col items-end gap-2 shrink-0">
                              <div className="text-[12px] text-ink-3 mono">{fmtAgo(a.createdAt)}</div>
                              {REVIEWABLE_KINDS.has(kind) && (
                                <Link href={`/approvals/${a.id}`}>
                                  <Button variant="primary" size="sm">검토 →</Button>
                                </Link>
                              )}
                            </div>
                          </div>
                        </CardBody>
                      </Card>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
