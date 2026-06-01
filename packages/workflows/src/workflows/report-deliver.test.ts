import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CampaignBrief, CreatorTrack } from "@ss/contracts";
import { campaignRepo, closeMongo, Collections, getDb, reportRepo } from "@ss/db";
import { memorySink, setObservabilitySink } from "@ss/observability";
import { setUsageStore, type UsageStore } from "@ss/capabilities";
import type { ModelClient } from "@ss/agents";
import type { ApprovalResolvedData, StepLike } from "../gate";
import { AnalystEscalatedError, reportDeliverHandler } from "./report-deliver";

/**
 * P4-C3 report-deliver workflow tests. With a fake step + scripted
 * ModelClient + dev-mongo, verify:
 *   · happy path: compile → analyst → persist → emit fires in order
 *   · missing campaign → returns missing_campaign cleanly (no row, no event)
 *   · analyst escalates → returns analyst_escalated (no row, no event)
 *   · deterministic share token via injected generator
 */

const memUsageStore: UsageStore = {
  async increment() { return 1; },
  async decrement() {},
  async getOverride() { return null; },
};

interface StepLog {
  runs: string[];
  events: Array<{ name: string; data: unknown }>;
}

function fakeStep(): { step: StepLike; log: StepLog } {
  const log: StepLog = { runs: [], events: [] };
  const step: StepLike = {
    async run(name, fn) {
      log.runs.push(name);
      return fn();
    },
    async sendEvent(_stepName, payload) {
      const arr = Array.isArray(payload) ? payload : [payload];
      for (const p of arr) log.events.push(p);
      return { ids: arr.map((_, i) => `evt_${log.events.length - arr.length + i}`) };
    },
    async waitForEvent<T = ApprovalResolvedData>(): Promise<{ data: T } | null> {
      return null; // unused in this workflow
    },
  };
  return { step, log };
}

const brief: CampaignBrief = {
  workspaceId: "ws_p4c3",
  createdBy: "u".repeat(21),
  brandProduct: {
    name: "Hydra Serum", category: "skincare/serum",
    description: "수분 세럼", keyClaims: ["7-day hydration"],
  },
  targeting: {
    creatorCount: 5, minEngagementRate: 0.001, languages: ["ko"],
    hashtags: ["스킨케어"], excludeBlacklist: true,
  },
  logistics: { shipsSamples: true },
  goals: { targetLivePosts: 3, deadline: new Date("2026-06-01T00:00:00Z"), budgetUsd: 100 },
};

function verifiedTrack(creatorId: string, score = 80): CreatorTrack {
  return {
    creatorId, stage: "outreach", state: "verified", threadId: `th_${creatorId}`,
    lastActivityAt: new Date(), emailsSent: 1,
    content: {
      postId: `p_${creatorId}`, matches: true, mentionsBrand: true,
      performanceScore: score, flags: [],
      views: 15_000, likes: 700, comments: 25, shares: 10,
      detectedAt: new Date(),
    },
  };
}

/** Scripted analyst output → ModelClient. */
function fakeText(body: object): ModelClient {
  return {
    complete: async () => ({
      kind: "text",
      text: JSON.stringify(body),
      inputTokens: 600, outputTokens: 280,
    }),
  };
}

function happyAnalystOutput() {
  return {
    summary: "Goal met: 3 / 3 verified posts before the deadline, within budget.",
    highlights: ["Top creator delivered 15k views, score 80."],
    concerns: ["goal_met fired — codify the targeting filter for the next campaign."],
    recommendations: ["Lift target to 5 next campaign — funnel showed budget headroom."],
    markdown: "# Hydra Serum — Campaign Report\n\nGoal met • 3/3\n\n## Summary\nGoal met.",
  };
}

beforeAll(async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set — start scripts/dev-mongo first");
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.V2_CAMPAIGNS).deleteMany({});
  await db.collection(Collections.V2_REPORTS).deleteMany({});
  await db.collection(Collections.V2_COST_LEDGER).deleteMany({});
  setObservabilitySink(memorySink());
  setUsageStore(memUsageStore);
});

afterEach(() => {
  setObservabilitySink(undefined);
  setUsageStore(undefined);
});

afterAll(async () => { await closeMongo(); });

