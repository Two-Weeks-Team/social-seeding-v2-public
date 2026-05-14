import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { StageBar } from "@/components/mission-control/stage-bar";
import { ActivityTimeline } from "@/components/mission-control/activity-timeline";
import { CampaignCanvas, bucketTracksByState } from "@/components/mission-control/campaign-canvas";
import { getServerSession } from "@/lib/auth";
import { approvalRepo, campaignRepo, traceRepo } from "@ss/db";
import { Events, type CreatorTrack } from "@ss/contracts";
import { inngest } from "@ss/workflows";
import { cn } from "@/lib/cn";

/**
 * Lifecycle controls — cancel (P4-C6) + pause/resume (P6.5 carry-over).
 *
 * Cancel: brand-campaign's `cancelOn: [{event: CampaignCancelled,
 * match: "data.campaignId"}]` aborts the durable Inngest run; the patch
 * here makes MC reflect the state immediately.
 *
 * Pause/Resume: P6.5 added a `pauseCheck(step, campaignId)` guard before
 * every gmail.send in creator-track + lead-track. When the campaign is
 * `status='paused'`, the helper parks the workflow on
 * `step.waitForEvent('campaign/resumed', 30d)` so no further outreach
 * goes out. Resume re-fires the event and the workflow proceeds.
 * Already-in-flight Inngest runs survive — Inngest's durable timers +
 * step graph carry over a pause without re-emit.
 */
async function cancelCampaignAction(formData: FormData): Promise<void> {
  "use server";
  const session = await getServerSession();
  if (!session) throw new Error("not authenticated");
  const campaignId = formData.get("campaignId");
  if (typeof campaignId !== "string") throw new Error("missing campaignId");
  const c = await campaignRepo.get(campaignId);
  if (!c || c.brief.workspaceId !== session.workspaceId) throw new Error("forbidden");
  // Idempotent: already-cancelled / already-completed don't re-emit.
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
  const c = await campaignRepo.get(campaignId);
  if (!c || c.brief.workspaceId !== session.workspaceId) throw new Error("forbidden");
  if (c.status === "cancelled" || c.status === "completed") {
    revalidatePath(`/campaigns/${campaignId}`);
    return;
  }
  const isPaused = c.status === "paused";
  await campaignRepo.patchStage(campaignId, c.stage, isPaused ? "running" : "paused");
  // The events are advisory; workflows pick up the new status on the
  // next pauseCheck() / resume waitForEvent. The persisted status is
  // the load-bearing source-of-truth.
  await inngest.send({
    name: isPaused ? Events.CampaignResumed : Events.CampaignPaused,
    data: { campaignId },
  });
  revalidatePath(`/campaigns/${campaignId}`);
}

/**
 * State → badge color. Mirrors the canvas's progress narrative:
 *   live (running) → blue/amber, terminal-good → emerald, terminal-bad → rose.
 */
function trackStateVariant(state: CreatorTrack["state"]): "slate" | "blue" | "amber" | "emerald" | "rose" {
  switch (state) {
    case "outreach_sent":
    case "in_conversation":
      return "blue";
    case "agreed":
    case "address_collected":
    case "shipped":
    case "delivered":
    case "posted":
    case "verified":
      return "emerald";
    case "declined":
    case "flaked":
      return "rose";
    case "no_response":
      return "amber";
    default:
      return "slate";
  }
}

/**
 * W2 + W3 + Phase-2-C1 — Campaign detail.
 *
 * Two co-existing views of the same workflow, toggled by ?view=:
 *   timeline (default)  reverse-chron span feed from v2_agent_traces (W3)
 *   canvas              spatial workflow graph via @xyflow/react (Phase 2)
 *
 * The cross-campaign approval inbox stays separate (/approvals); these views
 * are single-campaign. Brief + tracks + pending-approval panel render the
 * same regardless of view.
 */

