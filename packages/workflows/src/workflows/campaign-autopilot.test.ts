import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AnalyticsReportSchema, type AnalyticsReport } from "@ss/contracts";
import { campaignRepo, closeMongo, Collections, defaultPolicy, getDb } from "@ss/db";
import { invokeCapability } from "@ss/capabilities";
import { memorySink, setObservabilitySink } from "@ss/observability";
import {
  campaignAutopilotHandler,
  type AutopilotDeps,
} from "./campaign-autopilot";
import { wooriliuCampaignInput, wooriliuExpected } from "../fixtures/wooriliu";
import type { ApprovalResolvedData, GateDecision, StepLike } from "../gate";

/**
 * P3 + P4-C — the autonomous back-half (outreach → shipping → content_review
 * → performance) driven by the REAL 우리리우 2차 fixture (34 influencers /
 * 16 verified posts / 154 emails), against dev-mongo. Proves:
 *   · the 4 stages complete via approveStageAdvance transitions
 *   · the 2 required HITL gates (shipment/content) park + resolve
 *   · analytics.compile auto-completes the `performanceAnalysis` step the
 *     source campaign left `pending` — reproducing the real aggregate reach
 *   · the non-blocking timeout fallback halts shipping on `abandon`
 */

/**
 * Fake Inngest step.
 *  · `humanResolves` = a fixed decision for every parked gate (or null = all time out).
 *  · `timeoutKinds` = approve every parked gate EXCEPT these kinds, which time out
 *    (null wait) — lets a test target one specific gate's timeout fallback.
 */
function fakeStep(
  humanResolves: { decision: GateDecision } | null,
  timeoutKinds: ReadonlySet<string> = new Set(),
): StepLike {
  const pending = new Map<string, string>(); // approvalId → kind
  return {
    async run(name, fn) {
      const out = await fn();
      // approval:create:<kind> returns the approvalId — remember its kind.
      if (name.startsWith("approval:create:") && typeof out === "string") {
        pending.set(out, name.replace("approval:create:", ""));
      }
      return out as never;
    },
    async sendEvent() {
      return { ids: [] };
    },
    async waitForEvent<T = ApprovalResolvedData>(stepName: string) {
      const approvalId = stepName.replace("await-approval:", "");
      const kind = pending.get(approvalId);
      if (humanResolves === null || (kind && timeoutKinds.has(kind))) {
        return null as { data: T } | null; // simulate timeout
      }
      const data: ApprovalResolvedData = { approvalId, campaignId: "wooriliu", decision: humanResolves.decision };
      return { data: data as unknown as T };
    },
  };
}

/** analytics.compile via the registry (same path production uses). */
const compile: NonNullable<AutopilotDeps["compile"]> = async (campaignId, asOf, workspaceId, userId): Promise<AnalyticsReport> => {
  const raw = await invokeCapability(
    "analytics.compile",
    { campaignId, ...(asOf ? { asOf } : {}) },
    { workspaceId, userId, rateLimitClass: "default" },
  );
  return AnalyticsReportSchema.parse(raw);
};

beforeAll(async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set — start scripts/dev-mongo first");
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.V2_CAMPAIGNS).deleteMany({});
  await db.collection(Collections.V2_APPROVALS).deleteMany({});
  await db.collection(Collections.V2_COST_LEDGER).deleteMany({});
  setObservabilitySink(memorySink());
});

afterEach(() => setObservabilitySink(undefined));
afterAll(async () => { await closeMongo(); });

