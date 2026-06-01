import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GateConfig } from "@ss/contracts";
import { approvalRepo, closeMongo, Collections, getDb } from "@ss/db";
import {
  ApprovalTimeoutError,
  businessHoursTimeoutString,
  evaluatePredicate,
  gate,
  type ApprovalResolvedData,
  type GateDecision,
  type StepLike,
} from "./gate";

/**
 * WF2 — gate() helper. Tests cover all 3 modes + the 4 predicate axes +
 * timeout. Uses dev-mongo for the approvalRepo round-trip; the step interface
 * is a hand-rolled fake.
 */

interface FakeStepLog {
  runs: string[];
  events: Array<{ name: string; data: unknown }>;
  waits: Array<{ stepName: string; event: string; match: string; timeout: string }>;
}

function fakeStep(
  resolution: { decision: GateDecision; editedPayload?: unknown } | null,
): { step: StepLike; log: FakeStepLog } {
  const log: FakeStepLog = { runs: [], events: [], waits: [] };
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
    async waitForEvent<T = ApprovalResolvedData>(stepName: string, opts: { event: string; match: string; timeout: string }) {
      log.waits.push({ stepName, event: opts.event, match: opts.match, timeout: opts.timeout });
      if (resolution === null) return null as { data: T } | null; // simulate timeout
      const approvalId = stepName.replace("await-approval:", "");
      const data: ApprovalResolvedData = {
        approvalId,
        campaignId: "camp_g",
        decision: resolution.decision,
        ...(resolution.editedPayload !== undefined ? { editedPayload: resolution.editedPayload } : {}),
      };
      return { data: data as unknown as T };
    },
  };
  return { step, log };
}

beforeAll(() => {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI not set — start scripts/dev-mongo + source .mongo-dev/dev-env first");
  }
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.V2_APPROVALS).deleteMany({});
});

afterAll(async () => {
  await closeMongo();
});

const shortlistRec = [
  { creator: { followerCount: 50_000 }, fitScore: 0.82, flags: [] },
  { creator: { followerCount: 80_000 }, fitScore: 0.71, flags: [] },
  { creator: { followerCount: 30_000 }, fitScore: 0.55, flags: [] },
];

const baseOpts = {
  campaignId: "camp_g",
  workspaceId: "ws_g",
  kind: "shortlist" as const,
  recommendation: shortlistRec,
  rationale: "topic + audience overlap",
};

describe("gate() — fast paths (no approval row created)", () => {
  it("mode='auto' returns approved immediately without touching the inbox", async () => {
    const { step, log } = fakeStep(null);
    const config: GateConfig = { mode: "auto" };
    const out = await gate(step, config, baseOpts);
    expect(out).toEqual({ decision: "approved", payload: shortlistRec });
    expect(log.runs).toEqual([]);
    expect(log.events).toEqual([]);
    expect(log.waits).toEqual([]);
  });

  it("mode='auto_unless' + no predicate hit → auto-approves", async () => {
    const { step, log } = fakeStep(null);
    const config: GateConfig = { mode: "auto_unless", escalateIf: { fitScoreLt: 0.3 } };
    const out = await gate(step, config, baseOpts);
    expect(out.decision).toBe("approved");
    expect(log.events).toEqual([]);
  });
});

describe("gate() — slow paths (approval row created + step.waitForEvent)", () => {
  it("mode='auto_unless' + fitScoreLt predicate hits → creates approval + waits + returns resolved", async () => {
    const { step, log } = fakeStep({ decision: "approved" });
    const config: GateConfig = { mode: "auto_unless", escalateIf: { fitScoreLt: 0.6 } };
    const out = await gate(step, config, baseOpts);
    expect(out.decision).toBe("approved");
    // 1 step.run (approval create), 1 sendEvent (inbox notification), 1 waitForEvent
    expect(log.runs).toHaveLength(1);
    expect(log.events).toHaveLength(1);
    expect(log.events[0]?.name).toBe("approval/created");
    expect(log.waits).toHaveLength(1);
    expect(log.waits[0]?.event).toBe("approval/resolved");
    // approval row landed in mongo
    const pending = await approvalRepo.listPendingByWorkspace("ws_g");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe("shortlist");
  });

  it("mode='always_ask' with edited resolution returns the edited payload", async () => {
    const editedShortlist = shortlistRec.slice(0, 2); // human dropped one
    const { step } = fakeStep({ decision: "edited", editedPayload: editedShortlist });
    const config: GateConfig = { mode: "always_ask" };
    const out = await gate(step, config, baseOpts);
    expect(out.decision).toBe("edited");
    expect(out.payload).toEqual(editedShortlist);
  });

  it("timeout (waitForEvent returns null) throws ApprovalTimeoutError when no GateConfig.timeout set", async () => {
    const { step } = fakeStep(null);
    const config: GateConfig = { mode: "always_ask" };
    await expect(gate(step, config, baseOpts)).rejects.toBeInstanceOf(ApprovalTimeoutError);
  });
});

