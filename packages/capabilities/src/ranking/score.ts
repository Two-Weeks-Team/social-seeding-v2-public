/**
 * ranking.score — port of v1's account-ranking math (see
 * ~/social-seeding/docs/current/architecture/ranking-algorithms-design.md and
 * ~/social-seeding/src/lib/calculate-average-views.ts).
 *
 * Pure function: takes a creator profile + their recent posts and returns the
 * three derived metrics the vetting / content-verify / analyst agents read.
 * No I/O — v1's calculate-average-views did a fetch internally; here that fetch
 * is the caller's job (it's the tiktok.getCreator capability), keeping
 * ranking.score deterministic and unit-testable.
 *
 * - avgViews        : mean of recentPosts[].views, rounded.
 * - engagementRate  : heartCount / (followerCount * videoCount), clamped [0,1]
 *                     (the v1 "engagement signal" formula; scaled into [0,1]
 *                     instead of v1's 0-100 % for contract consistency).
 * - influenceScore  : weighted aggregate in [0,100] — reach 25 + engagement 35
 *                     + authority 20 + freshness 20 (the BES weighting in
 *                     ranking-algorithms-design.md §"Algorithm 1").
 */
import { z } from "zod";
import { defineCapability } from "../registry";

export const RankingCreatorSchema = z.object({
  followerCount: z.number().int().nonnegative(),
  followingCount: z.number().int().nonnegative().default(0),
  videoCount: z.number().int().nonnegative(),
  heartCount: z.number().int().nonnegative().default(0),
  verified: z.boolean().default(false),
  updatedAt: z.coerce.date().optional(),
});

export const RankingPostSchema = z.object({
  views: z.number().int().nonnegative(),
  likes: z.number().int().nonnegative().default(0),
  comments: z.number().int().nonnegative().default(0),
  shares: z.number().int().nonnegative().default(0),
  createdAt: z.coerce.date().optional(),
});

export const RankingInputSchema = z.object({
  creator: RankingCreatorSchema,
  recentPosts: z.array(RankingPostSchema).default([]),
});

export const RankingOutputSchema = z.object({
  avgViews: z.number().nonnegative(),
  engagementRate: z.number().min(0).max(1),
  influenceScore: z.number().min(0).max(100),
});

export type RankingCreator = z.infer<typeof RankingCreatorSchema>;
export type RankingPost = z.infer<typeof RankingPostSchema>;
export type RankingResult = z.infer<typeof RankingOutputSchema>;

/** Mean of recent post views, rounded to an integer. Empty list ⇒ 0. */
export function avgViewsOf(posts: ReadonlyArray<{ views: number }>): number {
  if (posts.length === 0) return 0;
  const total = posts.reduce((sum, p) => sum + p.views, 0);
  return Math.round(total / posts.length);
}

/** v1 "engagement signal" — likes per follower per video, clamped to [0,1]. */
export function engagementRateOf(creator: Pick<RankingCreator, "heartCount" | "followerCount" | "videoCount">): number {
  if (creator.followerCount <= 0 || creator.videoCount <= 0) return 0;
  const er = creator.heartCount / (creator.followerCount * creator.videoCount);
  return Math.max(0, Math.min(1, er));
}

/**
 * Influence aggregate, BES-style (v1 Algorithm 1).
 *   reach     : log10(followerCount+1) / 7  · 0 at 0, ≈1 at 10M (cap at 1).
 *   engagement: engagementRateOf(creator) · already in [0,1].
 *   authority : 1 if verified else 0.
 *   freshness : 1 (<30d), 0.6 (30-90d), 0.3 (<1y), 0.1 (older), 0.2 (unknown).
 * score = reach·25 + engagement·35 + authority·20 + freshness·20  ∈ [0,100].
 */
export function influenceScoreOf(creator: RankingCreator, now: Date = new Date()): number {
  const reach = Math.min(1, Math.log10(creator.followerCount + 1) / 7);
  const engagement = engagementRateOf(creator);
  const authority = creator.verified ? 1 : 0;
  let freshness = 0.2;
  if (creator.updatedAt) {
    const ageDays = (now.getTime() - creator.updatedAt.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays < 30) freshness = 1;
    else if (ageDays < 90) freshness = 0.6;
    else if (ageDays < 365) freshness = 0.3;
    else freshness = 0.1;
  }
  return Math.round(reach * 25 + engagement * 35 + authority * 20 + freshness * 20);
}

export const rankingScore = defineCapability({
  name: "ranking.score",
  description:
    "Compute avgViews, engagementRate, and an aggregate influenceScore for a creator from their profile + recent posts. Pure function — no I/O. Vetting, content-verify, and analyst agents all consume this.",
  scope: "read",
  idempotent: true,
  rateLimitClass: "default",
  input: RankingInputSchema,
  output: RankingOutputSchema,
  async handler(input) {
    return {
      avgViews: avgViewsOf(input.recentPosts),
      engagementRate: engagementRateOf(input.creator),
      influenceScore: influenceScoreOf(input.creator),
    };
  },
});
