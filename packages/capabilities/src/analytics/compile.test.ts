import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CampaignBrief, CreatorTrack, CreatorTrackContent } from "@ss/contracts";
import { campaignRepo, closeMongo, Collections, getDb } from "@ss/db";
import { memorySink, setObservabilitySink } from "@ss/observability";
import { analyticsCompile, flagsOf, funnelOf, performanceOf, reachOf } from "./compile";

/**
 * P4-C1 — analytics.compile capability. Tests:
 *   · pure helpers (funnelOf / reachOf / performanceOf / flagsOf) — no DB
 *   · happy path: a campaign with mixed-state tracks → expected rollup
 *   · cost: sums what the injected sink reports
 *   · flags: each rule fires at its threshold and not below
 */

const brief: CampaignBrief = {
  workspaceId: "ws_p4c1",
  createdBy: "u".repeat(21),
  brandProduct: {
    name: "Hydra Serum",
    category: "skincare/serum",
    description: "수분 세럼",
    keyClaims: ["7-day hydration"],
  },
  targeting: {
    creatorCount: 5, minEngagementRate: 0.001, languages: ["ko"],
    hashtags: ["스킨케어"], excludeBlacklist: true,
  },
  logistics: { shipsSamples: true },
  goals: {
    targetLivePosts: 3,
    deadline: new Date("2026-06-01T00:00:00Z"),
    budgetUsd: 100,
  },
};

function track(creatorId: string, state: CreatorTrack["state"], content?: Partial<CreatorTrackContent>): CreatorTrack {
  return {
    creatorId,
    stage: "outreach",
    state,
    threadId: `thread_${creatorId}`,
    lastActivityAt: new Date("2026-05-13T00:00:00Z"),
    emailsSent: 1,
    ...(content ? {
      content: {
        postId: `p_${creatorId}`,
        matches: true,
        mentionsBrand: true,
        performanceScore: content.performanceScore ?? 70,
        flags: content.flags ?? [],
        views: content.views ?? 10_000,
        likes: content.likes ?? 500,
        comments: content.comments ?? 20,
        shares: content.shares ?? 10,
        detectedAt: new Date("2026-05-12T00:00:00Z"),
      } satisfies CreatorTrackContent,
    } : {}),
  };
}

beforeAll(async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set — start scripts/dev-mongo first");
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.V2_CAMPAIGNS).deleteMany({});
  await db.collection(Collections.V2_COST_LEDGER).deleteMany({});
});

afterEach(() => {
  setObservabilitySink(undefined);
});

afterAll(async () => { await closeMongo(); });

