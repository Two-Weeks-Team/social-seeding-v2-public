import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Button } from "@/components/ui/button";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { StatusTag } from "@/components/ui/status-tag";
import { Stat } from "@/components/ui/stat";
import { Funnel } from "@/components/ui/funnel";
import { Avatar } from "@/components/ui/avatar";
import { StageBar } from "@/components/mission-control/stage-bar";
import { ActivityTimeline } from "@/components/mission-control/activity-timeline";
import { CampaignCanvas } from "@/components/mission-control/campaign-canvas";
import { CampaignAsk } from "@/components/mission-control/campaign-ask";
import { bucketTracksByState } from "@/components/mission-control/campaign-track-buckets";
import { demoReadonlyGuard, getServerSession } from "@/lib/auth";
import { approvalRepo, campaignRepo, traceRepo, messageRepo } from "@ss/db";
import { Events, AnalyticsReportSchema, type AnalyticsReport } from "@ss/contracts";
import { inngest } from "@ss/workflows";
import { invokeCapability } from "@ss/capabilities";
import { cn } from "@/lib/cn";
import { campaignStatus, approvalKindKo, trackState, stageKo } from "@/lib/labels";
import { creatorLabel, fmtFollowers, fmtCompactKo } from "@/lib/format";
import { resolveCreators } from "@/lib/creators";
import { reachedFunnel } from "@/lib/funnel";

/** Lifecycle controls — cancel + pause/resume (see prior history for the durable-workflow semantics). */
async function cancelCampaignAction(formData: FormData): Promise<void> {
  "use server";
  const session = await getServerSession();
  if (!session) throw new Error("not authenticated");
  const campaignId = formData.get("campaignId");
  if (typeof campaignId !== "string") throw new Error("missing campaignId");
  demoReadonlyGuard(session, `/campaigns/${campaignId}`);
  const c = await campaignRepo.get(campaignId);
  if (!c || c.brief.workspaceId !== session.workspaceId) throw new Error("forbidden");
  if (c.status === "cancelled" || c.status === "completed") {
    revalidatePath(`/campaigns/${campaignId}`);
    return;
  }
  await campaignRepo.patchStage(campaignId, c.stage, "cancelled");
  await inngest.send({ name: Events.CampaignCancelled, data: { campaignId } });
  revalidatePath(`/campaigns/${campaignId}`);
}

async function pauseCampaignAction(formData: FormData): Promise<void> {
  "use server";
  const session = await getServerSession();
  if (!session) throw new Error("not authenticated");
  const campaignId = formData.get("campaignId");
  if (typeof campaignId !== "string") throw new Error("missing campaignId");
  demoReadonlyGuard(session, `/campaigns/${campaignId}`);
  const c = await campaignRepo.get(campaignId);
  if (!c || c.brief.workspaceId !== session.workspaceId) throw new Error("forbidden");
  if (c.status === "cancelled" || c.status === "completed") {
    revalidatePath(`/campaigns/${campaignId}`);
    return;
  }
  const isPaused = c.status === "paused";
  await campaignRepo.patchStage(campaignId, c.stage, isPaused ? "running" : "paused");
  await inngest.send({ name: isPaused ? Events.CampaignResumed : Events.CampaignPaused, data: { campaignId } });
  revalidatePath(`/campaigns/${campaignId}`);
}

const LANG_KO: Record<string, string> = { ko: "Korean", en: "English", ja: "Japanese", zh: "Chinese", "zh-CN": "Chinese" };
function langs(codes: string[]): string {
  return codes.map((c) => LANG_KO[c] ?? c).join(", ");
}
function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

type View = "timeline" | "canvas";

const SUB_LINKS: { seg: string; label: string }[] = [
  { seg: "threads", label: "Mail" },
  { seg: "performance", label: "Performance" },
  { seg: "posts", label: "Posts" },
  { seg: "shipments", label: "Shipping" },
  { seg: "report", label: "Report" },
];

const FUNNEL_DEF: { key: keyof AnalyticsReport["funnel"]; label: string }[] = [
  { key: "outreach_sent", label: "Outreach" },
  { key: "in_conversation", label: "In conversation" },
  { key: "shipped", label: "Sample shipped" },
  { key: "delivered", label: "Delivered" },
  { key: "posted", label: "Posted" },
  { key: "verified", label: "Verified" },
];

