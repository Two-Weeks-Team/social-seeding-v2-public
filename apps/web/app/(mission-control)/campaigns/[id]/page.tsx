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
import { bucketTracksByState } from "@/components/mission-control/campaign-track-buckets";
import { getServerSession } from "@/lib/auth";
import { approvalRepo, campaignRepo, traceRepo, messageRepo } from "@ss/db";
import { Events, AnalyticsReportSchema, type AnalyticsReport } from "@ss/contracts";
import { inngest } from "@ss/workflows";
import { invokeCapability } from "@ss/capabilities";
import { cn } from "@/lib/cn";
import { campaignStatus, approvalKindKo, trackState, stageKo } from "@/lib/labels";
import { creatorLabel, fmtFollowers, fmtCompactKo } from "@/lib/format";
import { resolveCreators } from "@/lib/creators";

/** Lifecycle controls — cancel + pause/resume (see prior history for the durable-workflow semantics). */
async function cancelCampaignAction(formData: FormData): Promise<void> {
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
  await inngest.send({ name: isPaused ? Events.CampaignResumed : Events.CampaignPaused, data: { campaignId } });
  revalidatePath(`/campaigns/${campaignId}`);
}

const LANG_KO: Record<string, string> = { ko: "한국어", en: "영어", ja: "일본어", zh: "중국어", "zh-CN": "중국어" };
function langs(codes: string[]): string {
  return codes.map((c) => LANG_KO[c] ?? c).join(", ");
}
function fmtDate(d: Date): string {
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

type View = "timeline" | "canvas";

const SUB_LINKS: { seg: string; label: string }[] = [
  { seg: "threads", label: "메일" },
  { seg: "performance", label: "성과" },
  { seg: "posts", label: "게시물" },
  { seg: "shipments", label: "배송" },
  { seg: "report", label: "리포트" },
];

const FUNNEL_DEF: { key: keyof AnalyticsReport["funnel"]; label: string }[] = [
  { key: "outreach_sent", label: "아웃리치" },
  { key: "in_conversation", label: "대화 중" },
  { key: "shipped", label: "샘플 발송" },
  { key: "delivered", label: "수령" },
  { key: "posted", label: "게시" },
  { key: "verified", label: "검증 완료" },
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
      t.spans
        .filter((s) => s.name === "agent:vetting")
        .reduce((a, s) => a + (typeof s.attrs.evaluated === "number" ? (s.attrs.evaluated as number) : 1), 0),
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

  // Real performance rollup (same source as the 성과/리포트 tabs) — surfaced inline
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
      ? `승인 대기 · ${approvalKindKo(pending[0].kind)}`
      : isComplete
        ? "완료됨"
        : isStopped
          ? "취소됨"
          : isLive
            ? `${stageKo(campaign.stage)} 진행 중`
            : st.label;

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <header className="mb-5">
        <Link href="/campaigns" className="text-[12px] text-ink-3 hover:text-ink-2">← 캠페인 목록</Link>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-bold tracking-[-0.01em]">{campaign.brief.brandProduct.name}</h1>
            <div className="mt-1 text-[12.5px] text-ink-3">
              {campaign.brief.brandProduct.category} · {fmtDate(campaign.createdAt)} 시작
            </div>
          </div>
          <div className="flex items-center gap-3">
            {isLive ? (
              <div className="flex gap-2">
                <form action={pauseCampaignAction}>
                  <input type="hidden" name="campaignId" value={id} />
                  <Button>{campaign.status === "paused" ? "▶ 재개" : "⏸ 일시정지"}</Button>
                </form>
                <form action={cancelCampaignAction}>
                  <input type="hidden" name="campaignId" value={id} />
                  <Button tone="reject">✕ 취소</Button>
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
                {v === "timeline" ? "타임라인" : "캔버스"}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-1 text-[12.5px]">
            <span className="text-ink-3 mr-1">상세 보기</span>
            {SUB_LINKS.map((l) => (
              <Link key={l.seg} href={`/campaigns/${id}/${l.seg}`} className="px-2 py-1 rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink">
                {l.label}
              </Link>
            ))}
          </div>
        </div>
      </header>

      <div className="mb-6">
        <StageBar current={campaign.stage} complete={isComplete} stopped={isStopped} notes={shortlistApproval ? { sourcing: "승인 대기" } : undefined} />
      </div>

      {view === "timeline" && analytics && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          <Stat
            label="검증 게시물"
            value={analytics.goals.verifiedCount}
            unit={`/ ${analytics.goals.targetLivePosts}`}
            tone={analytics.goals.goalMet ? "ok" : analytics.goals.verifiedCount > 0 ? "default" : "muted"}
            hint={pct !== null ? `목표 대비 ${pct}%` : undefined}
          />
          <Stat
            label="총 조회수"
            value={fmtCompactKo(analytics.reach.verifiedViews).value}
            unit={fmtCompactKo(analytics.reach.verifiedViews).unit}
            tone={analytics.reach.verifiedViews > 0 ? "default" : "muted"}
          />
          <Stat
            label="평균 참여율"
            value={er !== null ? (er * 100).toFixed(1) : "—"}
            unit={er !== null ? "%" : undefined}
            tone={er !== null ? "default" : "muted"}
          />
          <Stat label="대상 크리에이터" value={campaign.tracks.length} hint={`검증 완료 ${analytics.goals.verifiedCount}명`} />
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
                      <SectionLabel>전환 퍼널</SectionLabel>
                      <Link href={`/campaigns/${id}/performance`} className="text-[11.5px] text-ink-3 hover:text-ink-2">성과 전체 →</Link>
                    </div>
                    <Funnel rows={FUNNEL_DEF.map((d) => ({ label: d.label, value: analytics.funnel[d.key] }))} />
                  </CardBody>
                </Card>
              )}
              <Card>
                <CardBody>
                  <div className="flex items-center justify-between mb-3">
                    <SectionLabel>활동 타임라인</SectionLabel>
                    {isLive && (
                      <div className="text-[11px] text-ink-3 flex items-center gap-1.5">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-ok animate-pulse" />
                        실시간
                      </div>
                    )}
                  </div>
                  <ActivityTimeline traces={traces} />
                </CardBody>
              </Card>
            </div>
          )}
        </div>

        <aside className={cn(view === "canvas" ? "grid grid-cols-3 gap-5" : "space-y-5")}>
          {pending.length > 0 && pending[0] && (
            <Card className="bg-warn-bg border-warn/25" flat>
              <CardBody>
                <SectionLabel className="text-warn mb-2">필요한 결정</SectionLabel>
                <div className="text-[14px] font-semibold text-ink">{approvalKindKo(pending[0].kind)} 대기</div>
                {pending[0].rationale && <p className="mt-1 text-[12.5px] text-ink-2">{pending[0].rationale}</p>}
                <Link href={`/approvals/${pending[0].id}`} className="mt-3 block">
                  <Button variant="primary" tone="warn" className="w-full">검토하러 가기 →</Button>
                </Link>
              </CardBody>
            </Card>
          )}

          <Card>
            <CardBody>
              <SectionLabel className="mb-3">진행 · 일정</SectionLabel>
              <dl className="text-[13px] space-y-2.5">
                <div className="flex items-center justify-between">
                  <dt className="text-ink-3">상태</dt>
                  <dd><StatusTag tone={st.tone} size="sm">{st.label}</StatusTag></dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-ink-3 shrink-0">다음 액션</dt>
                  <dd className="text-ink text-right truncate">{nextAction}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-ink-3">예산 상한</dt>
                  <dd className="text-ink mono">{campaign.brief.goals.budgetUsd != null ? `$${campaign.brief.goals.budgetUsd}` : "—"}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-ink-3 shrink-0">시작 · 마감</dt>
                  <dd className="text-ink text-right">{fmtDate(campaign.createdAt)} · {fmtDate(campaign.brief.goals.deadline)}</dd>
                </div>
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <SectionLabel className="mb-3">캠페인 개요</SectionLabel>
              <dl className="text-[13px] space-y-2.5">
                <div>
                  <dt className="text-[11px] text-ink-3">브랜드 · 제품</dt>
                  <dd className="font-semibold text-ink">
                    {campaign.brief.brandProduct.name} <span className="text-ink-3 font-normal">({campaign.brief.brandProduct.category})</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-ink-3">설명</dt>
                  <dd className="text-ink-2">{campaign.brief.brandProduct.description}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-ink-3">타겟</dt>
                  <dd className="text-ink-2">
                    크리에이터 {campaign.brief.targeting.creatorCount}명 · 참여율 {(campaign.brief.targeting.minEngagementRate * 100).toFixed(1)}% 이상 · {langs(campaign.brief.targeting.languages)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-ink-3">샘플 발송</dt>
                  <dd className="text-ink-2">{campaign.brief.logistics.shipsSamples ? "예" : "아니오"}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-ink-3">목표</dt>
                  <dd className="text-ink-2">게시물 {campaign.brief.goals.targetLivePosts}건 · 마감 {fmtDate(campaign.brief.goals.deadline)}</dd>
                </div>
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <SectionLabel className="mb-3">대상 크리에이터 ({campaign.tracks.length})</SectionLabel>
              {analytics && campaign.tracks.length > 0 && (
                <div className="text-[12px] text-ink-3 mb-2.5 -mt-1">
                  검증 완료 {analytics.goals.verifiedCount} · 게시 {analytics.funnel.posted} · 대화 중 {analytics.funnel.in_conversation}
                </div>
              )}
              {campaign.tracks.length === 0 ? (
                <div className="text-[12.5px] text-ink-3">아직 선정된 크리에이터가 없습니다.</div>
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
                              {p.handle}{p.followers ? ` · 팔로워 ${fmtFollowers(p.followers)}` : ""}
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
                    <div className="text-[11px] text-ink-3 mt-1.5">+{campaign.tracks.length - 6}명 더</div>
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
