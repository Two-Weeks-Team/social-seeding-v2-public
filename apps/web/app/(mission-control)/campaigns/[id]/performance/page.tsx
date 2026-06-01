import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { getServerSession } from "@/lib/auth";
import { campaignRepo } from "@ss/db";
import { invokeCapability } from "@ss/capabilities";
import { AnalyticsReportSchema, type AnalyticsReport } from "@ss/contracts";

/**
 * /campaigns/[id]/performance — the live performance surface (goal brief
 * P4-(a)). Unlike /report (which renders a *delivered* Report + analyst
 * narrative), this compiles analytics.compile on demand and foregrounds the
 * "performance analysis auto-completed" story: the funnel, reach, the verified
 * -post leaderboard, and the before/after vs a human-stalled analysis.
 *
 * Reads live data for the campaign in the operator's workspace — this is the
 * authed product surface, so creator handles are shown (the PUBLIC report is
 * aggregates-only; that's the standalone HTML).
 */

const FUNNEL_ROWS: Array<{ key: keyof AnalyticsReport["funnel"]; label: string }> = [
  { key: "outreach_sent", label: "아웃리치 발송" },
  { key: "in_conversation", label: "대화 중" },
  { key: "shipped", label: "샘플 발송" },
  { key: "delivered", label: "수령" },
  { key: "posted", label: "게시" },
  { key: "verified", label: "검증 완료" },
];

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <Card>
      <CardBody>
        <SectionLabel>{label}</SectionLabel>
        <div className={`mt-1 text-[24px] font-semibold mono ${accent ? "text-emerald-600" : ""}`}>{value}</div>
        {sub && <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>}
      </CardBody>
    </Card>
  );
}

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

  const er = a.reach.weightedEngagementRate !== null ? `${(a.reach.weightedEngagementRate * 100).toFixed(2)}%` : "—";
  const funnelMax = Math.max(1, ...FUNNEL_ROWS.map((r) => a.funnel[r.key]));
  const leaderboard = [...(a.tracks ?? [])]
    .filter((t) => t.performanceScore !== null)
    .sort((x, y) => (y.performanceScore ?? 0) - (x.performanceScore ?? 0))
    .slice(0, 12);

  return (
    <div className="max-w-5xl mx-auto px-8 py-8">
      <header className="mb-5">
        <div className="flex items-center gap-2 text-[12px] text-slate-500">
          <Link href={`/campaigns/${id}`} className="hover:text-slate-700">← {a.brief.name}</Link>
          <span>·</span><span>{a.brief.category}</span>
        </div>
        <h1 className="mt-1 text-[22px] font-semibold">성과 분석</h1>
      </header>

      {/* auto-completed banner — the core story */}
      <div className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-4">
        <div className="flex items-center gap-2">
          <Badge variant="emerald">자동 완료</Badge>
          <span className="text-[13px] font-medium text-emerald-900">
            성과분석 단계를 에이전트가 자율 완료했습니다.
          </span>
        </div>
        <div className="mt-1.5 text-[12px] text-emerald-800/80">
          원본 워크플로우는 <code className="mono">performanceAnalysis</code>에서 멈춰 reach·engagement가 0(미집계)이었습니다.
          v2는 검증 게시물 {a.goals.verifiedCount}건을 집계해 아래 지표를 산출했습니다.
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Kpi label="VERIFIED · TARGET" value={`${a.goals.verifiedCount} / ${a.goals.targetLivePosts}`}
          sub={a.goals.percentOfGoal !== null ? `${Math.round(a.goals.percentOfGoal * 100)}% of goal` : undefined}
          accent={a.goals.goalMet} />
        <Kpi label="REACH (VIEWS)" value={a.reach.verifiedViews.toLocaleString()} sub={`ER ${er}`} />
        <Kpi label="ENGAGEMENT" value={(a.reach.verifiedLikes + a.reach.verifiedComments + a.reach.verifiedShares).toLocaleString()}
          sub={`♥ ${a.reach.verifiedLikes.toLocaleString()} · 💬 ${a.reach.verifiedComments} · ↗ ${a.reach.verifiedShares}`} />
        <Kpi label="PERFORMANCE SCORE" value={a.performance.avgPerformanceScore !== null ? String(a.performance.avgPerformanceScore) : "—"}
          sub={a.performance.medianPerformanceScore !== null ? `median ${a.performance.medianPerformanceScore}` : undefined} />
      </div>

      {a.flags.length > 0 && (
        <div className="mb-6 flex flex-wrap gap-2">
          {a.flags.map((f) => (
            <Badge key={f} variant={f === "goal_met" ? "emerald" : f === "budget_exceeded" || f === "deadline_missed" ? "rose" : "amber"}>
              {f}
            </Badge>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardBody>
            <SectionLabel className="mb-3">퍼널</SectionLabel>
            <div className="space-y-2">
              {FUNNEL_ROWS.map((r) => {
                const v = a.funnel[r.key];
                return (
                  <div key={r.key} className="grid grid-cols-[110px_1fr_36px] items-center gap-2">
                    <div className="text-[12px] text-slate-500 text-right">{r.label}</div>
                    <div className="h-5 rounded bg-slate-100 overflow-hidden">
                      <div className="h-full rounded bg-gradient-to-r from-violet-500 to-cyan-400"
                        style={{ width: `${8 + (v / funnelMax) * 92}%` }} />
                    </div>
                    <div className="text-[12px] font-semibold mono text-right">{v}</div>
                  </div>
                );
              })}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <SectionLabel className="mb-3">게시물 리더보드 · 상위 {leaderboard.length}</SectionLabel>
            <div className="space-y-1.5">
              {leaderboard.map((t, i) => (
                <div key={t.creatorId} className="grid grid-cols-[20px_1fr_64px_44px] items-center gap-2">
                  <div className="text-[11px] text-slate-400 mono">{i + 1}</div>
                  <div className="text-[12px] text-slate-700 truncate">{t.creatorId}</div>
                  <div className="text-[11px] text-slate-500 mono text-right">{(t.views ?? 0).toLocaleString()}</div>
                  <div className="text-[12px] font-semibold mono text-right text-violet-600">{t.performanceScore}</div>
                </div>
              ))}
              {leaderboard.length === 0 && <div className="text-[12px] text-slate-500">검증된 게시물이 아직 없습니다.</div>}
            </div>
          </CardBody>
        </Card>
      </div>

      <div className="mt-4 text-[11px] text-slate-400">
        compiled {a.generatedAt.toISOString().slice(0, 16).replace("T", " ")} · analytics.compile (no LLM) · spent ${a.cost.spentUsd.toFixed(2)}
      </div>
    </div>
  );
}
