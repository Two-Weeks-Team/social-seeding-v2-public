import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CampaignBrief } from "@ss/contracts";
import { campaignRepo, closeMongo, Collections, getDb } from "@ss/db";
import type { ApprovalResolvedData, StepLike } from "./gate";
import { CampaignTerminalError, pauseCheck, RESUME_WAIT_TIMEOUT } from "./pause";

/**
 * P6.5 carry-over — pauseCheck() helper. Verifies:
 *   · running    → returns immediately, no wait
 *   · paused     → parks on waitForEvent('campaign/resumed', 30d)
 *   · cancelled  → throws CampaignTerminalError
 *   · completed  → throws CampaignTerminalError
 *   · resume-then-cancel (race window) → throws after the wait
 */

interface StepLog {
  runs: string[];
  waits: Array<{ event: string; timeout: string }>;
}

interface FakeStepOpts {
  /** When true, the simulated waitForEvent returns a resume event payload. */
  resumeFires?: boolean;
  /** Override status reported AFTER the resume event arrives. */
  afterResumeStatus?: "running" | "paused" | "cancelled" | "completed";
}

function fakeStep(opts: FakeStepOpts = {}): { step: StepLike; log: StepLog; setAfterResumeStatus(s: FakeStepOpts["afterResumeStatus"]): void } {
  const log: StepLog = { runs: [], waits: [] };
  let afterResumeStatus = opts.afterResumeStatus;
  const step: StepLike = {
    async run(name, fn) {
      log.runs.push(name);
      return fn();
    },
    async sendEvent() { return { ids: [] }; },
    async waitForEvent<T = ApprovalResolvedData>(_n: string, optsArg: { event: string; timeout: string }) {
      log.waits.push({ event: optsArg.event, timeout: optsArg.timeout });
      return (opts.resumeFires ? { data: {} as unknown as T } : null);
    },
  };
  return {
    step, log,
    setAfterResumeStatus(s) { afterResumeStatus = s; void afterResumeStatus; },
  };
}

const brief: CampaignBrief = {
  workspaceId: "ws_pause",
  createdBy: "u".repeat(21),
  brandProduct: { name: "X", category: "skincare/serum", description: "x", keyClaims: [] },
  targeting: { creatorCount: 2, minEngagementRate: 0.001, languages: ["ko"], hashtags: [], excludeBlacklist: true },
  logistics: { shipsSamples: true },
  goals: { targetLivePosts: 2, deadline: new Date("2026-08-01T00:00:00Z") },
};

beforeAll(async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set");
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.V2_CAMPAIGNS).deleteMany({});
});

afterEach(() => { /* no global state */ });

afterAll(async () => { await closeMongo(); });

describe("pauseCheck", () => {
  it("running campaign → returns immediately; no wait surface hit", async () => {
    const c = await campaignRepo.create({ brief, status: "running", stage: "outreach", tracks: [] });
    const fake = fakeStep();
    await pauseCheck(fake.step, c.id);
    expect(fake.log.runs).toEqual([`pause-check:${c.id}`]);
    expect(fake.log.waits).toEqual([]); // no wait
  });

  it("missing campaign → treated as running (defensive: don't block the workflow on a missing read)", async () => {
    const fake = fakeStep();
    await pauseCheck(fake.step, "6a000000000000000000dead");
    expect(fake.log.waits).toEqual([]);
  });

  it("paused → parks on waitForEvent('campaign/resumed', 30d); proceeds after resume fires", async () => {
    const c = await campaignRepo.create({ brief, status: "paused", stage: "outreach", tracks: [] });
    // After the wait, simulate operator clicking "재개" (the test seed
    // for the SECOND pause-check call mutates status before the call).
    const fake = fakeStep({ resumeFires: true });
    // Patch status to running so the after-resume re-check sees "running"
    // and proceeds.
    await campaignRepo.patchStage(c.id, "outreach", "running");
    // (Now status is running. pauseCheck reads it AT CALL TIME for the
    // first check, which means we still need to simulate the paused
    // state. Easiest: revert + then re-set inside the test below.)
    await campaignRepo.patchStage(c.id, "outreach", "paused");
    // Kick off pauseCheck. The fake step's waitForEvent fires immediately
    // (resumeFires=true); we flip status to running before the second
    // read happens.
    const promise = pauseCheck(fake.step, c.id).then(async () => {
      // After this, the test asserts on the captured log.
    });
    await campaignRepo.patchStage(c.id, "outreach", "running");
    await promise;
    expect(fake.log.waits).toHaveLength(1);
    expect(fake.log.waits[0]?.event).toBe("campaign/resumed");
    expect(fake.log.waits[0]?.timeout).toBe(RESUME_WAIT_TIMEOUT);
    expect(fake.log.waits[0]?.timeout).toBe("30d");
  });

  it("paused + resume + post-resume cancel → throws CampaignTerminalError", async () => {
    const c = await campaignRepo.create({ brief, status: "paused", stage: "outreach", tracks: [] });
    const fake = fakeStep({ resumeFires: true });
    // Operator resumed-then-cancelled in the wait window.
    const promise = pauseCheck(fake.step, c.id);
    await campaignRepo.patchStage(c.id, "outreach", "cancelled");
    await expect(promise).rejects.toBeInstanceOf(CampaignTerminalError);
  });

  it("paused + 30d timeout (waitForEvent returns null) → proceeds (paused stays non-terminal)", async () => {
    const c = await campaignRepo.create({ brief, status: "paused", stage: "outreach", tracks: [] });
    const fake = fakeStep({ resumeFires: false }); // null = timeout
    // First check sees paused → enters wait → wait returns null (30d
    // hit). After-resume check still sees paused. paused is
    // non-terminal so pauseCheck proceeds (returns without throwing).
    // The 30-day cap is documented as a HANDOFF open item.
    await pauseCheck(fake.step, c.id);
    expect(fake.log.waits).toHaveLength(1);
  });

  it("cancelled at the first check → throws immediately; no wait", async () => {
    const c = await campaignRepo.create({ brief, status: "cancelled", stage: "outreach", tracks: [] });
    const fake = fakeStep();
    await expect(pauseCheck(fake.step, c.id)).rejects.toBeInstanceOf(CampaignTerminalError);
    expect(fake.log.waits).toEqual([]);
  });

  it("completed at the first check → throws (workflow shouldn't be still sending)", async () => {
    const c = await campaignRepo.create({ brief, status: "completed", stage: "performance", tracks: [] });
    const fake = fakeStep();
    await expect(pauseCheck(fake.step, c.id)).rejects.toBeInstanceOf(CampaignTerminalError);
  });
});