type View = "timeline" | "canvas";

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

  // Derive canvas state from the trace + pending data
  const shortlistApproval = pending.find((a) => a.kind === "shortlist");
  const vetCount = traces.reduce((sum, t) => sum + t.spans.filter((s) => s.name === "agent:vetting").length, 0);
  const shortlistCount =
    shortlistApproval && Array.isArray(shortlistApproval.recommendation)
      ? (shortlistApproval.recommendation as unknown[]).length
      : undefined;
  const trackBuckets = bucketTracksByState(campaign.tracks);

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <header className="mb-4">
        <Link href="/campaigns" className="text-[11px] text-slate-500 hover:text-slate-900">
          ← 캠페인 목록
        </Link>
        <div className="mt-2 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-[22px] font-semibold">{campaign.brief.brandProduct.name}</h1>
            <div className="mt-1 text-[12px] text-slate-500 mono">
              camp_{campaign.id} · workspace={campaign.brief.workspaceId} · created {campaign.createdAt.toISOString().slice(0, 10)}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* view toggle — timeline vs canvas */}
            <div className="inline-flex p-0.5 bg-slate-100 border border-slate-200 rounded-md gap-0.5">
              {(["timeline", "canvas"] as const).map((v) => {
                const isActive = view === v;
                return (
                  <Link
                    key={v}
                    href={`/campaigns/${id}?view=${v}`}
                    className={cn(
                      "px-3 py-1 text-[12px] rounded transition-colors",
                      isActive ? "bg-white shadow-sm text-slate-900 font-medium" : "text-slate-600 hover:text-slate-900",
                    )}
                  >
                    {v}
                  </Link>
                );
              })}
            </div>
            {/* Phase 3 — shipment + content list views. Phase 4 adds report. */}
            <div className="flex items-center gap-1.5 text-[12px]">
              <Link
                href={`/campaigns/${id}/shipments`}
                className="text-slate-600 hover:text-slate-900 underline-offset-2 hover:underline"
              >
                shipments
              </Link>
              <span className="text-slate-300">·</span>
              <Link
                href={`/campaigns/${id}/posts`}
                className="text-slate-600 hover:text-slate-900 underline-offset-2 hover:underline"
              >
                posts
              </Link>
              <span className="text-slate-300">·</span>
              <Link
                href={`/campaigns/${id}/report`}
                className="text-slate-600 hover:text-slate-900 underline-offset-2 hover:underline"
              >
                report
              </Link>
            </div>
            <div className="flex gap-2">
              {campaign.status === "running" || campaign.status === "paused" ? (
                <>
                  <form action={pauseCampaignAction}>
                    <input type="hidden" name="campaignId" value={id} />
                    <Button>{campaign.status === "paused" ? "▶ 재개" : "⏸ 일시정지"}</Button>
                  </form>
                  <form action={cancelCampaignAction}>
                    <input type="hidden" name="campaignId" value={id} />
                    <Button tone="reject">✕ 취소</Button>
                  </form>
                </>
              ) : (
                <Badge variant={campaign.status === "completed" ? "emerald" : "slate"}>
                  {campaign.status}
                </Badge>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="mb-6">
        <StageBar current={campaign.stage} notes={shortlistApproval ? { sourcing: "● 승인 대기" } : undefined} />
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* LEFT — view body (timeline by default, canvas if ?view=canvas) */}
        <div className="col-span-2">
          {view === "canvas" ? (
            <CampaignCanvas
              stage={campaign.stage}
              brandName={campaign.brief.brandProduct.name}
              targetCreatorCount={campaign.brief.targeting.creatorCount}
              vetCount={vetCount}
              budgetCapUsd={25}
              shortlistCount={shortlistCount}
              shortlistGateApprovalId={shortlistApproval?.id}
              trackCount={campaign.tracks.length}
              trackBuckets={trackBuckets}
            />
          ) : (
            <Card>
              <CardBody>
                <div className="flex items-center justify-between mb-3">
                  <SectionLabel>활동 타임라인</SectionLabel>
                  <div className="text-[10px] text-slate-500 flex items-center gap-1.5">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    live
                  </div>
                </div>
                <ActivityTimeline traces={traces} />
              </CardBody>
            </Card>
          )}
        </div>

        {/* RIGHT — needs-you + brief summary + tracks (view-independent) */}
        <aside className="space-y-5">
          {pending.length > 0 && (
            <Card className="bg-amber-50 border-amber-200">
              <CardBody>
                <SectionLabel className="text-amber-700 mb-2">필요한 결정</SectionLabel>
                <div className="text-[14px] font-medium text-slate-900">
                  {pending[0]?.kind === "shortlist" ? "후보 리스트 승인 대기" : `${pending[0]?.kind} 승인 대기`}
                </div>
                <p className="mt-1 text-[12px] text-slate-700">{pending[0]?.rationale}</p>
                <Link href={`/approvals/${pending[0]?.id}`} className="mt-3 block">
                  <Button variant="primary" tone="warn" className="w-full">검토하러 가기 →</Button>
                </Link>
              </CardBody>
            </Card>
          )}

          <Card>
            <CardBody>
              <SectionLabel className="mb-2">캠페인 brief</SectionLabel>
              <dl className="text-[13px] space-y-2">
                <div>
                  <dt className="text-[11px] text-slate-500">브랜드 · 제품</dt>
                  <dd className="font-medium">
                    {campaign.brief.brandProduct.name}{" "}
                    <span className="text-slate-500 font-normal">({campaign.brief.brandProduct.category})</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-slate-500">설명</dt>
                  <dd>{campaign.brief.brandProduct.description}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-slate-500">타겟팅</dt>
                  <dd>
                    {campaign.brief.targeting.creatorCount}명 / ER ≥ {(campaign.brief.targeting.minEngagementRate * 100).toFixed(1)}% /{" "}
                    lang={campaign.brief.targeting.languages.join(",")}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-slate-500">샘플 발송</dt>
                  <dd>{campaign.brief.logistics.shipsSamples ? "예" : "아니오"}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-slate-500">목표</dt>
                  <dd>
                    live posts {campaign.brief.goals.targetLivePosts}개 by{" "}
                    {campaign.brief.goals.deadline.toISOString().slice(0, 10)}
                  </dd>
                </div>
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <SectionLabel className="mb-2">트랙 ({campaign.tracks.length})</SectionLabel>
              {campaign.tracks.length === 0 && (
                <div className="text-[12px] text-slate-500">아직 트랙이 없습니다.</div>
              )}
              {campaign.tracks.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1">
                  {(Object.entries(trackBuckets) as [keyof typeof trackBuckets, number][])
                    .filter(([, n]) => n > 0)
                    .map(([state, n]) => (
                      <Badge key={state} variant={trackStateVariant(state)}>
                        {state} · {n}
                      </Badge>
                    ))}
                </div>
              )}
              {campaign.tracks.slice(0, 5).map((t) => (
                <div key={t.creatorId} className="flex items-center justify-between text-[12px] py-1">
                  <span className="mono">{t.creatorId}</span>
                  <Badge variant={trackStateVariant(t.state)}>{t.state}</Badge>
                </div>
              ))}
              {campaign.tracks.length > 5 && (
                <div className="text-[11px] text-slate-500 mt-1">+{campaign.tracks.length - 5}명 더</div>
              )}
            </CardBody>
          </Card>
        </aside>
      </div>
    </div>
  );
}
