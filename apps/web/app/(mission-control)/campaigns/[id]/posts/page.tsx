import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusTag, type StatusTone } from "@/components/ui/status-tag";
import { Stat } from "@/components/ui/stat";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { PostThumb } from "@/components/mission-control/post-thumb";
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
 * a post have no content snapshot — they appear below in the "No post" bucket
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

/** Content-verify flag → operator-readable English (never the raw flag code). */
const FLAG_KO: Record<string, { label: string; tone: StatusTone }> = {
  competitor_mention: { label: "Competitor mention", tone: "stop" },
  prompt_injection: { label: "Prompt injection suspected", tone: "stop" },
  brand_unsafe: { label: "Brand unsafe", tone: "stop" },
  no_brand_mention: { label: "No brand mention", tone: "warn" },
  off_brief: { label: "Off brief", tone: "warn" },
  low_engagement: { label: "Low engagement", tone: "warn" },
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
            <h1 className="text-[24px] font-bold tracking-[-0.01em]">Content verification</h1>
            <div className="mt-1 text-[12.5px] text-ink-3">
              {campaign.brief.brandProduct.name} · {withContent.length} posts detected
            </div>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 mb-6">
        <Stat
          label="Goal / verified"
          value={verifiedCount}
          unit={`/ ${campaign.brief.goals.targetLivePosts}`}
          tone={verifiedCount >= campaign.brief.goals.targetLivePosts ? "ok" : "default"}
        />
        <Stat label="Relevance failures" value={flakedWithPostCount} tone={flakedWithPostCount > 0 ? "stop" : "muted"} hint="Posted but off brief" />
        <Stat label="No post" value={flakedNoPost.length} tone={flakedNoPost.length > 0 ? "stop" : "muted"} hint="No post found by deadline" />
        <Stat label="Detected posts" value={withContent.length} tone={withContent.length > 0 ? "brand" : "muted"} />
      </div>

      {withContent.length === 0 && flakedNoPost.length === 0 ? (
        <EmptyState
          title="No detected posts yet"
          hint="When creators publish, posts are verified automatically and shown here."
        />
      ) : (
        <div className="space-y-6">
          {withContent.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {withContent.map((row) => {
                const c = row.content;
                const er = engagementRate(c);
                const ts = trackState(row.state);
                const p = profiles.get(row.creatorId);
                const display = p?.nickname ?? p?.handle ?? creatorLabel(row.creatorId);
                const score = c.performanceScore;
                const cardClass =
                  "group block bg-surface border border-line rounded-2xl overflow-hidden shadow-soft transition-transform hover:-translate-y-0.5";
                const inner = (
                  <>
                    {/* 9:16 cover — the actual posted video, with view count + verify badge */}
                    <div className="relative aspect-[9/16] bg-surface-2 overflow-hidden">
                      <PostThumb src={c.coverImage} className="transition-transform duration-300 group-hover:scale-[1.03]" />
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/55 to-transparent" />
                      <div className="absolute bottom-2 left-2.5 flex items-center gap-1 text-white text-[12px] font-semibold mono tnum [text-shadow:0_1px_2px_rgba(0,0,0,0.6)]">
                        <span aria-hidden>▶</span> {fmtNum(c.views)}
                      </div>
                      <div className="absolute top-2 right-2">
                        <StatusTag tone={ts.tone} size="sm">{ts.label}</StatusTag>
                      </div>
                    </div>
                    {/* footer — creator · score · caption · engagement · review flags */}
                    <div className="p-3">
                      <div className="flex items-center gap-2">
                        <Avatar name={display} src={p?.avatar} size="sm" />
                        <div className="min-w-0 flex-1">
                          <div className="text-[12.5px] text-ink truncate leading-tight">{display}</div>
                          {p?.handle && p.handle !== display && (
                            <div className="text-[11px] text-ink-3 mono truncate">{p.handle}</div>
                          )}
                        </div>
                        <StatusTag tone={scoreTone(score ?? 0)} size="sm">{score != null ? score.toFixed(0) : "—"}</StatusTag>
                      </div>
                      {c.caption && (
                        <p className="mt-2 text-[11.5px] text-ink-2 leading-snug line-clamp-2">{c.caption}</p>
                      )}
                      <div className="mt-2 flex items-center gap-3 text-[11px] text-ink-3 mono tnum">
                        <span>♥ {fmtNum(c.likes)}</span>
                        <span>ER {(er * 100).toFixed(1)}%</span>
                        <span className="ml-auto">{row.detectedAt.toISOString().slice(0, 10)}</span>
                      </div>
                      {c.flags.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {c.flags.map((f) => {
                            const fl = flagKo(f);
                            return (
                              <StatusTag key={f} tone={fl.tone} size="sm">{fl.label}</StatusTag>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </>
                );
                return c.postUrl ? (
                  <a
                    key={`${row.creatorId}-${c.postId}`}
                    href={c.postUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cardClass}
                  >
                    {inner}
                  </a>
                ) : (
                  <div key={`${row.creatorId}-${c.postId}`} className={cardClass}>
                    {inner}
                  </div>
                );
              })}
            </div>
          )}

          {flakedNoPost.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Closed without a post · {flakedNoPost.length}</CardTitle>
              </CardHeader>
              <CardBody>
                <p className="text-[12.5px] text-ink-2 mb-3">
                  These creators were automatically closed because no post was found by the deadline after sample delivery.
                  Review individually, adjust response policy, or send a follow-up.
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
                          Last activity {t.lastActivityAt.toISOString().slice(0, 10)}
                        </span>
                      </li>
                    );
                  })}
                  {flakedNoPost.length > 10 && (
                    <li className="text-[11px] text-ink-3 pt-1">+{flakedNoPost.length - 10} more</li>
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
