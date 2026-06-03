import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle, SectionLabel } from "@/components/ui/card";
import { StatusTag, type StatusTone } from "@/components/ui/status-tag";
import { Stat } from "@/components/ui/stat";
import { EmptyState } from "@/components/ui/empty-state";
import { getServerSession } from "@/lib/auth";
import { campaignRepo, reportRepo } from "@ss/db";
import { Events, type AnalyticsReport, type Report } from "@ss/contracts";
import { inngest } from "@ss/workflows";
import { fmtNum } from "@/lib/format";

/**
 * /campaigns/[id]/report — renders the most recent delivered report for a
 * campaign: summary + analytics tiles, the analyst's structured slots
 * (highlights / concerns / recommendations), the markdown narrative, and a
 * history list of past deliveries.
 *
 * "재생성" emits a report-deliver request; the page revalidates as the report
 * completes. The share link copies a public, token-gated URL.
 *
 * Presentation only — the server action + data fetching are preserved verbatim.
 */

// ── server action: manual "Generate report" trigger ─────────────────────────
async function generateReportAction(formData: FormData): Promise<void> {
  "use server";
  const session = await getServerSession();
  if (!session) throw new Error("not authenticated");
  const campaignId = formData.get("campaignId");
  if (typeof campaignId !== "string") throw new Error("missing campaignId");
  const campaign = await campaignRepo.get(campaignId);
  if (!campaign || campaign.brief.workspaceId !== session.workspaceId) {
    throw new Error("forbidden");
  }
  await inngest.send({
    name: Events.ReportDeliverRequest,
    data: { campaignId, trigger: "manual", notes: "" },
  });
  revalidatePath(`/campaigns/${campaignId}/report`);
}

// ── minimal markdown renderer (no external dep) ─────────────────────────────
function renderMarkdown(md: string): React.ReactElement {
  const lines = md.split("\n");
  const out: React.ReactElement[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("# ")) {
      out.push(<h1 key={key++} className="text-[20px] font-bold text-ink mt-6 mb-2">{line.slice(2)}</h1>);
      i++;
    } else if (line.startsWith("## ")) {
      out.push(<h2 key={key++} className="text-[15px] font-bold text-ink mt-4 mb-1.5">{line.slice(3)}</h2>);
      i++;
    } else if (line.startsWith("### ")) {
      out.push(<h3 key={key++} className="text-[13px] font-semibold text-ink-2 mt-3 mb-1">{line.slice(4)}</h3>);
      i++;
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      // collect contiguous list lines
      const items: string[] = [];
      while (i < lines.length && (lines[i]!.startsWith("- ") || lines[i]!.startsWith("* "))) {
        items.push(lines[i]!.replace(/^[*-] /, ""));
        i++;
      }
      out.push(
        <ul key={key++} className="list-disc pl-5 my-1.5 text-[13px] text-ink-2 space-y-0.5">
          {items.map((it, j) => <li key={j}>{it}</li>)}
        </ul>,
      );
    } else if (line.startsWith("| ")) {
      // markdown table (header | sep | rows)
      const tableLines: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("|")) {
        tableLines.push(lines[i]!);
        i++;
      }
      const rows = tableLines.filter((l) => !/^\|\s*-+/.test(l)).map((l) =>
        l.split("|").map((c) => c.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1),
      );
      const [header, ...body] = rows;
      if (header) {
        out.push(
          <table key={key++} className="mt-2 mb-3 w-full text-[12px] border-collapse">
            <thead>
              <tr className="text-[10px] uppercase tracking-[0.06em] text-ink-3 font-semibold bg-surface-2">
                {header.map((h, idx) => <th key={idx} className="text-left px-3 py-1.5 font-semibold">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri} className="border-t border-line-2">
                  {r.map((c, ci) => <td key={ci} className="px-3 py-1.5 mono tnum text-ink-2">{c}</td>)}
                </tr>
              ))}
            </tbody>
          </table>,
        );
      }
    } else if (line.trim() === "") {
      i++;
    } else {
      out.push(<p key={key++} className="text-[13px] text-ink-2 leading-relaxed my-1.5">{line}</p>);
      i++;
    }
  }
  return <div>{out}</div>;
}

