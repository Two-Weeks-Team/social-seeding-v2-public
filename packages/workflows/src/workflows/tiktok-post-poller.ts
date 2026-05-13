import {
  Events,
  type Campaign,
  type CreatorTrack,
} from "@ss/contracts";
import { campaignRepo, creatorRepo, getDb, Collections } from "@ss/db";
import { getTikTokFetcher, type TikTokFetcher, type TikTokPost } from "@ss/capabilities";
import { inngest } from "../client";

/**
 * tiktok-post-poller — Phase 3 scheduled fn. For every creator-track that's
 * in the `delivered` state (sample shipped + carrier delivered) but doesn't
 * yet have a verified post:
 *
 *   1. Pull the creator's recent posts via the TikTokFetcher seam
 *      (production: RapidAPI; tests: injected fake).
 *   2. Score each post against the campaign brief's hashtags. A "match"
 *      requires at least one campaign hashtag to appear in the post's
 *      hashtags AND the post's createdAt to be on/after the track's
 *      deliveredAt (so we don't flag stale pre-delivery posts).
 *   3. Emit `tiktok/post.detected` for each match — creator-track's
 *      content_review wait awaits this. content-verify agent (P3-C5)
 *      scores the matched post afterwards.
 *   4. Escalation rule: a track in `delivered` for more than `NO_POST_TTL`
 *      days without a detected post → mark the track `flaked` and emit
 *      `creator-track/flaked.escalation` (Phase-3 follow-up; for now the
 *      poller just patches the track state — MC's approval inbox will pick
 *      it up via the campaign view).
 *
 * The poller runs daily at 02:00 UTC. Per-track rate is bounded by
 * `tiktok_read` capability rate-limit; if a workspace has many delivered
 * tracks the poller batches across runs naturally (next day's run picks
 * up whatever didn't get checked today).
 */

/** Days a track can sit in `delivered` without a detected post before we flake it. */
export const NO_POST_TTL_DAYS = 14;

export interface PostPollResult {
  /** Tracks the poller looked at. */
  scanned: number;
  /** New post.detected events emitted. */
  detected: number;
  /** Tracks aged out into `flaked`. */
  flaked: number;
  /** Errors per (campaignId, creatorId). The poller never throws — it logs. */
  failures: Array<{ campaignId: string; creatorId: string; reason: string }>;
}

interface DeliveredTrackContext {
  campaignId: string;
  brief: Campaign["brief"];
  track: CreatorTrack;
  /** When v2_shipments said `delivered`. Drives the TTL + the "post must be after this" check. */
  deliveredAt: Date;
}

/**
 * Surface the set of creator-tracks the poller should examine. Selecting via
 * MongoDB is cheap; we filter at the doc level rather than walking every
 * campaign in the workspace. The track-state `delivered` is the only state
 * eligible to advance into `posted` (content_review).
 */
async function findDeliveredTracks(): Promise<DeliveredTrackContext[]> {
  const db = await getDb();
  // Pull every campaign that has at least one delivered track. campaignRepo
  // doesn't have a "find by track state" yet, so we query the collection
  // directly here (read-only; doesn't expand the repo's contract).
  const cursor = db
    .collection<{ _id: unknown; brief: Campaign["brief"]; tracks: CreatorTrack[] }>(
      Collections.V2_CAMPAIGNS,
    )
    .find({ "tracks.state": "delivered" });
  const out: DeliveredTrackContext[] = [];
  for await (const c of cursor) {
    const campaignId = String(c._id);
    for (const t of c.tracks ?? []) {
      if (t.state !== "delivered") continue;
      // deliveredAt lives on the shipment row, not the track — look it up.
      const shipment = await db
        .collection<{ creatorTrackId: string; deliveredAt?: Date }>(Collections.V2_SHIPMENTS)
        .findOne(
          { creatorTrackId: `${campaignId}:${t.creatorId}`, status: "delivered" },
          { sort: { updatedAt: -1 } },
        );
      const deliveredAt = shipment?.deliveredAt ?? t.lastActivityAt;
      if (deliveredAt) out.push({ campaignId, brief: c.brief, track: t, deliveredAt });
    }
  }
  return out;
}

function dayDiff(later: Date, earlier: Date): number {
  return (later.getTime() - earlier.getTime()) / (24 * 60 * 60 * 1000);
}