describe("campaign-autopilot — wooriliu fixture, full back-half", () => {
  it("completes outreach → shipping → content_review → performance and reproduces the real aggregate reach", async () => {
    const input = wooriliuCampaignInput();
    const expected = wooriliuExpected();
    const campaign = await campaignRepo.create(input);
    const policy = defaultPolicy(campaign.brief.workspaceId); // autonomous posture (shipment/content always_ask)

    // human approves the 2 required gates the moment they're surfaced
    const step = fakeStep({ decision: "approved" });
    const out = await campaignAutopilotHandler(
      { campaign, policy, step, asOf: new Date("2025-12-01T00:00:00Z") },
      { compile },
    );

    expect(out.kind).toBe("completed");
    if (out.kind !== "completed") throw new Error("expected completed");

    // all 4 back-half stages completed in order
    expect(out.stagesCompleted).toEqual(["outreach", "shipping", "content_review", "performance"]);

    // 3 stage_advance transitions, all auto (default policy), none timed out
    const advances = out.gateLog.filter((g) => g.kind === "stage_advance");
    expect(advances).toHaveLength(3);
    expect(advances.every((g) => g.decision === "approved" && !g.timedOut)).toBe(true);

    // the 3 required HITL gates were resolved by the human (not timed out)
    const budget = out.gateLog.find((g) => g.kind === "budget");
    const shipment = out.gateLog.find((g) => g.kind === "shipment");
    const contentReview = out.gateLog.find((g) => g.kind === "content_review");
    expect(budget?.decision).toBe("approved"); // approveBudget actually invoked
    expect(shipment?.decision).toBe("approved");
    expect(contentReview?.decision).toBe("approved");

    // ── the auto-completed performance analysis reproduces the REAL data ──
    expect(out.report.goals.verifiedCount).toBe(expected.verifiedCount); // 16
    expect(out.report.reach.verifiedViews).toBe(expected.views); // 59,498
    expect(out.report.reach.verifiedLikes).toBe(expected.likes); // 4,554
    expect(out.report.reach.verifiedComments).toBe(expected.comments); // 114
    expect(out.report.reach.verifiedShares).toBe(expected.shares); // 50
    expect(out.report.goals.goalMet).toBe(true); // 16 ≥ target 10
    expect(out.report.flags).toContain("goal_met");

    // campaign row advanced to performance/completed in mongo
    const persisted = await campaignRepo.get(campaign.id);
    expect(persisted?.stage).toBe("performance");
    expect(persisted?.status).toBe("completed");
  });

  it("non-blocking timeout: shipment gate (abandon) halts the flow at shipping — no auto-ship, no forever-block", async () => {
    const campaign = await campaignRepo.create(wooriliuCampaignInput());
    const policy = defaultPolicy(campaign.brief.workspaceId);

    // operator clears budget + outreach, but never resolves the shipment gate →
    // its abandon-timeout fallback fires.
    const step = fakeStep({ decision: "approved" }, new Set(["shipment"]));
    const out = await campaignAutopilotHandler({ campaign, policy, step }, { compile });

    expect(out.kind).toBe("halted");
    if (out.kind !== "halted") throw new Error("expected halted");
    expect(out.haltedAt).toBe("shipping");
    expect(out.stagesCompleted).toEqual(["outreach"]); // got past budget + outreach, stopped at the shipment gate
    const shipment = out.gateLog.find((g) => g.kind === "shipment");
    expect(shipment?.decision).toBe("rejected");
    expect(shipment?.timedOut).toBe(true);
  });

  it("budget gate (abandon) halts before any outreach — no spend committed", async () => {
    const campaign = await campaignRepo.create(wooriliuCampaignInput());
    const policy = defaultPolicy(campaign.brief.workspaceId);
    // budget gate times out (operator never releases budget) → abandon.
    const step = fakeStep({ decision: "approved" }, new Set(["budget"]));
    const out = await campaignAutopilotHandler({ campaign, policy, step }, { compile });
    expect(out.kind).toBe("halted");
    if (out.kind !== "halted") throw new Error("expected halted");
    expect(out.stagesCompleted).toEqual([]); // nothing started
    const budget = out.gateLog.find((g) => g.kind === "budget");
    expect(budget?.decision).toBe("rejected");
    expect(budget?.timedOut).toBe(true);
    // outreach was never reached
    expect(out.gateLog.find((g) => g.kind === "outreach_send")).toBeUndefined();
  });
});
