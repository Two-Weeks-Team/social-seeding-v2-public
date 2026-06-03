import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusTag, type StatusTone } from "@/components/ui/status-tag";
import { Stat } from "@/components/ui/stat";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { getServerSession } from "@/lib/auth";
import { campaignRepo } from "@ss/db";
import type { CreatorTrack, CreatorTrackContent } from "@ss/contracts";
import { trackState } from "@/lib/labels";
import { fmtNum, creatorLabel } from "@/lib/format";
import { resolveCreators } from "@/lib/creators";

/**
 * /campaigns/[id]/posts — content-review list. One row per track where
 * content-verify produced a snapshot (track.content present); that happens at
 * terminal 'verified' OR 'flaked-with-post' states. Tracks that ended without
 * a post have no content snapshot — they appear below in the "게시 없음" bucket
 * for operator triage.
 *
 * Presentation only — data fetching + filtering preserved verbatim.
 */

function engagementRate(c: CreatorTrackContent): number {
  if (c.views <= 0) return 0;
  return c.likes / c.views;
}

/** 0-100 content-verify score → status tone (color + text + dot, never color alone). */
function scoreTone(score: number): StatusTone {
  if (score >= 70) return "ok";
  if (score >= 50) return "warn";
  return "stop";
}

/** Content-verify flag → operator-readable Korean (never the raw flag code). */
const FLAG_KO: Record<string, { label: string; tone: StatusTone }> = {
  competitor_mention: { label: "경쟁사 언급", tone: "stop" },
  prompt_injection: { label: "프롬프트 조작 의심", tone: "stop" },
  brand_unsafe: { label: "브랜드 부적합", tone: "stop" },
  no_brand_mention: { label: "브랜드 미언급", tone: "warn" },
  off_brief: { label: "브리프 불일치", tone: "warn" },
  low_engagement: { label: "낮은 참여", tone: "warn" },
};
function flagKo(flag: string): { label: string; tone: StatusTone } {
  return FLAG_KO[flag] ?? { label: flag.replace(/_/g, " "), tone: "warn" };
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
  const profiles = await resolveCreators([
    ...withContent.map((r) => r.creatorId),
    ...flakedNoPost.map((t) => t.creatorId),
  ]);

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <header className="mb-6">
        <Link href={`/campaigns/${id}`} className="text-[12px] text-ink-3 hover:text-ink-2">
          ← {campaign.brief.brandProduct.name}
        </Link>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-bold tracking-[-0.01em]">콘텐츠 검증</h1>
            <div className="mt-1 text-[12.5px] text-ink-3">
              {campaign.brief.brandProduct.name} · 게시물 {withContent.length}건 집계
            </div>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 mb-6">
        <Stat
          label="목표 / 검증 완료"
          value={verifiedCount}
          unit={`/ ${campaign.brief.goals.targetLivePosts}`}
          tone={verifiedCount >= campaign.brief.goals.targetLivePosts ? "ok" : "default"}
        />
        <Stat label="관련성 실패" value={flakedWithPostCount} tone={flakedWithPostCount > 0 ? "stop" : "muted"} hint="게시됐으나 브리프 불일치" />
        <Stat label="게시 없음" value={flakedNoPost.length} tone={flakedNoPost.length > 0 ? "stop" : "muted"} hint="기한 내 게시물 미확인" />
        <Stat label="검출된 게시물" value={withContent.length} tone={withContent.length > 0 ? "brand" : "muted"} />
      </div>

      {withContent.length === 0 && flakedNoPost.length === 0 ? (
        <EmptyState
          title="아직 검출된 게시물이 없습니다"
          hint="크리에이터가 게시물을 올리면 자동으로 검증해 여기에 표시됩니다."
        />
      ) : (
        <div className="space-y-6">
          {withContent.length > 0 && (
            <Card>
              <CardBody className="px-0 py-0">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-[0.06em] text-ink-3 font-semibold border-b border-line bg-surface-2">
                      <th className="text-left px-4 py-2.5 font-semibold">크리에이터</th>
                      <th className="text-left px-4 py-2.5 font-semibold">결과</th>
                      <th className="text-left px-4 py-2.5 font-semibold">성과 점수</th>
                      <th className="text-right px-4 py-2.5 font-semibold">조회수</th>
                      <th className="text-right px-4 py-2.5 font-semibold">참여율</th>
                      <th className="text-left px-4 py-2.5 font-semibold">검토 플래그</th>
                      <th className="text-left px-4 py-2.5 font-semibold">검출일</th>
                    </tr>
                  </thead>
                  <tbody>
                    {withContent.map((row) => {
                      const er = engagementRate(row.content);
                      const ts = trackState(row.state);
                      const p = profiles.get(row.creatorId);
                      const display = p?.nickname ?? p?.handle ?? creatorLabel(row.creatorId);
                      const score = row.content.performanceScore;
                      return (
                        <tr
                          key={`${row.creatorId}-${row.content.postId}`}
                          className="border-b border-line-2 last:border-0 hover:bg-surface-2/50"
                        >
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2.5">
                              <Avatar name={display} src={p?.avatar} size="sm" />
                              <div className="min-w-0">
                                <div className="text-ink truncate leading-tight">{display}</div>
                                {p?.handle && p.handle !== display && (
                                  <div className="text-[11px] text-ink-3 mono truncate">{p.handle}</div>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <StatusTag tone={ts.tone} size="sm">{ts.label}</StatusTag>
                          </td>
                          <td className="px-4 py-3">
                            <StatusTag tone={scoreTone(score)} size="sm">{score.toFixed(0)} / 100</StatusTag>
                          </td>
                          <td className="px-4 py-3 text-right mono tnum text-ink">{fmtNum(row.content.views)}</td>
                          <td className="px-4 py-3 text-right mono tnum text-ink-2">{(er * 100).toFixed(1)}%</td>
                          <td className="px-4 py-3">
                            {row.content.flags.length === 0 ? (
                              <span className="text-ink-3">—</span>
                            ) : (
                              <div className="flex flex-wrap gap-1">
                                {row.content.flags.map((f) => {
                                  const fl = flagKo(f);
                                  return (
                                    <StatusTag key={f} tone={fl.tone} size="sm">{fl.label}</StatusTag>
                                  );
                                })}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 mono tnum text-ink-3">
                            {row.detectedAt.toISOString().slice(0, 10)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardBody>
            </Card>
          )}

          {flakedNoPost.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>게시 없이 종료 · {flakedNoPost.length}명</CardTitle>
              </CardHeader>
              <CardBody>
                <p className="text-[12.5px] text-ink-2 mb-3">
                  샘플 수령 후 기한 내 게시물이 확인되지 않아 자동으로 종료된 크리에이터입니다. 개별 확인 후 응답 정책을 조정하거나 다시 안내를 보낼 수 있어요.
                </p>
                <ul className="space-y-1.5">
                  {flakedNoPost.slice(0, 10).map((t) => {
                    const p = profiles.get(t.creatorId);
                    const display = p?.nickname ?? p?.handle ?? creatorLabel(t.creatorId);
                    return (
                      <li key={t.creatorId} className="flex items-center gap-2.5 py-1">
                        <Avatar name={display} src={p?.avatar} size="sm" />
                        <span className="text-[12.5px] text-ink truncate">{display}</span>
                        <span className="ml-auto text-[11px] text-ink-3 mono tnum">
                          마지막 활동 {t.lastActivityAt.toISOString().slice(0, 10)}
                        </span>
                      </li>
                    );
                  })}
                  {flakedNoPost.length > 10 && (
                    <li className="text-[11px] text-ink-3 pt-1">+{flakedNoPost.length - 10}명 더</li>
                  )}
                </ul>
              </CardBody>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