describe("analytics.compile — pure helpers", () => {
  it("funnelOf groups tracks by state", () => {
    const tracks = [
      track("a", "outreach_sent"),
      track("b", "outreach_sent"),
      track("c", "verified", { performanceScore: 80 }),
      track("d", "flaked"),
      track("e", "declined"),
    ];
    const f = funnelOf(tracks);
    expect(f.outreach_sent).toBe(2);
    expect(f.verified).toBe(1);
    expect(f.flaked).toBe(1);
    expect(f.declined).toBe(1);
    expect(f.no_response).toBe(0);
  });

  it("reachOf sums verified-track engagement and computes weighted ER", () => {
    const tracks = [
      track("a", "verified", { views: 10_000, likes: 500, comments: 20, shares: 10 }),
      track("b", "verified", { views: 5_000, likes: 200, comments: 10, shares: 5 }),
      track("c", "outreach_sent"), // ignored (no content)
    ];
    const r = reachOf(tracks);
    expect(r.verifiedViews).toBe(15_000);
    expect(r.verifiedLikes).toBe(700);
    expect(r.verifiedComments).toBe(30);
    expect(r.verifiedShares).toBe(15);
    // (700 + 30 + 15) / 15000 ≈ 0.0497
    expect(r.weightedEngagementRate).toBeCloseTo(0.0497, 4);
  });

  it("reachOf returns null weightedEngagementRate when no verified views", () => {
    expect(reachOf([]).weightedEngagementRate).toBeNull();
  });

  it("performanceOf computes mean, median, and top performer", () => {
    const tracks = [
      track("a", "verified", { performanceScore: 60 }),
      track("b", "verified", { performanceScore: 80 }),
      track("c", "verified", { performanceScore: 100 }),
    ];
    const p = performanceOf(tracks);
    expect(p.avgPerformanceScore).toBe(80);
    expect(p.medianPerformanceScore).toBe(80);
    expect(p.topPerformerCreatorId).toBe("c");
  });

  it("performanceOf even-count median averages the middle two", () => {
    const tracks = [
      track("a", "verified", { performanceScore: 50 }),
      track("b", "verified", { performanceScore: 60 }),
      track("c", "verified", { performanceScore: 80 }),
      track("d", "verified", { performanceScore: 100 }),
    ];
    const p = performanceOf(tracks);
    expect(p.medianPerformanceScore).toBe(70); // (60 + 80) / 2
    expect(p.topPerformerCreatorId).toBe("d");
  });

  it("performanceOf returns all-null when no verified tracks", () => {
    const p = performanceOf([track("a", "outreach_sent")]);
    expect(p).toEqual({ avgPerformanceScore: null, medianPerformanceScore: null, topPerformerCreatorId: null });
  });

  it("flagsOf — goal_met fires when verifiedCount ≥ target", () => {
    expect(flagsOf({
      funnel: funnelOf([]), verifiedCount: 3, targetLivePosts: 3,
      daysToDeadline: 5, goalMet: true, percentOfBudget: 0.5, totalTracks: 5,
    })).toContain("goal_met");
  });

  it("flagsOf — budget_exceeded fires above 100%", () => {
    expect(flagsOf({
      funnel: funnelOf([]), verifiedCount: 1, targetLivePosts: 3,
      daysToDeadline: 5, goalMet: false, percentOfBudget: 1.2, totalTracks: 5,
    })).toContain("budget_exceeded");
    expect(flagsOf({
      funnel: funnelOf([]), verifiedCount: 1, targetLivePosts: 3,
      daysToDeadline: 5, goalMet: false, percentOfBudget: 1.0, totalTracks: 5,
    })).not.toContain("budget_exceeded");
  });

  it("flagsOf — deadline_missed fires only when past deadline AND goal not met", () => {
    expect(flagsOf({
      funnel: funnelOf([]), verifiedCount: 1, targetLivePosts: 3,
      daysToDeadline: -3, goalMet: false, percentOfBudget: null, totalTracks: 5,
    })).toContain("deadline_missed");
    // past deadline but goal met → no flag (over-delivered before deadline didn't matter)
    expect(flagsOf({
      funnel: funnelOf([]), verifiedCount: 3, targetLivePosts: 3,
      daysToDeadline: -3, goalMet: true, percentOfBudget: null, totalTracks: 5,
    })).not.toContain("deadline_missed");
  });

  it("flagsOf — low_response_rate requires contacted ≥ 10 AND replied/contacted < 0.10", () => {
    // 9 outreach_sent + 1 declined → 10% reply rate; ≥10 contacted but rate is at threshold, not below
    const ten = funnelOf([
      ...Array.from({ length: 9 }, (_, i) => track(`a${i}`, "outreach_sent")),
      track("b", "declined"),
    ]);
    expect(flagsOf({
      funnel: ten, verifiedCount: 0, targetLivePosts: 3,
      daysToDeadline: 5, goalMet: false, percentOfBudget: null, totalTracks: 10,
    })).not.toContain("low_response_rate");
    // 15 outreach_sent + 1 declined → 1/16 = 6.25% → flag fires
    const sixteen = funnelOf([
      ...Array.from({ length: 15 }, (_, i) => track(`a${i}`, "outreach_sent")),
      track("b", "declined"),
    ]);
    expect(flagsOf({
      funnel: sixteen, verifiedCount: 0, targetLivePosts: 3,
      daysToDeadline: 5, goalMet: false, percentOfBudget: null, totalTracks: 16,
    })).toContain("low_response_rate");
    // small N (< 10 contacted) → never fires regardless of rate
    expect(flagsOf({
      funnel: funnelOf([track("a", "outreach_sent")]),
      verifiedCount: 0, targetLivePosts: 3,
      daysToDeadline: 5, goalMet: false, percentOfBudget: null, totalTracks: 1,
    })).not.toContain("low_response_rate");
  });

  it("flagsOf — high_flake_rate fires above 30% of (shipped+delivered+posted+verified+flaked)", () => {
    const high = funnelOf([
      ...Array.from({ length: 4 }, (_, i) => track(`a${i}`, "flaked")),
      ...Array.from({ length: 5 }, (_, i) => track(`b${i}`, "verified", { performanceScore: 80 })),
    ]);
    expect(flagsOf({
      funnel: high, verifiedCount: 5, targetLivePosts: 3,
      daysToDeadline: 5, goalMet: true, percentOfBudget: null, totalTracks: 9,
    })).toContain("high_flake_rate"); // 4/9 = 44%
  });

  it("flagsOf — no_verified_yet fires when tracks > 0 but verified == 0", () => {
    expect(flagsOf({
      funnel: funnelOf([track("a", "outreach_sent")]),
      verifiedCount: 0, targetLivePosts: 3,
      daysToDeadline: 5, goalMet: false, percentOfBudget: null, totalTracks: 1,
    })).toContain("no_verified_yet");
  });
});

