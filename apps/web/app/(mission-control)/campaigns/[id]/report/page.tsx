import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle, SectionLabel } from "@/components/ui/card";
import { StatusTag, type StatusTone } from "@/components/ui/status-tag";
import { Stat } from "@/components/ui/stat";
import { EmptyState } from "@/components/ui/empty-state";
import { demoReadonlyGuard, getServerSession } from "@/lib/auth";
import { campaignRepo, reportRepo } from "@ss/db";
import { Events, AnalyticsReportSchema, type AnalyticsReport, type Report, type ReportNarrative } from "@ss/contracts";
import { inngest } from "@ss/workflows";
import { invokeCapability } from "@ss/capabilities";
import { fmtNum } from "@/lib/format";

/**
 * /campaigns/[id]/report — renders the most recent delivered report for a
 * campaign: summary + analytics tiles, the analyst's structured slots
 * (highlights / concerns / recommendations), the markdown narrative, and a
 * history list of past deliveries.
 *
 * "Regenerate" emits a report-deliver request; the page revalidates as the report
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
  demoReadonlyGuard(session, `/campaigns/${campaignId}/report`);
  const campaign = await campaignRepo.get(campaignId);
  if (!campaign || campaign.brief.workspaceId !== session.workspaceId) {
    throw new Error("forbidden");
  }
  // Production: emit the request; the report-deliver workflow (analyst agent on
  // Vertex) writes the report. Locally there is no Inngest engine + no LLM, so the
  // request never completes. When REPORT_LOCAL_FALLBACK is set we build the report
  // synchronously from real analytics.compile + a deterministic, numbers-based
  // narrative (no LLM; analystCostUsd=0 + note marks it) so the operator still
  // gets a report. The Vertex analyst enriches the narrative on the live stack.
  if (process.env.REPORT_LOCAL_FALLBACK === "true") {
    const raw = await invokeCapability(
      "analytics.compile",
      { campaignId },
      { workspaceId: session.workspaceId, userId: session.userId, rateLimitClass: "default" },
    );
    const analytics = AnalyticsReportSchema.parse(raw);
    await reportRepo.create({
      campaignId,
      workspaceId: session.workspaceId,
      trigger: "manual",
      analytics,
      narrative: buildDeterministicNarrative(analytics),
      shareToken: "",
      analystCostUsd: 0,
      notes: "Automatic aggregate summary (no LLM)",
      generatedAt: new Date(),
    });
    revalidatePath(`/campaigns/${campaignId}/report`);
    return;
  }

  await inngest.send({
    name: Events.ReportDeliverRequest,
    data: { campaignId, trigger: "manual", notes: "" },
  });
  revalidatePath(`/campaigns/${campaignId}/report`);
}

/**
 * Deterministic report narrative — built from the analytics rollup, no LLM. Used
 * for the local fallback (and a sane structure mirroring the analyst agent's
 * ReportNarrative slots: summary / highlights / concerns / recommendations / md).
 */
