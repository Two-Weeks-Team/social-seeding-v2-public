import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { closeMongo, Collections, getDb } from "@ss/db";
import { memorySink, setObservabilitySink, startTrace } from "@ss/observability";
import { setTikTokFetcher, setUsageStore, type TikTokFetcher, type UsageStore } from "@ss/capabilities";
import { runAgent, type AgentRunContext, type ModelClient, type ModelTurn } from "./index";
import { vettingAgent } from "./vetting.agent";

/**
 * A-vetting golden set — 3 (brief, creator) → expected fitScore bucket + flags
 * scenarios. With a fake ModelClient these pin the agent's plumbing across
 * diverse inputs; real LLM decision-quality eval needs ANTHROPIC_API_KEY +
 * the full v1 cold-mail style judge tournament (Phase-1 follow-up).
 */

type VettingCandidate = z.infer<typeof vettingAgent.input>["candidate"];
type Flag = VettingCandidate["flags"][number];

const ctx0 = (): AgentRunContext => ({
  capabilityCtx: { workspaceId: "ws_g", userId: "u".repeat(21), rateLimitClass: "default" },
  trace: startTrace("camp_golden_test"),
});

const memUsageStore: UsageStore = {
  async increment() { return 1; },
  async decrement() {},
  async getOverride() { return null; },
};

const fakeFetcher = (posts: Array<{ id: string; views: number; likes: number; comments: number; shares: number; createdAt: Date; desc: string; hashtags: string[] }>): TikTokFetcher => ({
  async getUserInfo(uniqueId: string) {
    return { id: "id_" + uniqueId, uniqueId, nickname: uniqueId, followerCount: 0, followingCount: 0, videoCount: 0 };
  },
  async getUserPosts(_uniqueId: string) {
    return posts;
  },
});

const baseBrief = {
  workspaceId: "ws_g",
  createdBy: "u".repeat(21),
  brandProduct: { name: "Hydra Serum", category: "skincare/serum", description: "수분 세럼", keyClaims: [] },
  targeting: { creatorCount: 3, minEngagementRate: 0.02, languages: ["ko"], hashtags: [], excludeBlacklist: true },
  logistics: { shipsSamples: true },
  goals: { targetLivePosts: 3, deadline: new Date("2026-08-01") },
};

interface Case {
  name: string;
  candidate: VettingCandidate;
  seed: (db: Awaited<ReturnType<typeof getDb>>) => Promise<void>;
  decision: { fitScore: number; flags: Flag[] };
  expectBucket: "high" | "mid" | "low";
  expectFlags: Flag[];
  earlyExit: boolean; // skip getCreator/ranking.score when blacklisted
}

function buildCandidate(uniqueId: string, over: Partial<VettingCandidate["creator"]> = {}): VettingCandidate {
  return {
    creator: {
      id: "id_" + uniqueId, uniqueId, nickname: uniqueId.replace("@", ""),
      signature: "", followerCount: 40_000, followingCount: 100,
      videoCount: 80, heartCount: 1_600_000, verified: false, privateAccount: false,
      hashtags: ["스킨케어"], language: "ko",
      ...over,
    },
    matchReasons: ["topic overlap"],
    flags: [],
  };
}

beforeAll(() => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set — start scripts/dev-mongo first");
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).deleteMany({});
  await db.collection(Collections.SHARED_BLACKLIST).deleteMany({});
  setObservabilitySink(memorySink());
  setUsageStore(memUsageStore);
  setTikTokFetcher(fakeFetcher([
    { id: "p1", desc: "x", hashtags: ["스킨케어"], views: 15_000, likes: 800, comments: 30, shares: 6, createdAt: new Date("2026-05-10") },
  ]));
});

afterEach(() => {
  setObservabilitySink(undefined);
  setUsageStore(undefined);
  setTikTokFetcher(undefined);
});

afterAll(async () => {
  await closeMongo();
});

