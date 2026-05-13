import { describe, expect, it } from "vitest";
import { avgViewsOf, engagementRateOf, influenceScoreOf, rankingScore } from "./score";

/**
 * Pin the v1 ranking formula. Pure functions; no DB, no env vars.
 */
describe("ranking.score (pure)", () => {
  it("avgViewsOf rounds the mean and is 0 for an empty list", () => {
    expect(avgViewsOf([])).toBe(0);
    expect(avgViewsOf([{ views: 100 }, { views: 200 }, { views: 300 }])).toBe(200);
    expect(avgViewsOf([{ views: 1 }, { views: 2 }, { views: 2 }])).toBe(2); // 5/3 = 1.67 → 2
  });

  it("engagementRateOf matches v1 (heartCount / (followerCount × videoCount)), clamped to [0,1]", () => {
    expect(engagementRateOf({ followerCount: 10_000, videoCount: 100, heartCount: 5_000 })).toBeCloseTo(0.005, 6);
    // zeros short-circuit to 0
    expect(engagementRateOf({ followerCount: 0, videoCount: 100, heartCount: 100 })).toBe(0);
    expect(engagementRateOf({ followerCount: 100, videoCount: 0, heartCount: 100 })).toBe(0);
    // hyper-high engagement clamps to 1
    expect(engagementRateOf({ followerCount: 1, videoCount: 1, heartCount: 10_000 })).toBe(1);
  });

  it("influenceScoreOf weights reach·25 + engagement·35 + authority·20 + freshness·20 ∈ [0,100]", () => {
    const now = new Date("2026-05-13T00:00:00Z");
    const fresh = new Date("2026-05-01T00:00:00Z"); // 12 days old → freshness 1.0
    // mid-tier, verified, fresh — should land mid-to-high range
    const score = influenceScoreOf({
      followerCount: 100_000, followingCount: 200, videoCount: 50, heartCount: 500_000,
      verified: true, updatedAt: fresh,
    }, now);
    expect(score).toBeGreaterThan(50);
    expect(score).toBeLessThanOrEqual(100);
    // a brand-new account with no data should be near zero
    const newbie = influenceScoreOf({
      followerCount: 0, followingCount: 0, videoCount: 0, heartCount: 0, verified: false,
    }, now);
    expect(newbie).toBeLessThanOrEqual(5); // only the default freshness contributes (0.2 × 20 = 4)
    // verified flips authority on (+20)
    const unv = influenceScoreOf({
      followerCount: 100_000, followingCount: 0, videoCount: 50, heartCount: 500_000,
      verified: false, updatedAt: fresh,
    }, now);
    const ver = influenceScoreOf({
      followerCount: 100_000, followingCount: 0, videoCount: 50, heartCount: 500_000,
      verified: true, updatedAt: fresh,
    }, now);
    expect(ver - unv).toBe(20);
  });

  it("freshness buckets decay over time (1.0 → 0.6 → 0.3 → 0.1)", () => {
    const now = new Date("2026-05-13T00:00:00Z");
    const base = { followerCount: 0, followingCount: 0, videoCount: 0, heartCount: 0, verified: false };
    const day = 24 * 60 * 60 * 1000;
    const at = (dAgo: number) => new Date(now.getTime() - dAgo * day);
    // only freshness contributes (×20)
    expect(influenceScoreOf({ ...base, updatedAt: at(10) }, now)).toBe(20); // 1.0 × 20
    expect(influenceScoreOf({ ...base, updatedAt: at(45) }, now)).toBe(12); // 0.6 × 20
    expect(influenceScoreOf({ ...base, updatedAt: at(200) }, now)).toBe(6); // 0.3 × 20
    expect(influenceScoreOf({ ...base, updatedAt: at(400) }, now)).toBe(2); // 0.1 × 20
  });
});

describe("ranking.score capability", () => {
  it("happy path: parses input, returns the three derived metrics", async () => {
    const out = await rankingScore.handler(
      {
        creator: { followerCount: 10_000, followingCount: 50, videoCount: 100, heartCount: 5_000, verified: false },
        recentPosts: [
          { views: 100, likes: 0, comments: 0, shares: 0 },
          { views: 300, likes: 0, comments: 0, shares: 0 },
        ],
      },
      { workspaceId: "ws", userId: "u".repeat(21), rateLimitClass: "default" },
    );
    expect(out.avgViews).toBe(200);
    expect(out.engagementRate).toBeCloseTo(0.005, 6);
    expect(out.influenceScore).toBeGreaterThanOrEqual(0);
    expect(out.influenceScore).toBeLessThanOrEqual(100);
  });

  it("error path: input schema rejects a creator missing required fields", () => {
    const r = rankingScore.input.safeParse({ creator: { followerCount: -1 } });
    expect(r.success).toBe(false);
  });
});
