import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { getServerSession } from "@/lib/auth";
import { campaignRepo } from "@ss/db";
import type { CreatorTrack, CreatorTrackContent } from "@ss/contracts";

/**
 * /campaigns/[id]/posts — Phase 3 content-review list. One row per track
 * where content-verify produced a snapshot (track.content present); that
 * happens at terminal 'verified' OR 'flaked-with-post' states. Tracks
 * flaked from the 14d-no-post timeout have no content snapshot — they
 * appear below in the 'flaked without post' bucket for operator triage.
 *
 * Performance number comes from contentVerifyAgent's 0-100 score; the
 * raw engagement (views/likes/comments/shares) is the snapshot at verify
 * time (the agent's prompt rubric uses both).
 */

function engagementRate(c: CreatorTrackContent): number {
  if (c.views <= 0) return 0;
  return c.likes / c.views;
}

function performanceVariant(score: number): BadgeVariant {
  if (score >= 70) return "emerald";
  if (score >= 50) return "amber";
  return "rose";
}

interface PostRow {
  creatorId: string;
  state: CreatorTrack["state"];
  detectedAt: Date;
  content: CreatorTrackContent;
}

export default async function CampaignPostsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  const { id } = await params;
  const campaign = await campaignRepo.get(id);
  if (!campaign || campaign.brief.workspaceId !== session.workspaceId) notFound();

  const withContent: PostRow[] = campaign.tracks
    .filter((t): t is CreatorTrack & { content: CreatorTrackContent } => Boolean(t.content))
    .map((t) => ({
      creatorId: t.creatorId,
      state: t.state,
      detectedAt: t.content.detectedAt,
      content: t.content,
    }))
    .sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime());

  const flakedNoPost = campaign.tracks.filter((t) => t.state === "flaked" && !t.content);
  const verifiedCount = withContent.filter((r) => r.state === "verified").length;
  const flakedWithPostCount = withContent.filter((r) => r.state === "flaked").length;

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <header className="mb-4">
        <Link
          href={`/campaigns/${id}`}
          className="text-[11px] text-slate-500 hover:text-slate-900"
        >
          ← {campaign.brief.brandProduct.name}
        </Link>
        <div className="mt-2 flex items-end justify-between gap-3">
          <div>
            <SectionLabel>POSTS · {withContent.length} 건</SectionLabel>
            <h1 className="mt-1 text-[22px] font-semibold">
              {campaign.brief.brandProduct.name} 콘텐츠 검증
            </h1>
            <div className="mt-1 text-[12px] text-slate-500">
              목표 {campaign.brief.goals.targetLivePosts} · 검증 완료{" "}
              <span className="text-emerald-700 font-medium">{verifiedCount}</span> ·
              관련성 실패{" "}
              <span className="text-rose-700 font-medium">{flakedWithPostCount}</span> ·
              미게시{" "}
              <span className="text-amber-700 font-medium">{flakedNoPost.length}</span>
            </div>
          </div>
        </div>
      </header>

      {withContent.length === 0 && flakedNoPost.length === 0 ? (
        <Card>
          <CardBody className="text-[13px] text-slate-500 text-center py-12">
            아직 검출된 게시물이 없습니다. tiktok-post-poller가 매일 02:00 UTC에 delivered 상태 트랙의 최근 포스트를 확인합니다.
          </CardBody>
        </Card>
      ) : (
        <>
          {withContent.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-lg overflow-hidden mb-6">
              <table className="w-full text-[13px]">
                <thead className="text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200 bg-slate-50">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">creator</th>
                    <th className="text-left px-3 py-2 font-medium">post</th>
                    <th className="text-left px-3 py-2 font-medium">결과</th>
                    <th className="text-left px-3 py-2 font-medium">performance</th>
                    <th className="text-right px-3 py-2 font-medium">views</th>
                    <th className="text-right px-3 py-2 font-medium">engagement</th>
                    <th className="text-left px-3 py-2 font-medium">flags</th>
                    <th className="text-left px-3 py-2 font-medium">검출</th>
                  </tr>
                </thead>
                <tbody>
                  {withContent.map((row) => {
                    const er = engagementRate(row.content);
                    return (
                      <tr
                        key={`${row.creatorId}-${row.content.postId}`}
                        className="border-b border-slate-100 hover:bg-slate-50/60"
                      >
                        <td className="px-3 py-2.5 mono text-slate-700">{row.creatorId}</td>
                        <td className="px-3 py-2.5 mono text-slate-700">{row.content.postId.slice(0, 18)}</td>
                        <td className="px-3 py-2.5">
                          <Badge variant={row.state === "verified" ? "emerald" : "rose"}>
                            {row.state}
                          </Badge>
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge variant={performanceVariant(row.content.performanceScore)}>
                            {row.content.performanceScore.toFixed(0)} / 100
                          </Badge>
                        </td>
                        <td className="px-3 py-2.5 text-right mono">
                          {row.content.views.toLocaleString()}
                        </td>
                        <td className="px-3 py-2.5 text-right mono">
                          {(er * 100).toFixed(1)}%
                        </td>
                        <td className="px-3 py-2.5">
                          {row.content.flags.length === 0 ? (
                            <span className="text-slate-400">—</span>
                          ) : (
                            <div className="flex flex-wrap gap-1">
                              {row.content.flags.map((f) => (
                                <Badge
                                  key={f}
                                  variant={f === "competitor_mention" || f === "prompt_injection" ? "rose" : "amber"}
                                >
                                  {f}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2.5 mono text-slate-600">
                          {row.detectedAt.toISOString().slice(0, 10)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {flakedNoPost.length > 0 && (
            <Card>
              <CardBody>
                <SectionLabel className="mb-2">14일 내 게시 없음 · {flakedNoPost.length}명</SectionLabel>
                <p className="text-[12px] text-slate-500 mb-3">
                  delivered 상태에서 14일 동안 매칭 포스트가 검출되지 않아 자동으로 'flaked'된 트랙입니다. 운영자가 개별 확인 후 캠페인 정책을 조정하거나 followup outreach 를 보낼 수 있습니다 (Phase 2.5 follow-up).
                </p>
                <ul className="text-[13px] mono text-slate-700 space-y-1">
                  {flakedNoPost.slice(0, 10).map((t) => (
                    <li key={t.creatorId} className="flex justify-between">
                      <span>{t.creatorId}</span>
                      <span className="text-[11px] text-slate-500">
                        last activity {t.lastActivityAt.toISOString().slice(0, 10)}
                      </span>
                    </li>
                  ))}
                  {flakedNoPost.length > 10 && (
                    <li className="text-[11px] text-slate-500">+{flakedNoPost.length - 10}명 더</li>
                  )}
                </ul>
              </CardBody>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
