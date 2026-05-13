import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { StageBar } from "@/components/mission-control/stage-bar";
import { getServerSession } from "@/lib/auth";
import { approvalRepo, campaignRepo, traceRepo } from "@ss/db";
import { ActivityTimeline } from "@/components/mission-control/activity-timeline";

/**
 * W2 — Campaign detail. Server component. 6-stage indicator + brief summary
 * + "Needs you" panel for any pending approvals on this campaign. The
 * activity-timeline body lands in W3 (next commit); for now this view shows
 * the orchestration state without the streaming span feed.
 */

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  const { id } = await params;
  const campaign = await campaignRepo.get(id);
  if (!campaign || campaign.brief.workspaceId !== session.workspaceId) notFound();

  const pending = await approvalRepo
    .listPendingByWorkspace(session.workspaceId)
    .then((rows) => rows.filter((a) => a.campaignId === id))
    .catch(() => []);
  const traces = await traceRepo.listByCampaign(id).catch(() => []);

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <header className="mb-4">
        <Link href="/campaigns" className="text-[11px] text-slate-500 hover:text-slate-900">
          ← 캠페인 목록
        </Link>
        <div className="mt-2 flex items-end justify-between">
          <div>
            <h1 className="text-[22px] font-semibold">{campaign.brief.brandProduct.name}</h1>
            <div className="mt-1 text-[12px] text-slate-500 mono">
              camp_{campaign.id} · workspace={campaign.brief.workspaceId} · created {campaign.createdAt.toISOString().slice(0, 10)}
            </div>
          </div>
          <div className="flex gap-2">
            <Button>⏸ 일시정지</Button>
            <Button tone="reject">✕ 취소</Button>
          </div>
        </div>
      </header>

      <div className="mb-6">
        <StageBar
          current={campaign.stage}
          notes={
            pending.length > 0 ? { sourcing: "● 승인 대기" } : undefined
          }
        />
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* LEFT — activity timeline (W3) */}
        <div className="col-span-2">
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
        </div>

        {/* RIGHT — needs-you + brief summary */}
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
              {campaign.tracks.slice(0, 5).map((t) => (
                <div key={t.creatorId} className="flex items-center justify-between text-[12px] py-1">
                  <span className="mono">{t.creatorId}</span>
                  <Badge variant="slate">{t.state}</Badge>
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
