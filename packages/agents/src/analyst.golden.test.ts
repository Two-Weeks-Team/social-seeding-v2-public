import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnalyticsReport, CampaignBrief, ReportFlag } from "@ss/contracts";
import { memorySink, setObservabilitySink, startTrace } from "@ss/observability";
import { setUsageStore, type UsageStore } from "@ss/capabilities";
import { runAgent, type AgentRunContext, type ModelClient } from "./index";
import { analystAgent, type AnalystOutput } from "./analyst.agent";

/**
 * P4-C2 analyst golden set — 4 scenarios pin the narrative the agent
 * should produce for each archetype:
 *   · goal_met        — single concern, forward-looking recs
 *   · underperformed  — multiple concerns, structural recs
 *   · cost_exceeded   — concern + cap-down recommendation
 *   · in_flight       — early-state (no verified yet), recs lean on funnel
 *
 * With a scripted ModelClient: real LLM quality eval is gated on
 * ANTHROPIC_API_KEY (P4 follow-up). What this pins is the output schema
 * + the agent's contract: concerns ≤ fired-flags + 1, recommendations
 * 1..3, summary cites the headline number, markdown starts with the
 * branded H1.
 */

const memUsageStore: UsageStore = {
  async increment() { return 1; },
  async decrement() {},
  async getOverride() { return null; },
};

const ctx0 = (): AgentRunContext => ({
  capabilityCtx: { workspaceId: "ws_ag", userId: "u".repeat(21), rateLimitClass: "default" },
  trace: startTrace("camp_ag"),
});

const brief: CampaignBrief = {
  workspaceId: "ws_ag",
  createdBy: "u".repeat(21),
  brandProduct: { name: "Hydra Serum", category: "skincare/serum", description: "수분 세럼", keyClaims: [] },
  targeting: { creatorCount: 5, minEngagementRate: 0.001, languages: ["ko"], hashtags: ["스킨케어"], excludeBlacklist: true },
  logistics: { shipsSamples: true },
  goals: { targetLivePosts: 3, deadline: new Date("2026-06-01T00:00:00Z"), budgetUsd: 50 },
};

beforeEach(() => {
  setObservabilitySink(memorySink());
  setUsageStore(memUsageStore);
});

afterEach(() => {
  setObservabilitySink(undefined);
  setUsageStore(undefined);
});

function fakeText(out: AnalystOutput): ModelClient {
  return {
    complete: async () => ({
      kind: "text",
      text: JSON.stringify(out),
      inputTokens: 600,
      outputTokens: 280,
    }),
  };
}

function reportWith(opts: {
  verified: number;
  outreach_sent?: number;
  no_response?: number;
  declined?: number;
  flaked?: number;
  spent: number;
  flags: ReportFlag[];
  daysToDeadline?: number;
}): AnalyticsReport {
  const verifiedCount = opts.verified;
  return {
    campaignId: "camp_ag",
    brief: { name: "Hydra Serum", category: "skincare/serum", deadline: new Date("2026-06-01") },
    funnel: {
      candidate: 0, shortlisted: 0,
      outreach_sent: opts.outreach_sent ?? 0,
      in_conversation: 0, agreed: 0, address_collected: 0,
      shipped: 0, delivered: 0, posted: 0,
      verified: verifiedCount,
      declined: opts.declined ?? 0,
      no_response: opts.no_response ?? 0,
      flaked: opts.flaked ?? 0,
    },
    goals: {
      targetLivePosts: 3, verifiedCount,
      percentOfGoal: verifiedCount / 3,
      daysToDeadline: opts.daysToDeadline ?? 18,
      goalMet: verifiedCount >= 3,
    },
    reach: {
      verifiedViews: verifiedCount * 15_000, verifiedLikes: verifiedCount * 800,
      verifiedComments: verifiedCount * 30, verifiedShares: verifiedCount * 12,
      weightedEngagementRate: verifiedCount > 0 ? 0.056 : null,
    },
    performance: {
      avgPerformanceScore: verifiedCount > 0 ? 75 : null,
      medianPerformanceScore: verifiedCount > 0 ? 75 : null,
      topPerformerCreatorId: verifiedCount > 0 ? "id_top" : null,
    },
    cost: {
      spentUsd: opts.spent,
      costPerVerifiedPost: verifiedCount > 0 ? opts.spent / verifiedCount : null,
      budgetUsd: 50,
      percentOfBudget: opts.spent / 50,
    },
    tracks: [],
    flags: opts.flags,
    generatedAt: new Date("2026-05-14"),
  };
}

interface GoldenCase {
  name: string;
  report: AnalyticsReport;
  /** What the operator's narrative SHOULD look like for this archetype. */
  scripted: AnalystOutput;
  /** Properties the validated output must satisfy. */
  assertions: (out: AnalystOutput) => void;
}