/**
 * Did this post likely come from our seeding outreach? Heuristic:
 *   · at least one of the brief's hashtags appears in the post (case-insensitive
 *     compare; leading '#' stripped),
 *   · post.createdAt is on/after the track's deliveredAt (we shipped first).
 *
 * The content-verify agent (P3-C5) is the deeper check that decides if it
 * actually mentions the brand etc. Poller's job is to be liberal-but-bounded
 * so we don't miss matches; the agent narrows.
 */
function matchPost(
  post: TikTokPost,
  briefHashtags: ReadonlyArray<string>,
  deliveredAt: Date,
): { matched: boolean; matchedHashtags: string[] } {
  if (post.createdAt.getTime() < deliveredAt.getTime()) {
    return { matched: false, matchedHashtags: [] };
  }
  const brief = new Set(briefHashtags.map((h) => h.toLowerCase().replace(/^#/, "")));
  const matched = post.hashtags
    .map((h) => h.toLowerCase().replace(/^#/, ""))
    .filter((h) => brief.has(h));
  return { matched: matched.length > 0, matchedHashtags: [...new Set(matched)] };
}

/**
 * The event-emit shape we need from Inngest. Bound from `inngest.send` in
 * production; tests inject a no-op + assertion-friendly recorder.
 */
export type SendFn = (
  payload: { name: string; data: Record<string, unknown> } | Array<{ name: string; data: Record<string, unknown> }>,
) => Promise<unknown>;

/**
 * Pure handler exported for tests — driven by a fake TikTokFetcher and an
 * injectable send function (the production path binds `inngest.send`).
 */
export async function tiktokPostPollerHandler(
  fetcher: TikTokFetcher = getTikTokFetcher(),
  send: SendFn = (payload) => inngest.send(payload as Parameters<typeof inngest.send>[0]),
  now: Date = new Date(),
): Promise<PostPollResult> {
  const result: PostPollResult = { scanned: 0, detected: 0, flaked: 0, failures: [] };
  const tracks = await findDeliveredTracks();
  for (const ctx of tracks) {
    result.scanned++;
    const { campaignId, brief, track, deliveredAt } = ctx;
    try {
      const age = dayDiff(now, deliveredAt);
      // Resolve the TikTok handle. CreatorTrack stores creatorId =
      // TikTokCreator.id (numeric/internal), but TikTokFetcher.getUserPosts
      // takes the @handle/uniqueId. Codex review P1#1 — without this lookup
      // every poll queries the wrong account and every track ages into
      // 'flaked' regardless of whether the creator posted.
      const creator = await creatorRepo.getById(track.creatorId);
      if (!creator) {
        result.failures.push({
          campaignId,
          creatorId: track.creatorId,
          reason: "creator_not_found_in_accounts_tiktok",
        });
        continue;
      }
      const posts = await fetcher.getUserPosts(creator.uniqueId);
      let anyMatch = false;
      for (const p of posts) {
        const { matched, matchedHashtags } = matchPost(p, brief.targeting.hashtags, deliveredAt);
        if (!matched) continue;
        anyMatch = true;
        await send({
          name: Events.TikTokPostDetected,
          data: {
            campaignId,
            creatorTrackId: `${campaignId}:${track.creatorId}`,
            creatorId: track.creatorId,
            postId: p.id,
            desc: p.desc,
            hashtags: p.hashtags,
            views: p.views,
            likes: p.likes,
            comments: p.comments,
            shares: p.shares,
            createdAt: p.createdAt,
            matchedHashtags,
          },
        });
        result.detected++;
      }
      // Aging rule: nothing matched + over the TTL → flake.
      if (!anyMatch && age >= NO_POST_TTL_DAYS) {
        await campaignRepo.upsertTrack(campaignId, { ...track, state: "flaked", lastActivityAt: now });
        result.flaked++;
      }
    } catch (err) {
      result.failures.push({
        campaignId,
        creatorId: track.creatorId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

/**
 * Daily cron, 02:00 UTC. Off-peak relative to Korean creator activity (which
 * peaks evenings local time = 09:00-15:00 UTC); avoids burst-fighting the
 * carrier-poller running at 04:00.
 */
export const tiktokPostPoller = inngest.createFunction(
  { id: "tiktok-post-poller" },
  { cron: "0 2 * * *" },
  () => tiktokPostPollerHandler(),
);