// ── analytics tile strip ────────────────────────────────────────────────────
function AnalyticsTiles({ a }: { a: AnalyticsReport }) {
  const pct = a.goals.percentOfGoal !== null ? `목표 대비 ${Math.round(a.goals.percentOfGoal * 100)}%` : "목표 미설정";
  const hasReach = a.reach.verifiedViews > 0;
  const er = a.reach.weightedEngagementRate !== null
    ? `${(a.reach.weightedEngagementRate * 100).toFixed(1)}%`
    : "—";
  const budget = a.cost.percentOfBudget !== null
    ? `예산 대비 ${Math.round(a.cost.percentOfBudget * 100)}%`
    : "예산 미설정";
  const cppvp = a.cost.costPerVerifiedPost !== null
    ? `게시물당 $${a.cost.costPerVerifiedPost.toFixed(2)}`
    : "—";
  const deadlinePast = a.goals.daysToDeadline < 0;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 mb-6">
      <Stat
        label="목표 / 검증"
        value={a.goals.verifiedCount}
        unit={`/ ${a.goals.targetLivePosts}`}
        hint={pct}
        tone={a.goals.goalMet ? "ok" : "default"}
      />
      <Stat
        label="총 도달"
        value={hasReach ? fmtNum(a.reach.verifiedViews) : 0}
        hint={hasReach ? `참여율 ${er}` : "게시물 없음"}
        tone={hasReach ? "default" : "muted"}
      />
      <Stat
        label="집행 비용"
        value={`$${a.cost.spentUsd.toFixed(2)}`}
        hint={`${budget} · ${cppvp}`}
        tone="brand"
      />
      <Stat
        label="마감"
        value={a.goals.daysToDeadline >= 0 ? `+${a.goals.daysToDeadline}일` : `${a.goals.daysToDeadline}일`}
        hint={`${a.goals.daysToDeadline >= 0 ? "남음" : "경과"} · ${a.brief.deadline.toISOString().slice(0, 10)}`}
        tone={deadlinePast ? "stop" : "default"}
      />
    </div>
  );
}

/** ReportFlag → operator Korean label + status tone. */
const FLAG_KO: Record<string, { label: string; tone: StatusTone }> = {
  goal_met: { label: "목표 달성", tone: "ok" },
  budget_exceeded: { label: "예산 초과", tone: "stop" },
  deadline_missed: { label: "마감 미달", tone: "stop" },
  low_response_rate: { label: "낮은 응답률", tone: "warn" },
  high_flake_rate: { label: "높은 이탈률", tone: "warn" },
  no_verified_yet: { label: "검증 게시물 없음", tone: "warn" },
};
function flagKo(flag: string): { label: string; tone: StatusTone } {
  return FLAG_KO[flag] ?? { label: flag.replace(/_/g, " "), tone: "warn" };
}

function triggerLabel(t: Report["trigger"]): string {
  switch (t) {
    case "cron": return "자동 주간 집계";
    case "stage_transition": return "캠페인 종료 집계";
    case "manual": return "직접 생성";
  }
}

function fmtStamp(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ");
}

