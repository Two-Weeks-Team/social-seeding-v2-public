import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { getServerSession } from "@/lib/auth";
import { campaignRepo, reportRepo } from "@ss/db";
import { Events, type AnalyticsReport, type Report } from "@ss/contracts";
import { inngest } from "@ss/workflows";

/**
 * /campaigns/[id]/report — Phase 4 P4-C5a. Renders the most recent
 * delivered Report for a campaign:
 *
 *   · summary + analytics tile-strip (verified vs target, reach, cost)
 *   · highlights / concerns / recommendations (the analyst agent's
 *     structured slots)
 *   · markdown narrative (rendered minimally — H1/H2/H3 + lists +
 *     tables; no rich markdown dep)
 *   · history drawer with up to 20 past deliveries
 *
 * Form action "재생성" emits `report/deliver.request(trigger='manual')`.
 * The MC tile then updates within seconds as the report-deliver workflow
 * completes (revalidatePath bounces the user back to this page).
 *
 * "Share link" copies a public URL `/share/[reportId]?t=<shareToken>`
 * (P4-C5b renders it). Token check is constant-time on the share route.
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
      out.push(<h1 key={key++} className="text-[22px] font-semibold mt-6 mb-2">{line.slice(2)}</h1>);
      i++;
    } else if (line.startsWith("## ")) {
      out.push(<h2 key={key++} className="text-[15px] font-semibold mt-4 mb-1.5 text-slate-700">{line.slice(3)}</h2>);
      i++;
    } else if (line.startsWith("### ")) {
      out.push(<h3 key={key++} className="text-[13px] font-semibold mt-3 mb-1 text-slate-700">{line.slice(4)}</h3>);
      i++;
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      // collect contiguous list lines
      const items: string[] = [];
      while (i < lines.length && (lines[i]!.startsWith("- ") || lines[i]!.startsWith("* "))) {
        items.push(lines[i]!.replace(/^[*-] /, ""));
        i++;
      }
      out.push(
        <ul key={key++} className="list-disc pl-5 my-1.5 text-[13px] text-slate-700 space-y-0.5">
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
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-600">
              <tr>
                {header.map((h, idx) => <th key={idx} className="text-left px-2.5 py-1.5 font-medium">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri} className="border-t border-slate-100">
                  {r.map((c, ci) => <td key={ci} className="px-2.5 py-1.5 mono text-slate-700">{c}</td>)}
                </tr>
              ))}
            </tbody>
          </table>,
        );
      }
    } else if (line.trim() === "") {
      i++;
    } else {
      out.push(<p key={key++} className="text-[13px] text-slate-700 leading-relaxed my-1.5">{line}</p>);
      i++;
    }
  }
  return <div>{out}</div>;
}

// ── analytics tile strip ────────────────────────────────────────────────────
function AnalyticsTiles({ a }: { a: AnalyticsReport }) {
  const pct = a.goals.percentOfGoal !== null ? `${Math.round(a.goals.percentOfGoal * 100)}%` : "n/a";
  const reach = a.reach.verifiedViews.toLocaleString();
  const er = a.reach.weightedEngagementRate !== null
    ? `${(a.reach.weightedEngagementRate * 100).toFixed(1)}%`
    : "—";
  const cost = `$${a.cost.spentUsd.toFixed(2)}`;
  const budgetPct = a.cost.percentOfBudget !== null
    ? `${Math.round(a.cost.percentOfBudget * 100)}%`
    : "no budget";
  const cppvp = a.cost.costPerVerifiedPost !== null
    ? `$${a.cost.costPerVerifiedPost.toFixed(2)}/post`
    : "—";
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
      <Card><CardBody>
        <SectionLabel>VERIFIED · TARGET</SectionLabel>
        <div className="mt-1 text-[20px] font-semibold mono">
          {a.goals.verifiedCount}<span className="text-slate-400"> / {a.goals.targetLivePosts}</span>
        </div>
        <div className="mt-0.5 text-[11px] text-slate-500">{pct} of goal</div>
      </CardBody></Card>
      <Card><CardBody>
        <SectionLabel>REACH</SectionLabel>
        <div className="mt-1 text-[20px] font-semibold mono">{reach}</div>
        <div className="mt-0.5 text-[11px] text-slate-500">verified views · ER {er}</div>
      </CardBody></Card>
      <Card><CardBody>
        <SectionLabel>COST</SectionLabel>
        <div className="mt-1 text-[20px] font-semibold mono">{cost}</div>
        <div className="mt-0.5 text-[11px] text-slate-500">{budgetPct} of budget · {cppvp}</div>
      </CardBody></Card>
      <Card><CardBody>
        <SectionLabel>DEADLINE</SectionLabel>
        <div className={`mt-1 text-[20px] font-semibold mono ${a.goals.daysToDeadline < 0 ? "text-rose-700" : ""}`}>
          {a.goals.daysToDeadline >= 0 ? `+${a.goals.daysToDeadline}d` : `${a.goals.daysToDeadline}d`}
        </div>
        <div className="mt-0.5 text-[11px] text-slate-500">
          {a.goals.daysToDeadline >= 0 ? "remaining" : "past"} · {a.brief.deadline.toISOString().slice(0, 10)}
        </div>
      </CardBody></Card>
    </div>
  );
}

function flagBadgeVariant(flag: string): "amber" | "rose" | "emerald" {
  if (flag === "goal_met") return "emerald";
  if (flag === "budget_exceeded" || flag === "deadline_missed") return "rose";
  return "amber";
}

function triggerLabel(t: Report["trigger"]): string {
  switch (t) {
    case "cron": return "weekly cron";
    case "stage_transition": return "campaign closeout";
    case "manual": return "manual export";
  }
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
        <Link href={`/campaigns/${id}`} className="text-[11px] text-slate-500 hover:text-slate-900">
          ← {campaign.brief.brandProduct.name}
        </Link>
        <div className="mt-2 flex items-end justify-between gap-3">
          <div>
            <SectionLabel>REPORT</SectionLabel>
            <h1 className="mt-1 text-[22px] font-semibold">
              {campaign.brief.brandProduct.name} 결과 리포트
            </h1>
            {latest ? (
              <div className="mt-1 text-[12px] text-slate-500">
                생성됨 {latest.generatedAt.toISOString().slice(0, 16).replace("T", " ")} · trigger{" "}
                <span className="mono">{triggerLabel(latest.trigger)}</span>
                {reports.length > 1 ? ` · ${reports.length}회 전송됨` : ""}
              </div>
            ) : (
              <div className="mt-1 text-[12px] text-slate-500">아직 리포트가 없습니다.</div>
            )}
          </div>
          <form action={generateReportAction}>
            <input type="hidden" name="campaignId" value={id} />
            <Button variant="primary" tone="approve">{latest ? "🔄 새 리포트 생성" : "📝 리포트 생성"}</Button>
          </form>
        </div>
      </header>

      {!latest ? (
        <Card>
          <CardBody className="text-[13px] text-slate-500 text-center py-12">
            아직 검증된 게시물이 없거나 캠페인이 진행 중입니다. 직접 리포트를 생성하면 현 시점의 스냅샷을 만들 수 있습니다.
          </CardBody>
        </Card>
      ) : (
        <>
          <AnalyticsTiles a={latest.analytics} />

          <Card><CardBody>
            <SectionLabel className="mb-1.5">SUMMARY</SectionLabel>
            <p className="text-[14px] text-slate-800 leading-relaxed">{latest.narrative.summary}</p>
            {latest.analytics.flags.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {latest.analytics.flags.map((f) => (
                  <Badge key={f} variant={flagBadgeVariant(f)}>{f}</Badge>
                ))}
              </div>
            )}
          </CardBody></Card>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
            {latest.narrative.highlights.length > 0 && (
              <Card><CardBody>
                <SectionLabel className="mb-1.5 text-emerald-700">WHAT WORKED</SectionLabel>
                <ul className="list-disc pl-4 text-[13px] text-slate-700 space-y-1.5">
                  {latest.narrative.highlights.map((h, i) => <li key={i}>{h}</li>)}
                </ul>
              </CardBody></Card>
            )}
            {latest.narrative.concerns.length > 0 && (
              <Card><CardBody>
                <SectionLabel className="mb-1.5 text-amber-700">WHAT TO WATCH</SectionLabel>
                <ul className="list-disc pl-4 text-[13px] text-slate-700 space-y-1.5">
                  {latest.narrative.concerns.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
              </CardBody></Card>
            )}
            <Card><CardBody>
              <SectionLabel className="mb-1.5">NEXT CAMPAIGN</SectionLabel>
              <ul className="list-disc pl-4 text-[13px] text-slate-700 space-y-1.5">
                {latest.narrative.recommendations.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </CardBody></Card>
          </div>

          <Card className="mt-6"><CardBody>
            <div className="flex items-center justify-between mb-3">
              <SectionLabel>MARKDOWN</SectionLabel>
              {latest.shareToken && (
                <Link
                  href={`/share/${latest.id}?t=${encodeURIComponent(latest.shareToken)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-slate-500 hover:text-slate-900 underline-offset-2 hover:underline"
                >
                  공개 미리보기 열기 ↗
                </Link>
              )}
            </div>
            <div className="prose prose-sm max-w-none">{renderMarkdown(latest.narrative.markdown)}</div>
          </CardBody></Card>

          {history.length > 0 && (
            <Card className="mt-6"><CardBody>
              <SectionLabel className="mb-2">이전 리포트 · {history.length}개</SectionLabel>
              <ul className="text-[13px] divide-y divide-slate-100">
                {history.map((r) => (
                  <li key={r.id} className="py-2 flex items-center justify-between">
                    <div>
                      <span className="mono text-slate-700">
                        {r.generatedAt.toISOString().slice(0, 16).replace("T", " ")}
                      </span>
                      <span className="ml-2 text-[11px] text-slate-500 mono">
                        ({triggerLabel(r.trigger)})
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-500">
                      verified {r.analytics.goals.verifiedCount} / {r.analytics.goals.targetLivePosts}
                      {" · "}flags {r.analytics.flags.length}
                    </div>
                  </li>
                ))}
              </ul>
            </CardBody></Card>
          )}
        </>
      )}
    </div>
  );
}