function buildDeterministicNarrative(a: AnalyticsReport): ReportNarrative {
  const pct = a.goals.percentOfGoal !== null ? Math.round(a.goals.percentOfGoal * 100) : null;
  const er = a.reach.weightedEngagementRate !== null ? (a.reach.weightedEngagementRate * 100).toFixed(1) : null;
  const views = a.reach.verifiedViews;
  const engagement = a.reach.verifiedLikes + a.reach.verifiedComments + a.reach.verifiedShares;
  const top = [...(a.tracks ?? [])]
    .filter((t) => t.performanceScore !== null)
    .sort((x, y) => (y.views ?? 0) - (x.views ?? 0))[0];

  const summary =
    a.goals.verifiedCount > 0
      ? `${a.brief.name} recorded ${a.goals.verifiedCount} verified posts${pct !== null ? ` (${pct}% of goal)` : ""}, ${fmtNum(views)} total verified views${er ? `, and ${er}% average engagement` : ""}.`
      : `${a.brief.name} has no verified posts and did not meet the goal. Low response during outreach is the likely primary cause.`;

  const highlights: string[] = [];
  if (a.goals.goalMet) highlights.push(`Met the ${a.goals.targetLivePosts}-post goal with ${a.goals.verifiedCount} verified posts.`);
  if (views > 0) highlights.push(`${fmtNum(views)} total verified views and ${fmtNum(engagement)} total engagements.`);
  if (er) highlights.push(`${er}% average engagement rate.`);
  if (top) highlights.push(`Top-performing post reached ${fmtNum(top.views ?? 0)} views.`);

  const concerns: string[] = [];
  if (a.goals.verifiedCount === 0) concerns.push("No verified posts yet.");
  if (a.flags.includes("low_response_rate")) concerns.push("Response rate is low.");
  if (a.flags.includes("high_flake_rate")) concerns.push("Post drop-off is high.");
  if (a.flags.includes("budget_exceeded")) concerns.push("Budget was exceeded.");
  if (a.flags.includes("deadline_missed")) concerns.push("Deadline was missed.");

  const recommendations: string[] = [];
  if (a.goals.verifiedCount === 0) recommendations.push("Lower the target engagement threshold and re-source from a broader candidate pool.");
  else if (a.goals.goalMet) recommendations.push("Consider follow-up collaborations with the strongest creators.");
  else recommendations.push("Extend the reply window or send additional outreach.");
  if (recommendations.length === 0) recommendations.push("Maintain the current trend and reassess at the next rollup.");

  const markdown = [
    `# ${a.brief.name} Performance Report`,
    "",
    "## Summary",
    summary,
    "",
    "## Key Metrics",
    `- Verified posts: ${a.goals.verifiedCount} / ${a.goals.targetLivePosts}${pct !== null ? ` (${pct}%)` : ""}`,
    `- Total reach: ${fmtNum(views)} views`,
    `- Average engagement: ${er ?? "—"}${er ? "%" : ""}`,
    `- Spend: $${a.cost.spentUsd.toFixed(2)}`,
    "",
    "## Recommendations",
    ...recommendations.map((r) => `- ${r}`),
  ].join("\n");

  return {
    summary: summary.slice(0, 590),
    highlights: highlights.slice(0, 4),
    concerns: concerns.slice(0, 4),
    recommendations: recommendations.slice(0, 3),
    markdown: markdown.slice(0, 7900),
  };
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
  const pct = a.goals.percentOfGoal !== null ? `${Math.round(a.goals.percentOfGoal * 100)}% of goal` : "No goal set";
  const hasReach = a.reach.verifiedViews > 0;
  const er = a.reach.weightedEngagementRate !== null
    ? `${(a.reach.weightedEngagementRate * 100).toFixed(1)}%`
    : "—";
  const budget = a.cost.percentOfBudget !== null
    ? `${Math.round(a.cost.percentOfBudget * 100)}% of budget`
    : "No budget set";
  const cppvp = a.cost.costPerVerifiedPost !== null
    ? `$${a.cost.costPerVerifiedPost.toFixed(2)} per post`
    : "—";
  const deadlinePast = a.goals.daysToDeadline < 0;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 mb-6">
      <Stat
        label="Goal / verified"
        value={a.goals.verifiedCount}
        unit={`/ ${a.goals.targetLivePosts}`}
        hint={pct}
        tone={a.goals.goalMet ? "ok" : "default"}
      />
      <Stat
        label="Total reach"
        value={hasReach ? fmtNum(a.reach.verifiedViews) : 0}
        hint={hasReach ? `Engagement ${er}` : "No posts"}
        tone={hasReach ? "default" : "muted"}
      />
      <Stat
        label="Spend"
        value={`$${a.cost.spentUsd.toFixed(2)}`}
        hint={`${budget} · ${cppvp}`}
        tone="brand"
      />
      <Stat
        label="Deadline"
        value={a.goals.daysToDeadline >= 0 ? `+${a.goals.daysToDeadline}d` : `${a.goals.daysToDeadline}d`}
        hint={`${a.goals.daysToDeadline >= 0 ? "remaining" : "elapsed"} · ${a.brief.deadline.toISOString().slice(0, 10)}`}
        tone={deadlinePast ? "stop" : "default"}
      />
    </div>
  );
}

/** ReportFlag → operator English label + status tone. */
const FLAG_KO: Record<string, { label: string; tone: StatusTone }> = {
  goal_met: { label: "Goal met", tone: "ok" },
  budget_exceeded: { label: "Budget exceeded", tone: "stop" },
  deadline_missed: { label: "Deadline missed", tone: "stop" },
  low_response_rate: { label: "Low response rate", tone: "warn" },
  high_flake_rate: { label: "High drop-off", tone: "warn" },
  no_verified_yet: { label: "No verified posts", tone: "warn" },
};
function flagKo(flag: string): { label: string; tone: StatusTone } {
  return FLAG_KO[flag] ?? { label: flag.replace(/_/g, " "), tone: "warn" };
}

