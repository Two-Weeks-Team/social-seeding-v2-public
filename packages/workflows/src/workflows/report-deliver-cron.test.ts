import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CampaignBrief, CreatorTrack, AnalyticsReport } from "@ss/contracts";
import { campaignRepo, closeMongo, Collections, getDb, reportRepo } from "@ss/db";
import {
  reportDeliverCronHandler,
  STALE_REPORT_THRESHOLD_MS,
  type SendFn,
} from "./report-deliver-cron";

/**
 * P4-C3 — weekly cron tests. Confirms filters:
 *   · running campaigns only (not draft / paused / completed)
 *   · at least one verified track
 *   · last report older than STALE_REPORT_THRESHOLD_MS
 * and that the emitted event carries trigger="cron".
 */

const brief: CampaignBrief = {
  workspaceId: "ws_cron",
  createdBy: "u".repeat(21),
  brandProduct: { name: "X", category: "skincare/serum", description: "x", keyClaims: [] },
  targeting: { creatorCount: 5, minEngagementRate: 0.001, languages: ["ko"], hashtags: [], excludeBlacklist: true },
  logistics: { shipsSamples: true },
  goals: { targetLivePosts: 3, deadline: new Date("2026-06-01T00:00:00Z") },
};

function verifiedTrack(creatorId: string): CreatorTrack {
  return {
    creatorId, stage: "outreach", state: "verified", threadId: `th_${creatorId}`,
    lastActivityAt: new Date(), emailsSent: 1,
    content: {
      postId: `p_${creatorId}`, matches: true, mentionsBrand: true,
      performanceScore: 75, flags: [],
      views: 10_000, likes: 400, comments: 10, shares: 4,
      detectedAt: new Date(),
    },
  };
}

function trackInState(creatorId: string, state: CreatorTrack["state"]): CreatorTrack {
  return {
    creatorId, stage: "outreach", state, threadId: `th_${creatorId}`,
    lastActivityAt: new Date(), emailsSent: 1,
  };
}

function recordingSend(): SendFn & { calls: Array<{ name: string; data: Record<string, unknown> }> } {
  const calls: Array<{ name: string; data: Record<string, unknown> }> = [];
  const fn = (async (payload) => {
    const list = Array.isArray(payload) ? payload : [payload];
    for (const p of list) calls.push(p);
    return { ids: list.map((_, i) => `evt_${calls.length - list.length + i}`) };
  }) as SendFn;
  (fn as SendFn & { calls: typeof calls }).calls = calls;
  return fn as SendFn & { calls: typeof calls };
}

function fakeAnalytics(verifiedCount: number): AnalyticsReport {
  return {
    campaignId: "x", brief: { name: "X", category: "skincare/serum", deadline: new Date() },
    funnel: {
      candidate: 0, shortlisted: 0, outreach_sent: 0, in_conversation: 0,
      agreed: 0, address_collected: 0, shipped: 0, delivered: 0,
      posted: 0, verified: verifiedCount, declined: 0, no_response: 0, flaked: 0,
    },
    goals: {
      targetLivePosts: 3, verifiedCount,
      percentOfGoal: verifiedCount / 3, daysToDeadline: 18, goalMet: verifiedCount >= 3,
    },
    reach: { verifiedViews: 0, verifiedLikes: 0, verifiedComments: 0, verifiedShares: 0, weightedEngagementRate: null },
    performance: { avgPerformanceScore: null, medianPerformanceScore: null, topPerformerCreatorId: null },
    cost: { spentUsd: 0, costPerVerifiedPost: null, budgetUsd: null, percentOfBudget: null },
    tracks: [], flags: [], generatedAt: new Date(),
  };
}

beforeAll(async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set — start scripts/dev-mongo first");
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.V2_CAMPAIGNS).deleteMany({});
  await db.collection(Collections.V2_REPORTS).deleteMany({});
});

afterEach(() => { /* nothing — no global state */ });

afterAll(async () => { await closeMongo(); });