const cases: GoldenCase[] = [
  {
    name: "goal_met → win-narrative, 1 fired flag → ≤ 2 concerns",
    report: reportWith({ verified: 3, outreach_sent: 0, declined: 1, spent: 14.20, flags: ["goal_met"] }),
    scripted: {
      summary: "Goal met: 3 / 3 verified posts ahead of deadline, $14.20 of $50 spent.",
      highlights: ["Top performer delivered 75 score and 15k views.", "28% of budget consumed — strong CPL."],
      concerns: ["goal_met fired — codify which creator tier produced these for the next campaign."],
      recommendations: ["Lift target to 5 next campaign — funnel shows headroom.", "Repeat the targeting filter that produced these 3."],
      markdown: "# Hydra Serum — Campaign Report\n\nGoal met • 3/3\n\n## Summary\nGoal met: 3 / 3 verified posts ahead of deadline.",
    },
    assertions: (out) => {
      expect(out.summary).toMatch(/Goal met|3 \/ 3|3\/3/);
      expect(out.concerns.length).toBeLessThanOrEqual(2);
      expect(out.recommendations.length).toBeGreaterThanOrEqual(1);
    },
  },
  {
    name: "underperformed (no_verified_yet + low_response_rate) → multiple concerns",
    report: reportWith({
      verified: 0, outreach_sent: 15, no_response: 10, declined: 1, spent: 8.0,
      flags: ["no_verified_yet", "low_response_rate"],
    }),
    scripted: {
      summary: "0 / 3 verified so far with low reply rate — campaign is behind plan with 18 days remaining.",
      highlights: [],
      concerns: [
        "no_verified_yet — no creator has shipped a verified post yet.",
        "low_response_rate — 1 of 16 contacted creators replied (6%).",
      ],
      recommendations: [
        "Tighten targeting on min engagement rate to filter out unreachable creators.",
        "Re-draft outreach for the next batch — current spam score may be hurting deliverability.",
      ],
      markdown: "# Hydra Serum — Campaign Report\n\nBehind plan • 0/3\n\n## Summary\nBehind plan.",
    },
    assertions: (out) => {
      expect(out.summary).toMatch(/0\s*\/\s*3|behind|low|underperform/i);
      // 2 fired flags → 2 or 3 concerns max (flags + 1 qualitative)
      expect(out.concerns.length).toBeGreaterThanOrEqual(1);
      expect(out.concerns.length).toBeLessThanOrEqual(3);
      expect(out.recommendations.length).toBeGreaterThanOrEqual(1);
    },
  },
  {
    name: "budget_exceeded → concerns include cost callout, recs cap-down",
    report: reportWith({
      verified: 2, outreach_sent: 3, declined: 2, spent: 62, flags: ["budget_exceeded"],
    }),
    scripted: {
      summary: "Over budget: $62 of $50, 2 of 3 verified.",
      highlights: ["Solid 75 avg performance score across verified posts."],
      concerns: ["budget_exceeded — spent $62 against $50 budget (124%)."],
      recommendations: [
        "Cap the next campaign budget at $50 with a hard stop at 5 outreach batches.",
        "Skip the second responder-Opus revision when conversation is straightforward.",
      ],
      markdown: "# Hydra Serum — Campaign Report\n\nOver budget • 2/3\n\n## Summary\nOver budget.",
    },
    assertions: (out) => {
      expect(out.concerns.length).toBeGreaterThanOrEqual(1);
      expect(out.concerns.some((c) => /budget/i.test(c))).toBe(true);
      expect(out.recommendations.length).toBeGreaterThanOrEqual(1);
    },
  },
  {
    name: "in_flight (no verified yet, plenty of time, no flags) → forward-looking recs without concerns",
    report: reportWith({
      verified: 0, outreach_sent: 4, spent: 2.20, flags: [], daysToDeadline: 25,
    }),
    scripted: {
      summary: "Campaign in flight: 4 outreach sent, no verified posts yet — 25 days to deadline.",
      highlights: ["Low spend so far ($2.20) leaves room for a second outreach wave."],
      concerns: [],
      recommendations: [
        "Wait 3 more days for first replies before drawing conclusions.",
        "If no replies by day 5, run a second batch with a different angle.",
      ],
      markdown: "# Hydra Serum — Campaign Report\n\nIn flight • 0/3\n\n## Summary\nIn flight.",
    },
    assertions: (out) => {
      expect(out.concerns).toEqual([]);
      expect(out.recommendations.length).toBeGreaterThanOrEqual(1);
    },
  },
];

describe("analystAgent — golden set", () => {
  for (const c of cases) {
    it(c.name, async () => {
      const out = await runAgent(
        analystAgent,
        { brief, report: c.report, creatorHandles: {} },
        { ...ctx0(), model: fakeText(c.scripted) },
      );
      expect(out.kind).toBe("ok");
      if (out.kind !== "ok") throw new Error("expected ok");
      // Universal contract: summary length, recommendations bounded, markdown branded.
      expect(out.value.summary.length).toBeGreaterThan(20);
      expect(out.value.recommendations.length).toBeGreaterThanOrEqual(1);
      expect(out.value.recommendations.length).toBeLessThanOrEqual(3);
      expect(out.value.markdown).toMatch(/^# Hydra Serum/);
      // Per-case assertions on top of the universal ones.
      c.assertions(out.value);
    });
  }
});
