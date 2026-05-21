import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { closeMongo, Collections, getDb } from "@ss/db";
import { memorySink, setObservabilitySink, startTrace } from "@ss/observability";
import { setUsageStore, type UsageStore } from "@ss/capabilities";
import { runAgent, type AgentRunContext, type ModelClient, type ModelTurn } from "./index";
import { sourcingAgent } from "./sourcing.agent";

/**
 * A-sourcing golden set — 3 (brief, fixture) → expected candidate-count and
 * coverageNote shape scenarios. Pins the agent's plumbing across (a) the
 * comfortable-margin happy case, (b) a tight follower range that narrows the
 * pool, (c) excludeCreatorIds filtering. Real LLM evaluation of query quality
 * is a Phase-1 follow-up (needs GEMINI_API_KEY).
 */

type SourcingOutput = z.infer<typeof sourcingAgent.output>;
type Candidate = SourcingOutput["candidates"][number];

const ctx0 = (): AgentRunContext => ({
  capabilityCtx: { workspaceId: "ws_sg", userId: "u".repeat(21), rateLimitClass: "default" },
  trace: startTrace("camp_source_golden"),
});

const memUsageStore: UsageStore = {
  async increment() { return 1; },
  async decrement() {},
  async getOverride() { return null; },
};

function seedCreator(uniqueId: string, hashtags: string[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "id_" + uniqueId,
    uniqueId,
    nickname: uniqueId.replace("@", ""),
    signature: "",
    hashtags,
    followerCount: 30_000,
    followingCount: 100,
    videoCount: 80,
    heartCount: 1_500_000,
    verified: false,
    privateAccount: false,
    textLanguage: "ko",
    ...over,
  };
}

function asCandidate(uniqueId: string, reason: string, follower = 30_000): Candidate {
  return {
    creator: {
      id: "id_" + uniqueId, uniqueId, nickname: uniqueId.replace("@", ""), signature: "",
      hashtags: ["스킨케어"], followerCount: follower, followingCount: 100, videoCount: 80,
      heartCount: 1_500_000, verified: false, privateAccount: false,
    },
    matchReasons: [reason],
    flags: [],
  };
}

const baseBrief = {
  workspaceId: "ws_sg",
  createdBy: "u".repeat(21),
  brandProduct: { name: "Hydra Serum", category: "skincare/serum", description: "수분 세럼", keyClaims: [] },
  targeting: { creatorCount: 3, minEngagementRate: 0.001, languages: ["ko"], hashtags: ["스킨케어"], excludeBlacklist: true },
  logistics: { shipsSamples: true },
  goals: { targetLivePosts: 3, deadline: new Date("2026-08-01") },
};

beforeAll(() => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set — start scripts/dev-mongo first");
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).deleteMany({});
  await db.collection(Collections.SHARED_BLACKLIST).deleteMany({});
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

function script(uniqueIds: string[], candidates: Candidate[], coverageNote: string): ModelClient {
  const turns: ModelTurn[] = [
    { kind: "tool_use", toolUseId: "s1", toolName: "tiktok.search", toolInput: { query: "스킨케어", mode: "hashtag", languages: ["ko"], limit: 50 }, inputTokens: 80, outputTokens: 12 },
    { kind: "tool_use", toolUseId: "bl", toolName: "blacklist.check", toolInput: { uniqueIds }, inputTokens: 80, outputTokens: 10 },
    {
      kind: "text",
      text: JSON.stringify({
        candidates,
        queriesUsed: ["hashtag:스킨케어"],
        coverageNote,
      }),
      inputTokens: 80,
      outputTokens: 220,
    },
  ];
  let i = 0;
  return {
    complete: async () => {
      const t = turns[Math.min(i++, turns.length - 1)];
      if (!t) throw new Error("script exhausted");
      return t;
    },
  };
}

describe("sourcingAgent — golden set", () => {
  it("comfortable margin: 9 candidates for creatorCount=3 → coverageNote uses 'comfortable margin'", async () => {
    const db = await getDb();
    const ids = ["@a", "@b", "@c", "@d", "@e", "@f", "@g", "@h", "@i"];
    await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).insertMany(ids.map((u) => seedCreator(u, ["스킨케어"])));
    const candidates = ids.map((u) => asCandidate(u, `hashtag #스킨케어 hit (${u})`));
    const out = await runAgent(sourcingAgent, { brief: baseBrief, excludeCreatorIds: [] }, { ...ctx0(), model: script(ids, candidates, "found 9 in-range; brief wants 3 — comfortable margin") });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.value.candidates.length).toBeGreaterThanOrEqual(baseBrief.targeting.creatorCount * 3);
    expect(out.value.coverageNote).toMatch(/comfortable margin/);
  });

  it("tight follower range: agent surfaces only the in-range subset + says 'tight'", async () => {
    const db = await getDb();
    await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).insertMany([
      seedCreator("@small", ["스킨케어"], { followerCount: 500 }),
      seedCreator("@mid", ["스킨케어"], { followerCount: 25_000 }),
      seedCreator("@big", ["스킨케어"], { followerCount: 500_000 }),
    ]);
    const tightBrief = { ...baseBrief, targeting: { ...baseBrief.targeting, followerRange: [10_000, 100_000] as [number, number] } };
    const candidates = [asCandidate("@mid", "in-range follower count", 25_000)];
    const out = await runAgent(sourcingAgent, { brief: tightBrief, excludeCreatorIds: [] }, { ...ctx0(), model: script(["@mid"], candidates, "found 1 in-range; brief wants 3 — tight, consider broader queries") });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.value.candidates.map((c) => c.creator.uniqueId)).toEqual(["@mid"]);
    expect(out.value.coverageNote).toMatch(/tight/);
  });

  it("excludeCreatorIds filtering: agent drops already-used creators from the candidate list", async () => {
    const db = await getDb();
    await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).insertMany([
      seedCreator("@reused", ["스킨케어"]),
      seedCreator("@new1", ["스킨케어"]),
      seedCreator("@new2", ["스킨케어"]),
    ]);
    const candidates = [asCandidate("@new1", "fresh candidate"), asCandidate("@new2", "fresh candidate")];
    const out = await runAgent(sourcingAgent, { brief: baseBrief, excludeCreatorIds: ["id_@reused"] }, { ...ctx0(), model: script(["@reused", "@new1", "@new2"], candidates, "found 2 in-range after exclusion; brief wants 3 — tight") });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    const ids = new Set(out.value.candidates.map((c) => c.creator.uniqueId));
    expect(ids.has("@reused")).toBe(false);
    expect(ids.has("@new1") && ids.has("@new2")).toBe(true);
  });
});
