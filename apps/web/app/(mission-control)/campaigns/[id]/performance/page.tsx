import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { Funnel, type FunnelRow } from "@/components/ui/funnel";
import { StatusTag } from "@/components/ui/status-tag";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DiagnosticBanner } from "@/components/ui/diagnostic";
import { getServerSession } from "@/lib/auth";
import { campaignRepo } from "@ss/db";
import { invokeCapability } from "@ss/capabilities";
import { AnalyticsReportSchema, type AnalyticsReport } from "@ss/contracts";
import { fmtNum, fmtCompactKo, creatorLabel } from "@/lib/format";

/**
 * /campaigns/[id]/performance — C2 redesign. The audit's headline data-honesty
 * fixes live here: a zero-result campaign is NOT dressed in green success — it
 * shows an honest diagnostic + recovery actions; the funnel renders 0 as empty;
 * "—" (not computable) is visually distinct from a real 0; internal v1/v2
 * narration is replaced with operator language.
 */

const FUNNEL_DEF: Array<{ key: keyof AnalyticsReport["funnel"]; label: string }> = [
  { key: "outreach_sent", label: "아웃리치 발송" },
  { key: "in_conversation", label: "대화 중" },
  { key: "shipped", label: "샘플 발송" },
  { key: "delivered", label: "수령" },
  { key: "posted", label: "게시" },
  { key: "verified", label: "검증 완료" },
];

export default async function PerformancePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  const { id } = await params;

  const campaign = await campaignRepo.get(id);
  if (!campaign || campaign.brief.workspaceId !== session.workspaceId) notFound();

  const raw = await invokeCapability(
    "analytics.compile",
    { campaignId: id },
    { workspaceId: session.workspaceId, userId: session.userId, rateLimitClass: "default" },
  );
  const a: AnalyticsReport = AnalyticsReportSchema.parse(raw);

  const verified = a.goals.verifiedCount;
  const goalMet = a.goals.goalMet;
  const zeroResult = verified === 0;
  const er = a.reach.weightedEngagementRate !== null ? `${(a.reach.weightedEngagementRate * 100).toFixed(1)}` : null;
  const engagement = a.reach.verifiedLikes + a.reach.verifiedComments + a.reach.verifiedShares;
  const reach = fmtCompactKo(a.reach.verifiedViews);

  const header = zeroResult
    ? { tone: "stop" as const, label: "성과 미달 · 검증 게시물 없음" }
    : goalMet
      ? { tone: "ok" as const, label: "목표 달성" }
      : { tone: "warn" as const, label: "부분 달성" };

  const funnelRows: FunnelRow[] = FUNNEL_DEF.map((r) => ({ label: r.label, value: a.funnel[r.key] }));

  const leaderboard = [...(a.tracks ?? [])]
    .filter((t) => t.performanceScore !== null)
    .sort((x, y) => (y.performanceScore ?? 0) - (x.performanceScore ?? 0))
    .slice(0, 12);

  return (
    <div className="max-w-5xl mx-auto px-8 py-8">
      <header className="mb-5">
        <Link href={`/campaigns/${id}`} className="text-[12px] text-ink-3 hover:text-ink-2">← {a.brief.name}</Link>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-bold tracking-[-0.01em]">성과 분석</h1>
            <div className="mt-1 text-[12.5px] text-ink-3">{a.brief.category}</div>
          </div>
          <StatusTag tone={header.tone}>{header.label}</StatusTag>
        </div>
      </header>

      {/* Honest diagnostic for zero-result; calm note otherwise */}
      {zeroResult ? (
        <DiagnosticBanner
          tone="stop"
          title={`크리에이터 ${campaign.tracks.length || a.goals.targetLivePosts}명 중 0명이 게시까지 도달하지 못해 목표를 달성하지 못했습니다.`}
          actions={
            <>
              <Link href="/campaigns/new"><Button variant="primary" size="sm">더 넓은 조건으로 새 캠페인</Button></Link>
              <Link href="/policies"><Button size="sm">응답 정책 조정</Button></Link>
              <Link href="/settings"><Button size="sm">Gmail 연결 확인</Button></Link>
            </>
          }
          className="mb-6"
        >
          아웃리치는 발송됐지만 검증된 게시물이 없습니다. 타겟 참여율(ER ≥ {(campaign.brief.targeting.minEngagementRate * 100).toFixed(1)}%) 기준이 높아 후보 풀이 좁았던 것이 가장 가능성 있는 원인입니다. 아래에서 바로 다시 시도할 수 있어요.
        </DiagnosticBanner>
      ) : (
        <div className="mb-6 rounded-2xl border border-ok/25 bg-ok-bg px-5 py-3.5 text-[13px] text-ink-2">
          성과 분석을 에이전트가 자율 완료했습니다. 검증 게시물 {verified}건을 집계해 아래 지표를 산출했습니다.
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 mb-6">
        <Stat
          label="목표 / 게시"
          value={verified}
          unit={`/ ${a.goals.targetLivePosts}`}
          hint={a.goals.percentOfGoal !== null ? `목표 대비 ${Math.round(a.goals.percentOfGoal * 100)}%` : "목표 미설정"}
          tone={zeroResult ? "stop" : goalMet ? "ok" : "default"}
        />
        <Stat
          label="총 도달"
          value={a.reach.verifiedViews > 0 ? reach.value : 0}
          unit={a.reach.verifiedViews > 0 ? reach.unit : undefined}
          hint={a.reach.verifiedViews > 0 ? `조회수 합계 ${fmtNum(a.reach.verifiedViews)}` : "게시물 없음"}
        />
        <Stat
          label="평균 참여율"
          value={er ?? "—"}
          unit={er ? "%" : undefined}
          hint={`♥ ${fmtNum(a.reach.verifiedLikes)} · 💬 ${fmtNum(a.reach.verifiedComments)} · ↗ ${fmtNum(a.reach.verifiedShares)}`}
          tone={er ? "default" : "muted"}
        />
        <Stat
          label="성과 점수"
          value={a.performance.avgPerformanceScore !== null ? a.performance.avgPerformanceScore : "—"}
          hint={a.performance.avgPerformanceScore !== null ? `참여 합계 ${fmtNum(engagement)}` : "측정할 데이터 없음"}
          tone={a.performance.avgPerformanceScore !== null ? "brand" : "muted"}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>퍼널 — 단계별 전환</CardTitle>
            <span className="text-[11px] text-ink-3 mono">0 = 빈 막대</span>
          </CardHeader>
          <CardBody><Funnel rows={funnelRows} /></CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>게시물 리더보드</CardTitle></CardHeader>
          <CardBody className="pt-1.5">
            {leaderboard.length === 0 ? (
              <div className="text-[12.5px] text-ink-3 py-4">검증된 게시물이 아직 없습니다.</div>
            ) : (
              <div className="space-y-0.5">
                {leaderboard.map((t, i) => {
                  const label = creatorLabel(t.creatorId);
                  return (
                    <div key={t.creatorId} className="flex items-center gap-3 py-2 border-b border-line-2 last:border-0">
                      <span className="w-5 text-[12px] text-ink-3 mono shrink-0">{i + 1}</span>
                      <Avatar name={label} size="sm" />
                      <span className="text-[13px] text-ink truncate">{label}</span>
                      <span className="ml-auto text-[13px] mono font-bold text-ink">{fmtNum(t.views ?? 0)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="mt-4 text-[11px] text-ink-3">
        집계 {a.generatedAt.toISOString().slice(0, 16).replace("T", " ")} · 집행 ${a.cost.spentUsd.toFixed(2)}
      </div>
    </div>
  );
}