describe("gate() — non-blocking timeout fallback (operator instruction 2026-06-01)", () => {
  it("onTimeout='auto_proceed' + window elapses → approved with the agent recommendation, timedOut=true", async () => {
    const { step, log } = fakeStep(null); // null = the human never resolved
    const config: GateConfig = { mode: "always_ask", timeout: { businessHours: 24, onTimeout: "auto_proceed" } };
    const out = await gate(step, config, baseOpts);
    expect(out.decision).toBe("approved");
    expect(out.payload).toEqual(shortlistRec);
    expect(out.timedOut).toBe(true);
    // an approval row was still opened (the human had a chance) + a bounded wait
    expect(log.events[0]?.name).toBe("approval/created");
    expect(log.waits).toHaveLength(1);
    expect(log.waits[0]?.timeout).not.toBe("7d"); // a computed business-hours window
  });

  it("onTimeout='abandon' + window elapses → rejected, timedOut=true (no external go-ahead)", async () => {
    const { step } = fakeStep(null);
    const config: GateConfig = { mode: "always_ask", timeout: { businessHours: 24, onTimeout: "abandon" } };
    const out = await gate(step, config, baseOpts);
    expect(out.decision).toBe("rejected");
    expect(out.timedOut).toBe(true);
  });

  it("a human resolution before the window beats the fallback (timedOut stays falsy)", async () => {
    const { step } = fakeStep({ decision: "approved" });
    const config: GateConfig = { mode: "always_ask", timeout: { businessHours: 24, onTimeout: "abandon" } };
    const out = await gate(step, config, baseOpts);
    expect(out.decision).toBe("approved");
    expect(out.timedOut).toBeUndefined();
  });
});

describe("businessHoursTimeoutString — weekday-hours, skips weekends", () => {
  it("24 business hours from a Monday 00:00 UTC = 24 real hours", () => {
    // 2026-06-01 is a Monday.
    expect(businessHoursTimeoutString(new Date("2026-06-01T00:00:00Z"), 24)).toBe("24h");
  });

  it("24 business hours opened Friday 12:00 UTC spills across the weekend", () => {
    // 2026-06-05 is a Friday. 12 weekday-hours remain Fri → then Sat/Sun skip
    // → finishes Monday. Elapsed real hours > 24.
    const s = businessHoursTimeoutString(new Date("2026-06-05T12:00:00Z"), 24);
    const hours = Number(s.replace("h", ""));
    expect(hours).toBeGreaterThan(24);
    expect(hours).toBe(12 + 48 + 12); // 12h Fri + 48h weekend + 12h Mon
  });

  it("is capped so a misconfigured huge window can't wait unboundedly", () => {
    const s = businessHoursTimeoutString(new Date("2026-06-01T00:00:00Z"), 100_000);
    expect(Number(s.replace("h", ""))).toBeLessThanOrEqual(24 * 14);
  });
});

describe("evaluatePredicate — covers all 5 axes", () => {
  it("fitScoreLt: array with one below-threshold member trips it", () => {
    expect(evaluatePredicate({ fitScoreLt: 0.6 }, [{ fitScore: 0.7 }, { fitScore: 0.55 }])).toBe(true);
    expect(evaluatePredicate({ fitScoreLt: 0.6 }, [{ fitScore: 0.7 }, { fitScore: 0.65 }])).toBe(false);
  });

  it("followerCountGte: top-level OR nested creator.followerCount", () => {
    expect(evaluatePredicate({ followerCountGte: 100_000 }, { followerCount: 200_000 })).toBe(true);
    expect(evaluatePredicate({ followerCountGte: 100_000 }, { creator: { followerCount: 200_000 } })).toBe(true);
    expect(evaluatePredicate({ followerCountGte: 100_000 }, { followerCount: 50_000 })).toBe(false);
  });

  it("proposedRateUsdGte", () => {
    expect(evaluatePredicate({ proposedRateUsdGte: 500 }, { proposedRateUsd: 800 })).toBe(true);
    expect(evaluatePredicate({ proposedRateUsdGte: 500 }, { proposedRateUsd: 300 })).toBe(false);
  });

  it("replyClassIn", () => {
    expect(evaluatePredicate({ replyClassIn: ["negotiating", "needs_info"] }, { replyClass: "negotiating" })).toBe(true);
    expect(evaluatePredicate({ replyClassIn: ["negotiating"] }, { replyClass: "interested" })).toBe(false);
  });

  it("spamScoreGte", () => {
    expect(evaluatePredicate({ spamScoreGte: 3 }, { spamScore: 5 })).toBe(true);
    expect(evaluatePredicate({ spamScoreGte: 3 }, { spamScore: 1 })).toBe(false);
  });
});