function triggerLabel(t: Report["trigger"]): string {
  switch (t) {
    case "cron": return "Automatic weekly rollup";
    case "stage_transition": return "Campaign-close rollup";
    case "manual": return "Manual";
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
            <h1 className="text-[24px] font-bold tracking-[-0.01em]">Results report</h1>
            {latest ? (
              <div className="mt-1 text-[12.5px] text-ink-3">
                {campaign.brief.brandProduct.name} · generated {fmtStamp(latest.generatedAt)} · {triggerLabel(latest.trigger)}
                {reports.length > 1 ? ` · ${reports.length} rollups` : ""}
              </div>
            ) : (
              <div className="mt-1 text-[12.5px] text-ink-3">{campaign.brief.brandProduct.name}</div>
            )}
          </div>
          <form action={generateReportAction}>
            <input type="hidden" name="campaignId" value={id} />
            <Button variant="primary" tone="approve">{latest ? "Generate new report" : "Generate report"}</Button>
          </form>
        </div>
      </header>

      {!latest ? (
        <EmptyState
          title="No report yet"
          hint="Reports are created automatically when verified posts arrive. Generate one now to capture the current snapshot."
          action={
            <form action={generateReportAction}>
              <input type="hidden" name="campaignId" value={id} />
              <Button variant="primary" tone="approve">Generate report</Button>
            </form>
          }
        />
      ) : (
        <>
          <AnalyticsTiles a={latest.analytics} />

          <Card>
            <CardBody>
              <SectionLabel className="mb-2">Summary</SectionLabel>
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
                  <SectionLabel className="mb-2 text-ok">What worked</SectionLabel>
                  <ul className="list-disc pl-4 text-[13px] text-ink-2 space-y-1.5">
                    {latest.narrative.highlights.map((h, i) => <li key={i}>{h}</li>)}
                  </ul>
                </CardBody>
              </Card>
            )}
            {latest.narrative.concerns.length > 0 && (
              <Card>
                <CardBody>
                  <SectionLabel className="mb-2 text-warn">Watchouts</SectionLabel>
                  <ul className="list-disc pl-4 text-[13px] text-ink-2 space-y-1.5">
                    {latest.narrative.concerns.map((c, i) => <li key={i}>{c}</li>)}
                  </ul>
                </CardBody>
              </Card>
            )}
            <Card>
              <CardBody>
                <SectionLabel className="mb-2">Next-campaign suggestions</SectionLabel>
                <ul className="list-disc pl-4 text-[13px] text-ink-2 space-y-1.5">
                  {latest.narrative.recommendations.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </CardBody>
            </Card>
          </div>

          <Card className="mt-6">
            <CardHeader>
              <CardTitle>Report body</CardTitle>
              {latest.shareToken && (
                <Link
                  href={`/share/${latest.id}?t=${encodeURIComponent(latest.shareToken)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-ink-3 hover:text-ink-2 underline-offset-2 hover:underline"
                >
                  Open public preview ↗
                </Link>
              )}
            </CardHeader>
            <CardBody>{renderMarkdown(latest.narrative.markdown)}</CardBody>
          </Card>

          {history.length > 0 && (
            <Card className="mt-6">
              <CardHeader><CardTitle>Previous reports · {history.length}</CardTitle></CardHeader>
              <CardBody className="pt-1.5">
                <ul className="divide-y divide-line-2">
                  {history.map((r) => (
                    <li key={r.id} className="py-2.5 flex items-center justify-between gap-3 text-[13px]">
                      <div>
                        <span className="mono tnum text-ink">{fmtStamp(r.generatedAt)}</span>
                        <span className="ml-2 text-[11px] text-ink-3">{triggerLabel(r.trigger)}</span>
                      </div>
                      <div className="text-[11px] text-ink-3">
                        verified {r.analytics.goals.verifiedCount} / {r.analytics.goals.targetLivePosts}
                        {r.analytics.flags.length > 0 ? ` · ${r.analytics.flags.length} flags` : ""}
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
