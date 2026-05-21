import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnalyticsReport, CampaignBrief } from "@ss/contracts";
import { memorySink, setObservabilitySink, startTrace } from "@ss/observability";
import { setUsageStore, type UsageStore } from "@ss/capabilities";
import { runAgent, type AgentRunContext, type ModelClient } from "./index";
import { analystAgent, type AnalystOutput } from "./analyst.agent";

/**
 * P4-C2 — analyst agent unit tests. No tools (pure text), so testing is:
 * scripted ModelClient → output validates against the schema + the agent
 * cap / model identity hold.
 */

const memUsageStore: UsageStore = {
  async increment() { return 1; },
  async decrement() {},
  async getOverride() { return null; },
};

const ctx0 = (): AgentRunContext => ({
  capabilityCtx: { workspaceId: "ws_an", userId: "u".repeat(21), rateLimitClass: "default" },
  trace: startTrace("camp_an"),
});

const brief: CampaignBrief = {
  workspaceId: "ws_an",
  createdBy: "u".repeat(21),
  brandProduct: {
    name: "Hydra Serum",
    category: "skincare/serum",
    description: "수분 세럼",
    keyClaims: ["7-day hydration"],
  },
  targeting: {
    creatorCount: 5,
    minEngagementRate: 0.001,
    languages: ["ko"],
    hashtags: ["스킨케어"],
    excludeBlacklist: true,
  },
  logistics: { shipsSamples: true },
  goals: {
    targetLivePosts: 3,
    deadline: new Date("2026-06-01T00:00:00Z"),
    budgetUsd: 100,
  },
};

const happyReport: AnalyticsReport = {
  campaignId: "camp_an_1",
  brief: { name: "Hydra Serum", category: "skincare/serum", deadline: new Date("2026-06-01") },
  funnel: {
    candidate: 0, shortlisted: 0, outreach_sent: 1, in_conversation: 0,
    agreed: 0, address_collected: 0, shipped: 0, delivered: 0,
    posted: 0, verified: 3, declined: 1, no_response: 0, flaked: 0,
  },
  goals: { targetLivePosts: 3, verifiedCount: 3, percentOfGoal: 1.0, daysToDeadline: 18, goalMet: true },
  reach: {
    verifiedViews: 60_000, verifiedLikes: 3_200, verifiedComments: 110, verifiedShares: 45,
    weightedEngagementRate: 0.0559,
  },
  performance: { avgPerformanceScore: 78, medianPerformanceScore: 80, topPerformerCreatorId: "id_freshly" },
  cost: { spentUsd: 14.20, costPerVerifiedPost: 4.73, budgetUsd: 100, percentOfBudget: 0.142 },
  tracks: [
    { creatorId: "id_freshly", state: "verified", lastActivityAt: new Date(), threadId: "th1", performanceScore: 80, views: 28_000 },
    { creatorId: "id_dewy", state: "verified", lastActivityAt: new Date(), threadId: "th2", performanceScore: 78, views: 20_000 },
    { creatorId: "id_glow", state: "verified", lastActivityAt: new Date(), threadId: "th3", performanceScore: 76, views: 12_000 },
    { creatorId: "id_skip", state: "declined", lastActivityAt: new Date(), threadId: "th4", performanceScore: null, views: null },
    { creatorId: "id_pending", state: "outreach_sent", lastActivityAt: new Date(), threadId: "th5", performanceScore: null, views: null },
  ],
  flags: ["goal_met"],
  generatedAt: new Date("2026-05-14"),
};

beforeEach(() => {
  setObservabilitySink(memorySink());
  setUsageStore(memUsageStore);
});

afterEach(() => {
  setObservabilitySink(undefined);
  setUsageStore(undefined);
});

function fakeText(out: AnalystOutput | { escalate: string }): ModelClient {
  return {
    complete: async () => ({
      kind: "text",
      text: JSON.stringify(out),
      inputTokens: 600,
      outputTokens: 280,
    }),
  };
}

describe("analystAgent — unit", () => {
  it("happy path: goal_met campaign → summary + highlights + 1 concern per flag + recommendations + markdown", async () => {
    const out = await runAgent(
      analystAgent,
      {
        brief,
        report: happyReport,
        creatorHandles: { id_freshly: "@freshly", id_dewy: "@dewy", id_glow: "@glow" },
      },
      {
        ...ctx0(),
        model: fakeText({
          summary: "Goal met: 3 / 3 verified posts before the deadline, well under budget. @freshly drove the strongest single post (28k views, score 80).",
          highlights: [
            "@freshly hit 28,000 views — score 80, top performer.",
            "Cost-efficient: $4.73 per verified post against a $100 budget.",
          ],
          concerns: [
            "goal_met fired — track which creator tier consistently delivers so the next campaign can target it directly.",
          ],
          recommendations: [
            "Repeat with 5 verified-quality creators next campaign instead of 5 unfiltered.",
            "Lift target to 5 live posts — current funnel showed headroom on budget.",
          ],
          markdown: [
            "# Hydra Serum — Campaign Report",
            "",
            "Goal met • 3/3 verified • $14.20 of $100 spent",
            "",
            "## Summary",
            "Goal met: 3 / 3 verified posts before the deadline, well under budget. @freshly drove the strongest single post (28k views, score 80).",
            "",
            "## What worked",
            "- @freshly hit 28,000 views — score 80, top performer.",
            "- Cost-efficient: $4.73 per verified post against a $100 budget.",
            "",
            "## Next campaign",
            "- Repeat with 5 verified-quality creators next campaign instead of 5 unfiltered.",
            "- Lift target to 5 live posts — current funnel showed headroom on budget.",
            "",
            "## Numbers",
            "| Metric | Value |",
            "|---|---|",
            "| Verified posts | 3 / 3 |",
            "| Reach | 60,000 views |",
            "| Cost | $14.20 / $100 |",
          ].join("\n"),
        }),
      },
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.value.summary).toMatch(/3 \/ 3|3\/3/);
    expect(out.value.highlights.length).toBeGreaterThanOrEqual(1);
    // 1 fired flag → ≤ 1+1 concerns
    expect(out.value.concerns.length).toBeLessThanOrEqual(2);
    expect(out.value.recommendations.length).toBeGreaterThanOrEqual(1);
    expect(out.value.recommendations.length).toBeLessThanOrEqual(3);
    expect(out.value.markdown).toMatch(/^# Hydra Serum/);
  });

  it("escalation: scripted escalate is honored by runAgent", async () => {
    const out = await runAgent(
      analystAgent,
      { brief, report: happyReport, creatorHandles: {} },
      {
        ...ctx0(),
        model: fakeText({ escalate: "report data is internally inconsistent — verified=3 but verifiedViews=0" }),
      },
    );
    expect(out.kind).toBe("escalate");
    if (out.kind !== "escalate") throw new Error("expected escalate");
    expect(out.reason).toMatch(/inconsistent/);
  });

  it("agent definition: Gemini 3.1 Flash-Lite, no tools, ≤$0.10 cap", () => {
    expect(analystAgent.model).toBe("gemini-3.1-flash-lite");
    expect(analystAgent.tools).toEqual([]);
    expect(analystAgent.maxUsd).toBeLessThanOrEqual(0.1);
  });
});