describe("analytics.compile capability — DB round-trip", () => {
  it("happy path: mixed-state campaign → expected funnel + reach + performance + cost", async () => {
    const sink = memorySink();
    setObservabilitySink(sink);
    // Seed cost ledger — CostEntry shape lives in @ss/observability.
    await sink.appendCost({
      campaignId: "TBD", workspaceId: "ws_p4c1",
      agent: "test", model: "gemini-3.1-flash-lite",
      inputTokens: 0, outputTokens: 0,
      usd: 12.5, at: Date.now(),
    });
    // Seed campaign
    const tracks: CreatorTrack[] = [
      track("c1", "verified", { performanceScore: 80, views: 20_000, likes: 800, comments: 30, shares: 12 }),
      track("c2", "verified", { performanceScore: 60, views: 5_000, likes: 200, comments: 8, shares: 3 }),
      track("c3", "outreach_sent"),
      track("c4", "no_response"),
      track("c5", "declined"),
    ];
    const c = await campaignRepo.create({ brief, status: "running", stage: "performance", tracks });
    // Re-tag the cost row to the real campaign id (memorySink filters by id).
    sink.costs.forEach((row) => { row.campaignId = c.id; });

    const r = await analyticsCompile.handler(
      { campaignId: c.id, asOf: new Date("2026-05-14T00:00:00Z") },
      { workspaceId: brief.workspaceId, userId: brief.createdBy, rateLimitClass: "default" },
    );
    expect(r.campaignId).toBe(c.id);
    expect(r.brief.name).toBe("Hydra Serum");
    expect(r.funnel.verified).toBe(2);
    expect(r.funnel.outreach_sent).toBe(1);
    expect(r.funnel.no_response).toBe(1);
    expect(r.funnel.declined).toBe(1);
    expect(r.goals.verifiedCount).toBe(2);
    expect(r.goals.percentOfGoal).toBeCloseTo(2 / 3, 4);
    expect(r.goals.goalMet).toBe(false);
    expect(r.goals.daysToDeadline).toBe(18); // 2026-06-01 - 2026-05-14
    expect(r.reach.verifiedViews).toBe(25_000);
    expect(r.reach.verifiedLikes).toBe(1_000);
    expect(r.performance.avgPerformanceScore).toBe(70);
    expect(r.performance.topPerformerCreatorId).toBe("c1");
    expect(r.cost.spentUsd).toBe(12.5);
    expect(r.cost.budgetUsd).toBe(100);
    expect(r.cost.percentOfBudget).toBeCloseTo(0.125, 4);
    expect(r.cost.costPerVerifiedPost).toBeCloseTo(12.5 / 2, 4);
    expect(r.tracks).toHaveLength(5);
    // generatedAt + flags (no_verified_yet should NOT fire since verifiedCount=2)
    expect(r.flags).not.toContain("no_verified_yet");
    expect(r.flags).not.toContain("budget_exceeded");
  });

  it("empty campaign (no tracks) → zero counts, no_verified_yet NOT flagged (rule needs totalTracks > 0)", async () => {
    setObservabilitySink(memorySink());
    const c = await campaignRepo.create({ brief, status: "draft", stage: "overview", tracks: [] });
    const r = await analyticsCompile.handler(
      { campaignId: c.id, asOf: new Date("2026-05-14T00:00:00Z") },
      { workspaceId: brief.workspaceId, userId: brief.createdBy, rateLimitClass: "default" },
    );
    expect(r.tracks).toHaveLength(0);
    expect(r.goals.verifiedCount).toBe(0);
    expect(r.flags).not.toContain("no_verified_yet");
    expect(r.cost.spentUsd).toBe(0);
    expect(r.cost.costPerVerifiedPost).toBeNull();
    expect(r.reach.weightedEngagementRate).toBeNull();
  });

  it("goal_met flag fires when verifiedCount ≥ targetLivePosts (regardless of deadline)", async () => {
    setObservabilitySink(memorySink());
    const tracks: CreatorTrack[] = [
      track("c1", "verified", { performanceScore: 90 }),
      track("c2", "verified", { performanceScore: 80 }),
      track("c3", "verified", { performanceScore: 70 }),
    ];
    const c = await campaignRepo.create({ brief, status: "running", stage: "performance", tracks });
    const r = await analyticsCompile.handler(
      { campaignId: c.id, asOf: new Date("2026-05-14T00:00:00Z") },
      { workspaceId: brief.workspaceId, userId: brief.createdBy, rateLimitClass: "default" },
    );
    expect(r.goals.goalMet).toBe(true);
    expect(r.flags).toContain("goal_met");
  });

  it("no campaign with that id → throws clearly", async () => {
    setObservabilitySink(memorySink());
    await expect(
      analyticsCompile.handler(
        { campaignId: "6a000000000000000000dead" },
        { workspaceId: brief.workspaceId, userId: brief.createdBy, rateLimitClass: "default" },
      ),
    ).rejects.toThrow(/no campaign with id/);
  });
});
