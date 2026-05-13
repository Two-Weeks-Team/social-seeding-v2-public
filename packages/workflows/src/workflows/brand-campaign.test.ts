import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeMongo, Collections, getDb, campaignRepo } from "@ss/db";
import { memorySink, setObservabilitySink } from "@ss/observability";
import { setUsageStore, type UsageStore } from "@ss/capabilities";
import { type ModelClient } from "@ss/agents";
import type { ApprovalResolvedData, StepLike } from "../gate";
import { brandCampaignHandler, pickShortlist } from "./brand-campaign";

/**
 * WF1 integration: drive brandCampaignHandler end-to-end with a fake step +
 * a context-aware fake ModelClient that dispatches by which agent's system
 * prompt it sees. Real capabilities (workspace.getPolicy + campaignRepo) hit
 * dev-mongo; the agents return final JSON directly (no tool loop) since the
 * tool-loop is already pinned by Chunk-2's agent tests.
 */

const memUsageStore: UsageStore = {
  async increment() { return 1; },
  async decrement() {},
  async getOverride() { return null; },
};

function fakeStep(approvedResolution: ApprovalResolvedData["decision"] = "approved"): { step: StepLike; log: { runs: string[] } } {
  const log = { runs: [] as string[] };
  const step: StepLike = {
    async run(name, fn) {
      log.runs.push(name);
      return fn();
    },
    async sendEvent() {
      return { ids: ["evt"] };
    },
    async waitForEvent<T = ApprovalResolvedData>(name: string, _opts: { event: string; match: string; timeout: string }) {
      const approvalId = name.replace("await-approval:", "");
      const data: ApprovalResolvedData = { approvalId, campaignId: "camp_wf1", decision: approvedResolution };
      return { data: data as unknown as T };
    },
  };
  return { step, log };
}

const baseBrief = {
  workspaceId: "ws_wf1",
  createdBy: "u".repeat(21),
  brandProduct: { name: "Hydra Serum", category: "skincare/serum", description: "수분 세럼", keyClaims: [] },
  targeting: { creatorCount: 1, minEngagementRate: 0.001, languages: ["ko"], hashtags: ["스킨케어"], excludeBlacklist: true },
  logistics: { shipsSamples: true },
  goals: { targetLivePosts: 1, deadline: new Date("2026-08-01") },
};

function candidateOf(uniqueId: string, hashtags: string[]): unknown {
  return {
    creator: {
      id: "id_" + uniqueId, uniqueId, nickname: uniqueId.replace("@", ""), signature: "",
      hashtags, followerCount: 30_000, followingCount: 100, videoCount: 80, heartCount: 1_500_000,
      verified: false, privateAccount: false,
    },
    matchReasons: [`hashtag overlap (${hashtags.join(",")})`],
    flags: [],
  };
}

function fullVettedOf(uniqueId: string, fitScore: number): unknown {
  return {
    ...(candidateOf(uniqueId, ["스킨케어"]) as object),
    fitScore,
    vettedAt: new Date("2026-05-13T12:00:00Z").toISOString(),
  };
}

/**
 * Routes by which agent's system prompt is in the call: sourcing vs. vetting.
 * For vetting, looks up the candidate uniqueId from the prompt to apply the
 * fitScore from `scores`.
 */
function dispatchingFake(scores: Record<string, number>): ModelClient {
  return {
    complete: async ({ system }) => {
      if (system.includes("Sourcing agent")) {
        const text = JSON.stringify({
          candidates: [
            candidateOf("@glow_kr", ["스킨케어"]),
            candidateOf("@dewy_kr", ["스킨케어", "kbeauty"]),
            candidateOf("@minji_skin", ["서울뷰티"]),
          ],
          queriesUsed: ["hashtag:스킨케어", "text:k-beauty hydration"],
          coverageNote: "found 3 in-range; brief wants 1 — comfortable margin",
        });
        return { kind: "text", text, inputTokens: 200, outputTokens: 200 };
      }
      if (system.includes("Vetting agent")) {
        // extract handle from prompt: "Score creator @<uniqueId> for the..."
        // (our fixture uniqueIds already include @, so the agent prompt produces "@@<handle>" — tolerate that)
        const m = system.match(/Score creator @{1,2}(\w+) for/);
        const uniqueId = m ? "@" + m[1] : "@unknown";
        const score = scores[uniqueId] ?? 0.5;
        return { kind: "text", text: JSON.stringify(fullVettedOf(uniqueId, score)), inputTokens: 200, outputTokens: 150 };
      }
      throw new Error("dispatchingFake: unknown agent in system prompt");
    },
  };
}

beforeAll(() => {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI not set — start scripts/dev-mongo + source .mongo-dev/dev-env first");
  }
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.V2_CAMPAIGNS).deleteMany({});
  await db.collection(Collections.V2_APPROVALS).deleteMany({});
  await db.collection(Collections.V2_WORKSPACE_POLICIES).deleteMany({});
  setObservabilitySink(memorySink());
  setUsageStore(memUsageStore);
});

