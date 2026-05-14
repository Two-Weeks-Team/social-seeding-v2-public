import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AnalyticsReport, CampaignBrief, CreatorTrack } from "@ss/contracts";
import { campaignRepo, closeMongo, Collections, getDb, reportRepo } from "@ss/db";
import {
  campaignProgressionHandler,
  type SendFn,
} from "./campaign-progression";

/**
 * P4-C4 — campaign-progression daily cron tests.
 *
 * Covers the 2 transitions + their idempotency:
 *   Transition A: outreach → performance
 *     · all-terminal + verified > 0 ⇒ stage=performance + emit report request
 *     · all-terminal + verified == 0 ⇒ status=completed directly (no report)
 *     · partially terminal ⇒ skipped (still in flight)
 *   Transition B: performance + report exists ⇒ status=completed
 *   Idempotency: re-running on already-completed campaign is a no-op
 */

const brief: CampaignBrief = {
  workspaceId: "ws_progr",
  createdBy: "u".repeat(21),
  brandProduct: { name: "X", category: "skincare/serum", description: "x", keyClaims: [] },
  targeting: { creatorCount: 3, minEngagementRate: 0.001, languages: ["ko"], hashtags: [], excludeBlacklist: true },
  logistics: { shipsSamples: true },
  goals: { targetLivePosts: 2, deadline: new Date("2026-06-01T00:00:00Z") },
};

function track(creatorId: string, state: CreatorTrack["state"]): CreatorTrack {
  const base: CreatorTrack = {
    creatorId, stage: "outreach", state, threadId: `th_${creatorId}`,
    lastActivityAt: new Date(), emailsSent: 1,
  };
  if (state === "verified") {
    base.content = {
      postId: `p_${creatorId}`, matches: true, mentionsBrand: true,
      performanceScore: 75, flags: [],
      views: 12_000, likes: 500, comments: 20, shares: 8,
      detectedAt: new Date(),
    };
  }
  return base;
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
      targetLivePosts: 2, verifiedCount,
      percentOfGoal: verifiedCount / 2, daysToDeadline: 18, goalMet: verifiedCount >= 2,
    },
    reach: { verifiedViews: 0, verifiedLikes: 0, verifiedComments: 0, verifiedShares: 0, weightedEngagementRate: null },
    performance: { avgPerformanceScore: null, medianPerformanceScore: null, topPerformerCreatorId: null },
    cost: { spentUsd: 0, costPerVerifiedPost: null, budgetUsd: null, percentOfBudget: null },
    tracks: [], flags: [], generatedAt: new Date(),
  };
}

async function seedReport(campaignId: string, workspaceId: string): Promise<void> {
  await reportRepo.create({
    campaignId, workspaceId, trigger: "stage_transition",
    analytics: fakeAnalytics(2),
    narrative: {
      summary: "Test summary for campaign-progression — stage_transition path; goal met by margin of N.",
      highlights: [], concerns: [],
      recommendations: ["Repeat the targeting filter that produced these verified creators."],
      markdown: "# X — Campaign Report\n\nGoal met.\n\nDeterministic test fixture for the campaign-progression cron.",
    },
    shareToken: "tok_seed", analystCostUsd: 0, notes: "",
    generatedAt: new Date(),
  });
}

beforeAll(async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set — start scripts/dev-mongo first");
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.V2_CAMPAIGNS).deleteMany({});
  await db.collection(Collections.V2_REPORTS).deleteMany({});
});

afterEach(() => { /* no global state */ });

afterAll(async () => { await closeMongo(); });