describe("report-deliver-cron", () => {
  it("empty DB → scanned=0, no events", async () => {
    const send = recordingSend();
    const out = await reportDeliverCronHandler(send);
    expect(out).toEqual({
      scanned: 0, requested: 0, skippedRecent: 0, skippedNoVerified: 0, failures: [],
    });
    expect(send.calls).toHaveLength(0);
  });

  it("skips campaigns with status != running", async () => {
    await campaignRepo.create({ brief, status: "draft", stage: "overview", tracks: [] });
    await campaignRepo.create({ brief, status: "paused", stage: "outreach", tracks: [verifiedTrack("c1")] });
    await campaignRepo.create({ brief, status: "completed", stage: "performance", tracks: [verifiedTrack("c1")] });
    const send = recordingSend();
    const out = await reportDeliverCronHandler(send);
    expect(out.scanned).toBe(0); // findRunningCampaigns filters at the Mongo query
    expect(send.calls).toHaveLength(0);
  });

  it("running + verified ≥ 1 + no prior report → emits report/deliver.request(trigger='cron')", async () => {
    const c = await campaignRepo.create({
      brief, status: "running", stage: "performance",
      tracks: [verifiedTrack("c1"), trackInState("c2", "outreach_sent")],
    });
    const send = recordingSend();
    const out = await reportDeliverCronHandler(send);
    expect(out.scanned).toBe(1);
    expect(out.requested).toBe(1);
    expect(out.skippedNoVerified).toBe(0);
    expect(out.skippedRecent).toBe(0);
    expect(send.calls).toHaveLength(1);
    expect(send.calls[0]?.name).toBe("report/deliver.request");
    expect(send.calls[0]?.data).toMatchObject({ campaignId: c.id, trigger: "cron" });
  });

  it("running but 0 verified tracks → skippedNoVerified (no event)", async () => {
    await campaignRepo.create({
      brief, status: "running", stage: "outreach",
      tracks: [trackInState("c1", "outreach_sent"), trackInState("c2", "in_conversation")],
    });
    const send = recordingSend();
    const out = await reportDeliverCronHandler(send);
    expect(out.scanned).toBe(1);
    expect(out.skippedNoVerified).toBe(1);
    expect(out.requested).toBe(0);
    expect(send.calls).toHaveLength(0);
  });

  it("recent report (within staleness floor) → skippedRecent (no event)", async () => {
    const c = await campaignRepo.create({
      brief, status: "running", stage: "performance", tracks: [verifiedTrack("c1")],
    });
    // Persist a report from 2 days ago (well within the 6-day floor)
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await reportRepo.create({
      campaignId: c.id, workspaceId: brief.workspaceId, trigger: "manual",
      analytics: fakeAnalytics(1),
      narrative: {
        summary: "Test summary for cron staleness check — recent report, should be skipped on this run.",
        highlights: [], concerns: [],
        recommendations: ["Wait a week before re-running."],
        markdown: "# X — Campaign Report\n\nRecent report — should be skipped by the cron this run.",
      },
      shareToken: "tok_recent", analystCostUsd: 0, notes: "", generatedAt: twoDaysAgo,
    });
    const send = recordingSend();
    const out = await reportDeliverCronHandler(send);
    expect(out.failures).toEqual([]);
    expect(out.scanned).toBe(1);
    expect(out.skippedRecent).toBe(1);
    expect(out.requested).toBe(0);
    expect(send.calls).toHaveLength(0);
  });

  it("old report (past staleness floor) → fresh request emitted", async () => {
    const c = await campaignRepo.create({
      brief, status: "running", stage: "performance", tracks: [verifiedTrack("c1")],
    });
    // 7 days old → past the 6-day threshold
    const old = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await reportRepo.create({
      campaignId: c.id, workspaceId: brief.workspaceId, trigger: "cron",
      analytics: fakeAnalytics(1),
      narrative: {
        summary: "Test summary from the previous week — should age out and trigger a new run.",
        highlights: [], concerns: [],
        recommendations: ["Re-evaluate after this week's results."],
        markdown: "# X — Campaign Report\n\nLast week's report — past the staleness floor by design.",
      },
      shareToken: "tok_old", analystCostUsd: 0, notes: "", generatedAt: old,
    });
    const send = recordingSend();
    const out = await reportDeliverCronHandler(send);
    expect(out.failures).toEqual([]);
    expect(out.scanned).toBe(1);
    expect(out.requested).toBe(1);
    expect(out.skippedRecent).toBe(0);
    expect(send.calls).toHaveLength(1);
  });

  it("staleness threshold is exactly 6 days (sanity-check the const)", () => {
    expect(STALE_REPORT_THRESHOLD_MS).toBe(6 * 24 * 60 * 60 * 1000);
  });
});