afterEach(() => {
  setObservabilitySink(undefined);
  setUsageStore(undefined);
});

afterAll(async () => {
  await closeMongo();
});

describe("brandCampaignHandler — integration (WF1)", () => {
  it("runs overview → sourcing → vetting fan-out → approveShortlist gate (resolved 'approved')", async () => {
    // Seed a campaign doc so patchStage works.
    const c = await campaignRepo.create({ brief: baseBrief, status: "running", stage: "overview", tracks: [] });
    const event = { data: { campaignId: c.id, brief: baseBrief } };

    const { step, log } = fakeStep("approved");
    const out = await brandCampaignHandler({ event, step }, {
      modelClient: dispatchingFake({ "@glow_kr": 0.82, "@dewy_kr": 0.78, "@minji_skin": 0.66 }),
    });

    expect(out.decision).toBe("approved");
    // P2-C5: after persist-tracks the workflow fans out one creator-track per
    // confirmed creator and advances stage to "outreach".
    expect(out.stage).toBe("outreach");
    // creatorCount=1 → ceil(1*1.5)=2 shortlist max; all 3 are clean (no hard-fail flags) so top 2 by fitScore.
    expect(out.shortlistCount).toBe(2);
    expect(out.trackCount).toBe(2);

    // expected step.run sequence: observability + plan + source + vet-0..2 + approval + persist + advance + fan-out
    expect(log.runs).toContain("observability");
    expect(log.runs).toContain("plan");
    expect(log.runs).toContain("source");
    expect(log.runs.filter((n) => n.startsWith("vet-"))).toHaveLength(3);
    expect(log.runs).toContain("approval:create:shortlist");
    expect(log.runs).toContain("persist-tracks");
    expect(log.runs).toContain("advance-stage-outreach");

    // campaign advanced to "outreach" + tracks upserted with state="shortlisted"
    const persisted = await campaignRepo.get(c.id);
    expect(persisted?.stage).toBe("outreach");
    expect(persisted?.tracks).toHaveLength(2);
    expect(persisted?.tracks.every((t) => t.state === "shortlisted")).toBe(true);
    expect(persisted?.tracks.every((t) => t.emailsSent === 0)).toBe(true);
    // top-2 by fitScore: @glow_kr (0.82) + @dewy_kr (0.78); @minji_skin (0.66) drops
    const creatorIds = new Set(persisted?.tracks.map((t) => t.creatorId));
    expect(creatorIds.has("id_@glow_kr")).toBe(true);
    expect(creatorIds.has("id_@dewy_kr")).toBe(true);
    expect(creatorIds.has("id_@minji_skin")).toBe(false);
  });

  it("rejected resolution → no tracks persisted (WF3)", async () => {
    const c = await campaignRepo.create({ brief: baseBrief, status: "running", stage: "overview", tracks: [] });
    const event = { data: { campaignId: c.id, brief: baseBrief } };
    const { step } = fakeStep("rejected");
    const out = await brandCampaignHandler({ event, step }, {
      modelClient: dispatchingFake({ "@glow_kr": 0.82, "@dewy_kr": 0.78, "@minji_skin": 0.66 }),
    });
    expect(out.decision).toBe("rejected");
    expect(out.trackCount).toBe(0);
    const persisted = await campaignRepo.get(c.id);
    expect(persisted?.tracks).toHaveLength(0);
  });
});

describe("pickShortlist", () => {
  function vetted(uniqueId: string, fitScore: number, flags: string[] = []): { creator: { uniqueId: string; id: string; nickname: string; signature: string; hashtags: string[]; followerCount: number; followingCount: number; videoCount: number; verified: boolean; privateAccount: boolean }; matchReasons: string[]; flags: string[]; fitScore: number; vettedAt?: Date } {
    return {
      creator: { id: "id_" + uniqueId, uniqueId, nickname: uniqueId, signature: "", hashtags: [], followerCount: 0, followingCount: 0, videoCount: 0, verified: false, privateAccount: false },
      matchReasons: [],
      flags,
      fitScore,
    };
  }

  it("sorts by fitScore desc and takes ceil(target*1.5)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = pickShortlist([vetted("@a", 0.5), vetted("@b", 0.9), vetted("@c", 0.7), vetted("@d", 0.6)] as any, 2);
    expect(result.map((c) => c.creator.uniqueId)).toEqual(["@b", "@c", "@d"]); // ceil(2*1.5)=3
  });

  it("drops candidates with hard-fail flags (blacklisted / brand_unsafe / prior_flake)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = pickShortlist([vetted("@high_but_bad", 0.95, ["blacklisted"]), vetted("@unsafe", 0.9, ["brand_unsafe"]), vetted("@ok", 0.6)] as any, 1);
    expect(result.map((c) => c.creator.uniqueId)).toEqual(["@ok"]);
  });
});