describe("report-deliver workflow", () => {
  it("happy path: compile → analyst → persist → emit (in order)", async () => {
    const c = await campaignRepo.create({
      brief, status: "running", stage: "performance",
      tracks: [verifiedTrack("c1", 80), verifiedTrack("c2", 78), verifiedTrack("c3", 76)],
    });
    const fake = fakeStep();
    const out = await reportDeliverHandler(
      { event: { data: { campaignId: c.id, trigger: "manual" } }, step: fake.step },
      {
        modelClient: fakeText(happyAnalystOutput()),
        generateShareToken: () => "DETERMINISTIC_TOKEN_FOR_TEST",
      },
    );
    expect(out.kind).toBe("delivered");
    if (out.kind !== "delivered") throw new Error("expected delivered");

    // Steps fired in pipeline order
    expect(fake.log.runs).toEqual([
      "load-campaign", "compile-analytics", "resolve-handles", "analyst-narrative", "persist-report",
    ]);

    // Persisted row is fetchable and carries the inputs from each stage
    const persisted = await reportRepo.get(out.reportId);
    expect(persisted).toBeTruthy();
    expect(persisted!.campaignId).toBe(c.id);
    expect(persisted!.workspaceId).toBe(brief.workspaceId);
    expect(persisted!.trigger).toBe("manual");
    expect(persisted!.shareToken).toBe("DETERMINISTIC_TOKEN_FOR_TEST");
    expect(persisted!.analytics.goals.verifiedCount).toBe(3);
    expect(persisted!.narrative.summary).toMatch(/Goal met/);

    // The report/delivered event carries the headline numbers
    expect(fake.log.events).toHaveLength(1);
    expect(fake.log.events[0]?.name).toBe("report/delivered");
    const ev = fake.log.events[0]?.data as Record<string, unknown>;
    expect(ev.campaignId).toBe(c.id);
    expect(ev.reportId).toBe(out.reportId);
    expect(ev.verifiedCount).toBe(3);
    expect(ev.targetLivePosts).toBe(3);
    expect(ev.flagsCount).toBe(1); // goal_met
  });

  it("missing campaign id → returns missing_campaign without persisting or emitting", async () => {
    const fake = fakeStep();
    const out = await reportDeliverHandler(
      { event: { data: { campaignId: "6a000000000000000000dead", trigger: "manual" } }, step: fake.step },
      { modelClient: fakeText(happyAnalystOutput()) },
    );
    expect(out).toEqual({ kind: "missing_campaign", campaignId: "6a000000000000000000dead" });
    expect(fake.log.runs).toEqual(["load-campaign"]);
    expect(fake.log.events).toEqual([]);
  });

  it("analyst escalates → THROWS AnalystEscalatedError (codex P2#3); no report row, no event", async () => {
    // The throw makes Inngest's default retry/backoff kick in. Without
    // it, campaign-progression sees stage='performance' but no report
    // row and sits there forever (the campaign never completes).
    const c = await campaignRepo.create({
      brief, status: "running", stage: "performance",
      tracks: [verifiedTrack("c1")],
    });
    const fake = fakeStep();
    await expect(
      reportDeliverHandler(
        { event: { data: { campaignId: c.id, trigger: "cron" } }, step: fake.step },
        { modelClient: fakeText({ escalate: "data internally inconsistent — investigate" }) },
      ),
    ).rejects.toBeInstanceOf(AnalystEscalatedError);
    // Ran compile + analyst, but stopped before persist + emit
    expect(fake.log.runs).toEqual(["load-campaign", "compile-analytics", "resolve-handles", "analyst-narrative"]);
    expect(fake.log.events).toEqual([]);
    // No row persisted
    const latest = await reportRepo.latestForCampaign(c.id);
    expect(latest).toBeNull();
  });

  it("re-running on same campaign appends a NEW row (append-only audit log)", async () => {
    const c = await campaignRepo.create({
      brief, status: "running", stage: "performance", tracks: [verifiedTrack("c1")],
    });
    let n = 0;
    const out1 = await reportDeliverHandler(
      { event: { data: { campaignId: c.id, trigger: "cron" } }, step: fakeStep().step },
      { modelClient: fakeText(happyAnalystOutput()), generateShareToken: () => `tok_${++n}` },
    );
    const out2 = await reportDeliverHandler(
      { event: { data: { campaignId: c.id, trigger: "manual", notes: "second" } }, step: fakeStep().step },
      { modelClient: fakeText(happyAnalystOutput()), generateShareToken: () => `tok_${++n}` },
    );
    expect(out1.kind).toBe("delivered");
    expect(out2.kind).toBe("delivered");
    if (out1.kind !== "delivered" || out2.kind !== "delivered") throw new Error("both should deliver");
    expect(out1.reportId).not.toBe(out2.reportId);

    const all = await reportRepo.listByCampaign(c.id);
    expect(all).toHaveLength(2);
    // listByCampaign returns newest-first
    expect(all[0]?.notes).toBe("second");
    expect(all[1]?.notes).toBe("");
    expect(all[0]?.shareToken).toBe("tok_2");
    expect(all[1]?.shareToken).toBe("tok_1");
  });

  it("notes from the request are persisted on the row", async () => {
    const c = await campaignRepo.create({
      brief, status: "running", stage: "performance", tracks: [verifiedTrack("c1")],
    });
    const out = await reportDeliverHandler(
      {
        event: { data: { campaignId: c.id, trigger: "manual", notes: "End-of-quarter board readout" } },
        step: fakeStep().step,
      },
      { modelClient: fakeText(happyAnalystOutput()) },
    );
    expect(out.kind).toBe("delivered");
    if (out.kind !== "delivered") throw new Error("expected delivered");
    const persisted = await reportRepo.get(out.reportId);
    expect(persisted?.notes).toBe("End-of-quarter board readout");
  });
});