export default async function CampaignReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  const { id } = await params;
  const campaign = await campaignRepo.get(id);
  if (!campaign || campaign.brief.workspaceId !== session.workspaceId) notFound();

  const reports = await reportRepo.listByCampaign(id, 20);
  const latest: Report | null = reports[0] ?? null;
  const history = reports.slice(1); // older deliveries

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <header className="mb-6">
        <Link href={`/campaigns/${id}`} className="text-[12px] text-ink-3 hover:text-ink-2">
          ← {campaign.brief.brandProduct.name}
        </Link>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-bold tracking-[-0.01em]">결과 리포트</h1>
            {latest ? (
              <div className="mt-1 text-[12.5px] text-ink-3">
                {campaign.brief.brandProduct.name} · 생성 {fmtStamp(latest.generatedAt)} · {triggerLabel(latest.trigger)}
                {reports.length > 1 ? ` · ${reports.length}회 집계됨` : ""}
              </div>
            ) : (
              <div className="mt-1 text-[12.5px] text-ink-3">{campaign.brief.brandProduct.name}</div>
            )}
          </div>
          <form action={generateReportAction}>
            <input type="hidden" name="campaignId" value={id} />
            <Button variant="primary" tone="approve">{latest ? "새 리포트 생성" : "리포트 생성"}</Button>
          </form>
        </div>
      </header>

      {!latest ? (
        <EmptyState
          title="아직 리포트가 없습니다"
          hint="검증된 게시물이 모이면 자동으로 리포트가 만들어집니다. 지금 바로 생성하면 현 시점의 스냅샷을 받아볼 수 있어요."
          action={
            <form action={generateReportAction}>
              <input type="hidden" name="campaignId" value={id} />
              <Button variant="primary" tone="approve">리포트 생성</Button>
            </form>
          }
        />
      ) : (
        <>
          <AnalyticsTiles a={latest.analytics} />

          <Card>
            <CardBody>
              <SectionLabel className="mb-2">요약</SectionLabel>
              <p className="text-[14px] text-ink leading-relaxed">{latest.narrative.summary}</p>
              {latest.analytics.flags.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {latest.analytics.flags.map((f) => {
                    const fl = flagKo(f);
                    return <StatusTag key={f} tone={fl.tone} size="sm">{fl.label}</StatusTag>;
                  })}
                </div>
              )}
            </CardBody>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5 mt-4">
            {latest.narrative.highlights.length > 0 && (
              <Card>
                <CardBody>
                  <SectionLabel className="mb-2 text-ok">잘된 점</SectionLabel>
                  <ul className="list-disc pl-4 text-[13px] text-ink-2 space-y-1.5">
                    {latest.narrative.highlights.map((h, i) => <li key={i}>{h}</li>)}
                  </ul>
                </CardBody>
              </Card>
            )}
            {latest.narrative.concerns.length > 0 && (
              <Card>
                <CardBody>
                  <SectionLabel className="mb-2 text-warn">살펴볼 점</SectionLabel>
                  <ul className="list-disc pl-4 text-[13px] text-ink-2 space-y-1.5">
                    {latest.narrative.concerns.map((c, i) => <li key={i}>{c}</li>)}
                  </ul>
                </CardBody>
              </Card>
            )}
            <Card>
              <CardBody>
                <SectionLabel className="mb-2">다음 캠페인 제안</SectionLabel>
                <ul className="list-disc pl-4 text-[13px] text-ink-2 space-y-1.5">
                  {latest.narrative.recommendations.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </CardBody>
            </Card>
          </div>

          <Card className="mt-6">
            <CardHeader>
              <CardTitle>리포트 본문</CardTitle>
              {latest.shareToken && (
                <Link
                  href={`/share/${latest.id}?t=${encodeURIComponent(latest.shareToken)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-ink-3 hover:text-ink-2 underline-offset-2 hover:underline"
                >
                  공개 미리보기 열기 ↗
                </Link>
              )}
            </CardHeader>
            <CardBody>{renderMarkdown(latest.narrative.markdown)}</CardBody>
          </Card>

          {history.length > 0 && (
            <Card className="mt-6">
              <CardHeader><CardTitle>이전 리포트 · {history.length}개</CardTitle></CardHeader>
              <CardBody className="pt-1.5">
                <ul className="divide-y divide-line-2">
                  {history.map((r) => (
                    <li key={r.id} className="py-2.5 flex items-center justify-between gap-3 text-[13px]">
                      <div>
                        <span className="mono tnum text-ink">{fmtStamp(r.generatedAt)}</span>
                        <span className="ml-2 text-[11px] text-ink-3">{triggerLabel(r.trigger)}</span>
                      </div>
                      <div className="text-[11px] text-ink-3">
                        검증 {r.analytics.goals.verifiedCount} / {r.analytics.goals.targetLivePosts}
                        {r.analytics.flags.length > 0 ? ` · 플래그 ${r.analytics.flags.length}건` : ""}
                      </div>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