function scriptFor(candidate: VettingCandidate, decision: Case["decision"], earlyExit: boolean): ModelClient {
  const finalJson = JSON.stringify({
    ...candidate,
    fitScore: decision.fitScore,
    flags: decision.flags,
    vettedAt: new Date("2026-05-13T12:00:00Z").toISOString(),
  });
  const turns: ModelTurn[] = earlyExit
    ? [
        { kind: "tool_use", toolUseId: "t1", toolName: "blacklist.check", toolInput: { uniqueIds: [candidate.creator.uniqueId] }, inputTokens: 60, outputTokens: 8 },
        { kind: "text", text: finalJson, inputTokens: 60, outputTokens: 60 },
      ]
    : [
        { kind: "tool_use", toolUseId: "t1", toolName: "blacklist.check", toolInput: { uniqueIds: [candidate.creator.uniqueId] }, inputTokens: 60, outputTokens: 8 },
        { kind: "tool_use", toolUseId: "t2", toolName: "tiktok.getCreator", toolInput: { uniqueId: candidate.creator.uniqueId, withRecentPosts: true }, inputTokens: 60, outputTokens: 12 },
        {
          kind: "tool_use",
          toolUseId: "t3",
          toolName: "ranking.score",
          toolInput: {
            creator: {
              followerCount: candidate.creator.followerCount,
              followingCount: candidate.creator.followingCount,
              videoCount: candidate.creator.videoCount,
              heartCount: candidate.creator.heartCount,
              verified: false,
            },
            recentPosts: [{ views: 15_000 }],
          },
          inputTokens: 60,
          outputTokens: 25,
        },
        { kind: "text", text: finalJson, inputTokens: 60, outputTokens: 80 },
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

const cases: Case[] = [
  {
    name: "healthy creator → high bucket, clean flags",
    candidate: buildCandidate("@glow_kr"),
    async seed(db) {
      await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).insertOne({
        ...buildCandidate("@glow_kr").creator,
        updatedAt: new Date(),
      });
    },
    decision: { fitScore: 0.82, flags: [] },
    expectBucket: "high",
    expectFlags: [],
    earlyExit: false,
  },
  {
    name: "below engagement floor → mid bucket, below_engagement_floor flag",
    candidate: buildCandidate("@quiet_kr", { heartCount: 1_000 }), // tiny ER
    async seed(db) {
      await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).insertOne({
        ...buildCandidate("@quiet_kr", { heartCount: 1_000 }).creator,
        updatedAt: new Date(),
      });
    },
    decision: { fitScore: 0.55, flags: ["below_engagement_floor"] },
    expectBucket: "mid",
    expectFlags: ["below_engagement_floor"],
    earlyExit: false,
  },
  {
    name: "blacklisted (permanent) → low bucket, blacklisted flag, early exit",
    candidate: buildCandidate("@flaky_kr"),
    async seed(db) {
      await db.collection(Collections.SHARED_BLACKLIST).insertOne({
        uniqueId: "@flaky_kr", isActive: true, reason: "no_content_delivery", severity: "permanent",
      });
    },
    decision: { fitScore: 0.05, flags: ["blacklisted"] },
    expectBucket: "low",
    expectFlags: ["blacklisted"],
    earlyExit: true,
  },
];

describe("vettingAgent — golden set", () => {
  for (const c of cases) {
    it(c.name, async () => {
      const db = await getDb();
      await c.seed(db);
      const ctx = ctx0();
      const out = await runAgent(vettingAgent, { brief: baseBrief, candidate: c.candidate }, { ...ctx, model: scriptFor(c.candidate, c.decision, c.earlyExit) });

      expect(out.kind).toBe("ok");
      if (out.kind !== "ok") throw new Error("expected ok, got: " + JSON.stringify(out));

      // bucket assertion
      const bucket = out.value.fitScore >= 0.7 ? "high" : out.value.fitScore >= 0.4 ? "mid" : "low";
      expect(bucket).toBe(c.expectBucket);

      // flags assertion (set equality)
      expect(new Set(out.value.flags)).toEqual(new Set(c.expectFlags));

      // tool spans match the path the script took
      const toolNames = ctx.trace.spans.filter((s) => s.kind === "tool").map((s) => s.name);
      if (c.earlyExit) {
        expect(toolNames).toEqual(["tool:blacklist.check"]);
      } else {
        expect(toolNames).toEqual(["tool:blacklist.check", "tool:tiktok.getCreator", "tool:ranking.score"]);
      }
    });
  }
});