describe("campaign-progression — Transition A: outreach → performance", () => {
  it("all-terminal + verified > 0 ⇒ stage='performance' + emit report/deliver.request(stage_transition)", async () => {
    const c = await campaignRepo.create({
      brief, status: "running", stage: "outreach",
      tracks: [
        track("c1", "verified"),
        track("c2", "verified"),
        track("c3", "declined"),
      ],
    });
    const send = recordingSend();
    const out = await campaignProgressionHandler(send);
    expect(out.failures).toEqual([]);
    expect(out.scanned).toBe(1);
    expect(out.reportRequested).toBe(1);
    expect(send.calls).toHaveLength(1);
    expect(send.calls[0]?.name).toBe("report/deliver.request");
    expect(send.calls[0]?.data).toMatchObject({ campaignId: c.id, trigger: "stage_transition" });
    const after = await campaignRepo.get(c.id);
    expect(after?.stage).toBe("performance");
    expect(after?.status).toBe("running"); // not yet completed — waiting for the report
  });

  it("all-terminal + verified == 0 ⇒ status='completed' directly (no report)", async () => {
    const c = await campaignRepo.create({
      brief, status: "running", stage: "outreach",
      tracks: [
        track("c1", "declined"),
        track("c2", "no_response"),
        track("c3", "flaked"),
      ],
    });
    const send = recordingSend();
    const out = await campaignProgressionHandler(send);
    expect(out.failures).toEqual([]);
    expect(out.scanned).toBe(1);
    expect(out.completedNoReport).toBe(1);
    expect(out.reportRequested).toBe(0);
    expect(send.calls).toHaveLength(0); // no report requested when verified == 0
    const after = await campaignRepo.get(c.id);
    expect(after?.stage).toBe("performance");
    expect(after?.status).toBe("completed");
  });

  it("partially terminal (in_conversation still in flight) ⇒ skipped (no transition)", async () => {
    const c = await campaignRepo.create({
      brief, status: "running", stage: "outreach",
      tracks: [
        track("c1", "verified"),
        track("c2", "in_conversation"), // not terminal
        track("c3", "declined"),
      ],
    });
    const send = recordingSend();
    const out = await campaignProgressionHandler(send);
    expect(out.scanned).toBe(1);
    expect(out.skipped).toBe(1);
    expect(out.reportRequested).toBe(0);
    expect(send.calls).toHaveLength(0);
    const after = await campaignRepo.get(c.id);
    expect(after?.stage).toBe("outreach"); // unchanged
    expect(after?.status).toBe("running");
  });

  it("empty tracks list ⇒ skipped (never-started campaign isn't 'done')", async () => {
    const c = await campaignRepo.create({
      brief, status: "running", stage: "outreach", tracks: [],
    });
    const send = recordingSend();
    const out = await campaignProgressionHandler(send);
    expect(out.scanned).toBe(1);
    expect(out.skipped).toBe(1);
    const after = await campaignRepo.get(c.id);
    expect(after?.stage).toBe("outreach");
  });
});

describe("campaign-progression — Transition B: performance + report ⇒ completed", () => {
  it("stage='performance' + report exists ⇒ status='completed'", async () => {
    const c = await campaignRepo.create({
      brief, status: "running", stage: "performance",
      tracks: [track("c1", "verified"), track("c2", "verified")],
    });
    await seedReport(c.id, brief.workspaceId);
    const send = recordingSend();
    const out = await campaignProgressionHandler(send);
    expect(out.failures).toEqual([]);
    expect(out.scanned).toBe(1);
    expect(out.completedAfterReport).toBe(1);
    expect(send.calls).toHaveLength(0); // already at performance — no further event
    const after = await campaignRepo.get(c.id);
    expect(after?.status).toBe("completed");
  });

  it("stage='performance' + NO report yet ⇒ skipped (waiting on report-deliver)", async () => {
    const c = await campaignRepo.create({
      brief, status: "running", stage: "performance",
      tracks: [track("c1", "verified")],
    });
    const send = recordingSend();
    const out = await campaignProgressionHandler(send);
    expect(out.scanned).toBe(1);
    expect(out.skipped).toBe(1);
    const after = await campaignRepo.get(c.id);
    expect(after?.status).toBe("running"); // unchanged
  });
});

describe("campaign-progression — idempotency + skip conditions", () => {
  it("re-running on already-completed campaign skips it (status='completed' filter at the query)", async () => {
    const c = await campaignRepo.create({
      brief, status: "completed", stage: "performance",
      tracks: [track("c1", "verified")],
    });
    await seedReport(c.id, brief.workspaceId);
    const send = recordingSend();
    const out = await campaignProgressionHandler(send);
    expect(out.scanned).toBe(0); // filter excludes status != running
  });

  it("two consecutive runs on the same outreach→performance campaign: first emits request, second skips (now at performance, no report yet)", async () => {
    const c = await campaignRepo.create({
      brief, status: "running", stage: "outreach",
      tracks: [track("c1", "verified")],
    });
    const send1 = recordingSend();
    const out1 = await campaignProgressionHandler(send1);
    expect(out1.reportRequested).toBe(1);
    expect(send1.calls).toHaveLength(1);

    const send2 = recordingSend();
    const out2 = await campaignProgressionHandler(send2);
    // Now at performance + no report row exists yet (report-deliver workflow
    // hasn't processed the emitted event in this unit test).
    expect(out2.skipped).toBe(1);
    expect(out2.reportRequested).toBe(0);
    expect(send2.calls).toHaveLength(0); // does NOT re-emit

    const after = await campaignRepo.get(c.id);
    expect(after?.stage).toBe("performance");
    expect(after?.status).toBe("running");
  });
});
