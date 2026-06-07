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
import { resolveCreators } from "@/lib/creators";

/**
 * /campaigns/[id]/performance — C2 redesign. The audit's headline data-honesty
 * fixes live here: a zero-result campaign is NOT dressed in green success — it
 * shows an honest diagnostic + recovery actions; the funnel renders 0 as empty;
 * "—" (not computable) is visually distinct from a real 0; internal v1/v2
 * narration is replaced with operator language.
 */

const FUNNEL_DEF: Array<{ key: keyof AnalyticsReport["funnel"]; label: string }> = [
  { key: "outreach_sent", label: "Outreach sent" },
  { key: "in_conversation", label: "In conversation" },
  { key: "shipped", label: "Sample shipped" },
  { key: "delivered", label: "Delivered" },
  { key: "posted", label: "Posted" },
  { key: "verified", label: "Verified" },
];

// A funnel chart must be CUMULATIVE ("reached this stage or further"), not a current-state
// snapshot — otherwise a verified track (counted only in `verified`) makes Verified exceed
// Posted/Delivered. Map each lifecycle/terminal state to the furthest stage it reached, then
// count tracks at-or-beyond each stage so the funnel is monotonically non-increasing.
const LIFECYCLE = [
  "candidate", "shortlisted", "outreach_sent", "in_conversation", "agreed",
  "address_collected", "shipped", "delivered", "posted", "verified",
] as const;
const REACHED_AT: Record<string, (typeof LIFECYCLE)[number]> = {
  candidate: "candidate", shortlisted: "shortlisted",
  outreach_sent: "outreach_sent", no_response: "outreach_sent",
  in_conversation: "in_conversation", declined: "in_conversation",
  agreed: "agreed", address_collected: "address_collected",
  shipped: "shipped", flaked: "shipped",
  delivered: "delivered", posted: "posted", verified: "verified",
};
function reachedFunnel(fn: AnalyticsReport["funnel"]): Record<string, number> {
  const out: Record<string, number> = {};
  LIFECYCLE.forEach((stage, si) => {
    let n = 0;
    for (const [state, count] of Object.entries(fn)) {
      const ri = LIFECYCLE.indexOf(REACHED_AT[state] ?? (state as (typeof LIFECYCLE)[number]));
      if (ri >= si) n += count;
    }
    out[stage] = n;
  });
  return out;
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

  const verified = a.goals.verifiedCount;
  const goalMet = a.goals.goalMet;
  const zeroResult = verified === 0;
  const er = a.reach.weightedEngagementRate !== null ? `${(a.reach.weightedEngagementRate * 100).toFixed(1)}` : null;
  const engagement = a.reach.verifiedLikes + a.reach.verifiedComments + a.reach.verifiedShares;
  const reach = fmtCompactKo(a.reach.verifiedViews);

  const header = zeroResult
    ? { tone: "stop" as const, label: "Missed goal · no verified posts" }
    : goalMet
      ? { tone: "ok" as const, label: "Goal met" }
      : { tone: "warn" as const, label: "Partial progress" };

  const reached = reachedFunnel(a.funnel);
  const funnelRows: FunnelRow[] = FUNNEL_DEF.map((r) => ({ label: r.label, value: reached[r.key] ?? 0 }));

  // Rank by views (the metric the row shows), de-duped to one row per creator.
  // The v1 import stores a creator's 2nd post as "<id>#2", which resolves to the
  // same handle — so without de-duping the same creator shows up twice.
  const ranked = [...(a.tracks ?? [])]
    .filter((t) => t.performanceScore !== null)
    .sort((x, y) => (y.views ?? 0) - (x.views ?? 0));
  const profiles = await resolveCreators(ranked.map((t) => t.creatorId));
  const seenCreator = new Set<string>();
  const leaderboard = ranked
    .filter((t) => {
      const key = profiles.get(t.creatorId)?.handle ?? t.creatorId.replace(/#\d+$/, "");
      if (seenCreator.has(key)) return false;
      seenCreator.add(key);
      return true;
    })
    .slice(0, 12);

  return (
    <div className="max-w-5xl mx-auto px-8 py-8">
      <header className="mb-5">
        <Link href={`/campaigns/${id}`} className="text-[12px] text-ink-3 hover:text-ink-2">← {a.brief.name}</Link>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-bold tracking-[-0.01em]">Performance analysis</h1>
            <div className="mt-1 text-[12.5px] text-ink-3">{a.brief.category}</div>
          </div>
          <StatusTag tone={header.tone}>{header.label}</StatusTag>
        </div>
      </header>

      {/* Honest diagnostic for zero-result; calm note otherwise */}
      {zeroResult ? (
        <DiagnosticBanner
          tone="stop"
          title={campaign.tracks.length > 0
            ? `0 of ${campaign.tracks.length} creators reached posting, so the campaign missed its goal.`
            : "No posted content yet, so the campaign has not met its goal."}
          actions={
            <>
              <Link href="/campaigns/new"><Button variant="primary" size="sm">Start a broader campaign</Button></Link>
              <Link href="/policies"><Button size="sm">Adjust reply policy</Button></Link>
              <Link href="/settings"><Button size="sm">Check Gmail connection</Button></Link>
            </>
          }
          className="mb-6"
        >
          Outreach was sent, but no posts were verified. The most likely cause is a narrow candidate pool from the target
          engagement threshold (ER ≥ {(campaign.brief.targeting.minEngagementRate * 100).toFixed(1)}%). You can retry from here.
        </DiagnosticBanner>
      ) : (
        <div className="mb-6 rounded-2xl border border-ok/25 bg-ok-bg px-5 py-3.5 text-[13px] text-ink-2">
          Agents completed the performance analysis and calculated these metrics from {verified} verified posts.
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 mb-6">
        <Stat
          label="Goal / posts"
          value={verified}
          unit={`/ ${a.goals.targetLivePosts}`}
          hint={a.goals.percentOfGoal !== null ? `${Math.round(a.goals.percentOfGoal * 100)}% of goal` : "No goal set"}
          tone={zeroResult ? "stop" : goalMet ? "ok" : "default"}
        />
        <Stat
          label="Total reach"
          value={a.reach.verifiedViews > 0 ? reach.value : 0}
          unit={a.reach.verifiedViews > 0 ? reach.unit : undefined}
          hint={a.reach.verifiedViews > 0 ? `${fmtNum(a.reach.verifiedViews)} total views` : "No posts"}
        />
        <Stat
          label="Avg engagement"
          value={er ?? "—"}
          unit={er ? "%" : undefined}
          hint={`♥ ${fmtNum(a.reach.verifiedLikes)} · 💬 ${fmtNum(a.reach.verifiedComments)} · ↗ ${fmtNum(a.reach.verifiedShares)}`}
          tone={er ? "default" : "muted"}
        />
        <Stat
          label="Performance score"
          value={a.performance.avgPerformanceScore !== null ? a.performance.avgPerformanceScore : "—"}
          hint={a.performance.avgPerformanceScore !== null ? `${fmtNum(engagement)} total engagements` : "No measurable data"}
          tone={a.performance.avgPerformanceScore !== null ? "brand" : "muted"}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Funnel — stage conversion</CardTitle>
            <span className="text-[11px] text-ink-3 mono">0 = empty bar</span>
          </CardHeader>
          <CardBody><Funnel rows={funnelRows} /></CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>Post leaderboard</CardTitle></CardHeader>
          <CardBody className="pt-1.5">
            {leaderboard.length === 0 ? (
              <div className="text-[12.5px] text-ink-3 py-4">No verified posts yet.</div>
            ) : (
              <div className="space-y-0.5">
                {leaderboard.map((t, i) => {
                  const p = profiles.get(t.creatorId);
                  const display = p?.nickname ?? p?.handle ?? creatorLabel(t.creatorId);
                  return (
                    <div key={t.creatorId} className="flex items-center gap-3 py-2 border-b border-line-2 last:border-0">
                      <span className="w-5 text-[12px] text-ink-3 mono shrink-0">{i + 1}</span>
                      <Avatar name={display} src={p?.avatar} size="sm" />
                      <div className="min-w-0">
                        <div className="text-[13px] text-ink truncate leading-tight">{display}</div>
                        {p?.handle && p.handle !== display && (
                          <div className="text-[11px] text-ink-3 mono truncate">{p.handle}</div>
                        )}
                      </div>
                      <span className="ml-auto text-[13px] mono font-bold text-ink shrink-0">
                        {fmtNum(t.views ?? 0)} <span className="text-ink-3 font-normal">views</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="mt-4 text-[11px] text-ink-3">
        Generated {a.generatedAt.toISOString().slice(0, 16).replace("T", " ")} · spent ${a.cost.spentUsd.toFixed(2)}
      </div>
    </div>
  );
}