export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  const { id } = await params;
  const { view: viewParam } = await searchParams;
  const view: View = viewParam === "canvas" ? "canvas" : "timeline";

  const campaign = await campaignRepo.get(id);
  if (!campaign || campaign.brief.workspaceId !== session.workspaceId) notFound();

  const pending = await approvalRepo
    .listPendingByWorkspace(session.workspaceId)
    .then((rows) => rows.filter((a) => a.campaignId === id))
    .catch(() => []);
  const traces = await traceRepo.listByCampaign(id).catch(() => []);

  const shortlistApproval = pending.find((a) => a.kind === "shortlist");
  // A vetting span may represent a batch — prefer its attrs.evaluated count,
  // else count one per span. (Keeps the timeline readable while the canvas still
  // shows the true number of candidates evaluated.)
  const vetCount = traces.reduce(
    (sum, t) =>
      sum +
      (t.spans ?? [])
        .filter((s) => s.name === "agent:vetting")
        .reduce((a, s) => a + (typeof s.attrs?.evaluated === "number" ? (s.attrs.evaluated as number) : 1), 0),
    0,
  );
  const shortlistCount =
    shortlistApproval && Array.isArray(shortlistApproval.recommendation)
      ? (shortlistApproval.recommendation as unknown[]).length
      : undefined;
  const trackBuckets = bucketTracksByState(campaign.tracks);
  const trackProfiles = await resolveCreators(campaign.tracks.slice(0, 6).map((t) => t.creatorId));
  const campaignThreads = await messageRepo.threadsByCampaign(id, session.workspaceId).catch(() => []);
  const threadByCreator = new Map(campaignThreads.map((t) => [t.creatorId, t.threadId]));

  const st = campaignStatus(campaign.status);
  const isComplete = campaign.status === "completed";
  const isStopped = campaign.status === "cancelled";
  const isLive = campaign.status === "running" || campaign.status === "paused";

  // Real performance rollup (same source as the Performance/Report tabs) — surfaced inline
  // so the detail isn't sparse. Degrades to null if compile fails.
  const analytics = await invokeCapability(
    "analytics.compile",
    { campaignId: id },
    { workspaceId: session.workspaceId, userId: session.userId, rateLimitClass: "default" },
  )
    .then((raw) => AnalyticsReportSchema.parse(raw))
    .catch(() => null);
  const pct =
    analytics && analytics.goals.targetLivePosts > 0
      ? Math.round((analytics.goals.verifiedCount / analytics.goals.targetLivePosts) * 100)
      : null;
  const er = analytics?.reach.weightedEngagementRate ?? null;
  const nextAction =
    pending.length > 0 && pending[0]
      ? `Pending approval · ${approvalKindKo(pending[0].kind)}`
      : isComplete
        ? "Complete"
        : isStopped
          ? "Cancelled"
          : isLive
            ? `${stageKo(campaign.stage)} running`
            : st.label;

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <header className="mb-5">
        <Link href="/campaigns" className="text-[12px] text-ink-3 hover:text-ink-2">← Campaigns</Link>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-bold tracking-[-0.01em]">{campaign.brief.brandProduct.name}</h1>
            <div className="mt-1 text-[12.5px] text-ink-3">
              {campaign.brief.brandProduct.category} · started {fmtDate(campaign.createdAt)}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <CampaignAsk campaignId={id} />
            {isLive ? (
              <div className="flex gap-2">
                <form action={pauseCampaignAction}>
                  <input type="hidden" name="campaignId" value={id} />
                  <Button>{campaign.status === "paused" ? "▶ Resume" : "⏸ Pause"}</Button>
                </form>
                <form action={cancelCampaignAction}>
                  <input type="hidden" name="campaignId" value={id} />
                  <Button tone="reject">✕ Cancel</Button>
                </form>
              </div>
            ) : (
              <StatusTag tone={st.tone}>{st.label}</StatusTag>
            )}
          </div>
        </div>

        {/* secondary nav — segmented in-page view toggle + a separate detail-page group */}
        <div className="mt-4 flex items-center gap-4 flex-wrap">
          <div className="inline-flex p-0.5 bg-surface-2 border border-line rounded-xl gap-0.5">
            {(["timeline", "canvas"] as const).map((v) => (
              <Link
                key={v}
                href={`/campaigns/${id}?view=${v}`}
                className={cn(
                  "px-3.5 py-1.5 text-[12.5px] rounded-[10px] transition-colors font-medium",
                  view === v ? "bg-surface shadow-soft text-ink" : "text-ink-3 hover:text-ink",
                )}
              >
                {v === "timeline" ? "Timeline" : "Canvas"}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-1 text-[12.5px]">
            <span className="text-ink-3 mr-1">Details</span>
            {SUB_LINKS.map((l) => (
              <Link key={l.seg} href={`/campaigns/${id}/${l.seg}`} className="px-2 py-1 rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink">
                {l.label}
              </Link>
            ))}
          </div>
        </div>
      </header>

      <div className="mb-6">
        <StageBar current={campaign.stage} complete={isComplete} stopped={isStopped} notes={shortlistApproval ? { sourcing: "Pending approval" } : undefined} />
      </div>

      {view === "timeline" && analytics && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          <Stat
            label="Verified posts"
            value={analytics.goals.verifiedCount}
            unit={`/ ${analytics.goals.targetLivePosts}`}
            tone={analytics.goals.goalMet ? "ok" : analytics.goals.verifiedCount > 0 ? "default" : "muted"}
            hint={pct !== null ? `${pct}% of goal` : undefined}
          />
          <Stat
            label="Total views"
            value={fmtCompactKo(analytics.reach.verifiedViews).value}
            unit={fmtCompactKo(analytics.reach.verifiedViews).unit}
            tone={analytics.reach.verifiedViews > 0 ? "default" : "muted"}
          />
          <Stat
            label="Avg engagement"
            value={er !== null ? (er * 100).toFixed(1) : "—"}
            unit={er !== null ? "%" : undefined}
            tone={er !== null ? "default" : "muted"}
          />
          <Stat label="Target creators" value={campaign.tracks.length} hint={`${analytics.goals.verifiedCount} verified`} />
        </div>
      )}

      <div className={cn(view === "canvas" ? "space-y-5" : "grid grid-cols-3 gap-6")}>
        <div className={cn(view === "canvas" ? "" : "col-span-2")}>
          {view === "canvas" ? (
            <CampaignCanvas
              stage={campaign.stage}
              brandName={campaign.brief.brandProduct.name}
              targetCreatorCount={campaign.brief.targeting.creatorCount}
              vetCount={vetCount}
              budgetCapUsd={campaign.brief.goals.budgetUsd ?? 25}
              shortlistCount={shortlistCount}
              shortlistGateApprovalId={shortlistApproval?.id}
              trackCount={campaign.tracks.length}
              trackBuckets={trackBuckets}
            />
          ) : (
            <div className="space-y-5">
              {analytics && (
                <Card>
                  <CardBody>
                    <div className="flex items-center justify-between mb-3">
                      <SectionLabel>Conversion funnel</SectionLabel>
                      <Link href={`/campaigns/${id}/performance`} className="text-[11.5px] text-ink-3 hover:text-ink-2">Full performance →</Link>
                    </div>
                    <Funnel
                      rows={(() => {
                        // Cumulative ("reached this stage or further"), matching /performance —
                        // raw state buckets made Verified exceed Posted on completed pilots.
                        const reached = reachedFunnel(analytics.funnel);
                        return FUNNEL_DEF.map((d) => ({ label: d.label, value: reached[d.key] ?? 0 }));
                      })()}
                    />
                  </CardBody>
                </Card>
              )}
              {/* A completed campaign with no retained agent traces (e.g. a pilot we
                  measured rather than ran live) would otherwise show the misleading
                  "activity will appear once sourcing starts" empty state — hide the
                  card in that case. Live/in-progress campaigns keep it so streaming
                  activity (or the pending-start hint) still shows. */}
              {(traces.length > 0 || !isComplete) && (
                <Card>
                  <CardBody>
                    <div className="flex items-center justify-between mb-3">
                      <SectionLabel>Activity timeline</SectionLabel>
                      {isLive && (
                        <div className="text-[11px] text-ink-3 flex items-center gap-1.5">
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-ok animate-pulse" />
                          Live
                        </div>
                      )}
                    </div>
                    <ActivityTimeline traces={traces} />
                  </CardBody>
                </Card>
              )}
            </div>
          )}
        </div>

        <aside className={cn(view === "canvas" ? "grid grid-cols-3 gap-5" : "space-y-5")}>
          {pending.length > 0 && pending[0] && (
            <Card className="bg-warn-bg border-warn/25" flat>
              <CardBody>
                <SectionLabel className="text-warn mb-2">Decision needed</SectionLabel>
                <div className="text-[14px] font-semibold text-ink">{approvalKindKo(pending[0].kind)} pending</div>
                {pending[0].rationale && <p className="mt-1 text-[12.5px] text-ink-2">{pending[0].rationale}</p>}
                <Link href={`/approvals/${pending[0].id}`} className="mt-3 block">
                  <Button variant="primary" tone="warn" className="w-full">Review →</Button>
                </Link>
              </CardBody>
            </Card>
          )}

          <Card>
            <CardBody>
              <SectionLabel className="mb-3">Progress · Schedule</SectionLabel>
              <dl className="text-[13px] space-y-2.5">
                <div className="flex items-center justify-between">
                  <dt className="text-ink-3">Status</dt>
                  <dd><StatusTag tone={st.tone} size="sm">{st.label}</StatusTag></dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-ink-3 shrink-0">Next action</dt>
                  <dd className="text-ink text-right truncate">{nextAction}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-ink-3">Budget cap</dt>
                  <dd className="text-ink mono">{campaign.brief.goals.budgetUsd != null ? `$${campaign.brief.goals.budgetUsd}` : "—"}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-ink-3 shrink-0">Start · Deadline</dt>
                  <dd className="text-ink text-right">{fmtDate(campaign.createdAt)} · {fmtDate(campaign.brief.goals.deadline)}</dd>
                </div>
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <SectionLabel className="mb-3">Campaign overview</SectionLabel>
              <dl className="text-[13px] space-y-2.5">
                <div>
                  <dt className="text-[11px] text-ink-3">Brand · Product</dt>
                  <dd className="font-semibold text-ink">
                    {campaign.brief.brandProduct.name} <span className="text-ink-3 font-normal">({campaign.brief.brandProduct.category})</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-ink-3">Description</dt>
                  <dd className="text-ink-2">{campaign.brief.brandProduct.description}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-ink-3">Target</dt>
                  <dd className="text-ink-2">
                    {campaign.brief.targeting.creatorCount} creators · ER {(campaign.brief.targeting.minEngagementRate * 100).toFixed(1)}%+ · {langs(campaign.brief.targeting.languages)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-ink-3">Sample shipping</dt>
                  <dd className="text-ink-2">{campaign.brief.logistics.shipsSamples ? "Yes" : "No"}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-ink-3">Goal</dt>
                  <dd className="text-ink-2">{campaign.brief.goals.targetLivePosts} posts · due {fmtDate(campaign.brief.goals.deadline)}</dd>
                </div>
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <SectionLabel className="mb-3">Target creators ({campaign.tracks.length})</SectionLabel>
              {analytics && campaign.tracks.length > 0 && (
                <div className="text-[12px] text-ink-3 mb-2.5 -mt-1">
                  {analytics.goals.verifiedCount} verified · {analytics.funnel.posted} posted · {analytics.funnel.in_conversation} in conversation
                </div>
              )}
              {campaign.tracks.length === 0 ? (
                <div className="text-[12.5px] text-ink-3">No creators selected yet.</div>
              ) : (
                <div className="space-y-0.5">
                  {campaign.tracks.slice(0, 6).map((t) => {
                    const ts = trackState(t.state);
                    const p = trackProfiles.get(t.creatorId);
                    const display = p?.nickname ?? p?.handle ?? creatorLabel(t.creatorId);
                    const threadId = threadByCreator.get(t.creatorId);
                    const inner = (
                      <>
                        <Avatar name={display} src={p?.avatar} size="sm" />
                        <div className="min-w-0">
                          <div className="text-[12.5px] text-ink truncate leading-tight">{display}</div>
                          {p?.handle && p.handle !== display && (
                            <div className="text-[11px] text-ink-3 mono truncate">
                              {p.handle}{p.followers ? ` · ${fmtFollowers(p.followers)} followers` : ""}
                            </div>
                          )}
                        </div>
                        {threadId && <span className="ml-auto text-ink-3 text-[12px] shrink-0" aria-hidden>✉</span>}
                        <StatusTag tone={ts.tone} size="sm" className={cn("shrink-0", !threadId && "ml-auto")}>{ts.label}</StatusTag>
                      </>
                    );
                    return threadId ? (
                      <Link
                        key={t.creatorId}
                        href={`/threads/${encodeURIComponent(threadId)}?from=${encodeURIComponent(id)}`}
                        className="flex items-center gap-2.5 py-1.5 -mx-2 px-2 rounded-lg hover:bg-surface-2 transition-colors"
                      >
                        {inner}
                      </Link>
                    ) : (
                      <div key={t.creatorId} className="flex items-center gap-2.5 py-1.5">{inner}</div>
                    );
                  })}
                  {campaign.tracks.length > 6 && (
                    <div className="text-[11px] text-ink-3 mt-1.5">+{campaign.tracks.length - 6} more</div>
                  )}
                </div>
              )}
            </CardBody>
          </Card>
        </aside>
      </div>
    </div>
  );
}
