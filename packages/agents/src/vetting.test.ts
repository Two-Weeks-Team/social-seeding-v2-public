import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { closeMongo, Collections, getDb } from "@ss/db";
import { memorySink, setObservabilitySink, startTrace } from "@ss/observability";
import { setTikTokFetcher, setUsageStore, type TikTokFetcher, type UsageStore } from "@ss/capabilities";
import { runAgent, type AgentRunContext, type ModelClient, type ModelTurn } from "./index";
import { vettingAgent } from "./vetting.agent";

type VettingInput = z.infer<typeof vettingAgent.input>;
type VettingCandidate = VettingInput["candidate"];

/**
 * A-vetting unit tests: drive the agent through its real flow with a scripted
 * fake ModelClient against seeded dev-mongo fixtures. No API keys needed —
 * tiktok.getCreator uses the injected fetcher, blacklist.check + ranking.score
 * are credential-free.
 */

const ctx0 = (): AgentRunContext => ({
  capabilityCtx: { workspaceId: "ws_v", userId: "u".repeat(21), rateLimitClass: "default" },
  trace: startTrace("camp_vet_test"),
});

function inMemoryUsageStore(): UsageStore {
  const counts = new Map<string, number>();
  const key = (s: string, id: string, a: string, m: string): string => `${s}|${id}|${a}|${m}`;
  return {
    async increment(scope, scopeId, action, month) {
      const k = key(scope, scopeId, action, month);
      const next = (counts.get(k) ?? 0) + 1;
      counts.set(k, next);
      return next;
    },
    async decrement(scope, scopeId, action, month) {
      const k = key(scope, scopeId, action, month);
      counts.set(k, Math.max(0, (counts.get(k) ?? 0) - 1));
    },
    async getOverride() {
      return null;
    },
  };
}

const fakeFetcher = (posts: Array<{ id: string; desc: string; hashtags: string[]; views: number; likes: number; comments: number; shares: number; createdAt: Date }>): TikTokFetcher => ({
  async getUserInfo(uniqueId: string) {
    // not used in these tests (cache hits via seeded accounts_tiktok)
    return { id: "id_" + uniqueId, uniqueId, nickname: uniqueId, followerCount: 0, followingCount: 0, videoCount: 0 };
  },
  async getUserPosts(_uniqueId: string) {
    return posts;
  },
});

const ALL_POSTS = [
  { id: "p1", desc: "수분 한 방울로 톡톡", hashtags: ["스킨케어"], views: 14_000, likes: 800, comments: 30, shares: 6, createdAt: new Date("2026-05-10") },
  { id: "p2", desc: "데일리 글로우 세럼 리뷰",   hashtags: ["serum"],     views: 18_000, likes: 950, comments: 41, shares: 9, createdAt: new Date("2026-05-08") },
];

const brief = {
  workspaceId: "ws_v",
  createdBy: "u".repeat(21),
  brandProduct: { name: "Hydra Serum", category: "skincare/serum", description: "수분 세럼", keyClaims: [] },
  targeting: { creatorCount: 3, minEngagementRate: 0.02, languages: ["ko"], hashtags: [], excludeBlacklist: true },
  logistics: { shipsSamples: true },
  goals: { targetLivePosts: 3, deadline: new Date("2026-08-01") },
};

const baseCandidate: VettingCandidate = {
  creator: {
    id: "id_glow", uniqueId: "@glow_kr", nickname: "glow",
    signature: "k-beauty / 수분", followerCount: 42_000, followingCount: 110,
    videoCount: 84, heartCount: 1_800_000, verified: false, privateAccount: false,
    hashtags: ["스킨케어"], language: "ko",
  },
  matchReasons: ["bio mentions 수분", "k-beauty topic overlap"],
  flags: [],
};

beforeAll(() => {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI not set — start scripts/dev-mongo + source .mongo-dev/dev-env first");
  }
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).deleteMany({});
  await db.collection(Collections.SHARED_BLACKLIST).deleteMany({});
  setObservabilitySink(memorySink());
  setUsageStore(inMemoryUsageStore());
  setTikTokFetcher(fakeFetcher(ALL_POSTS));
});

afterEach(() => {
  setObservabilitySink(undefined);
  setUsageStore(undefined);
  setTikTokFetcher(undefined);
});

afterAll(async () => {
  await closeMongo();
});

/**
 * Build a fake ModelClient that drives vetting through:
 *   blacklist.check → tiktok.getCreator → ranking.score → final JSON
 * The final JSON merges the input candidate with `decision`.
 */
function vettingScript(decision: { fitScore: number; flags: string[] }): ModelClient {
  const finalJson = JSON.stringify({
    ...baseCandidate,
    fitScore: decision.fitScore,
    flags: decision.flags,
    vettedAt: new Date("2026-05-13T12:00:00Z").toISOString(),
  });
  const turns: ModelTurn[] = [
    { kind: "tool_use", toolUseId: "t1", toolName: "blacklist.check", toolInput: { uniqueIds: ["@glow_kr"] }, inputTokens: 60, outputTokens: 10 },
    { kind: "tool_use", toolUseId: "t2", toolName: "tiktok.getCreator", toolInput: { uniqueId: "@glow_kr", withRecentPosts: true }, inputTokens: 60, outputTokens: 12 },
    {
      kind: "tool_use",
      toolUseId: "t3",
      toolName: "ranking.score",
      toolInput: {
        creator: {
          followerCount: baseCandidate.creator.followerCount,
          followingCount: baseCandidate.creator.followingCount,
          videoCount: baseCandidate.creator.videoCount,
          heartCount: baseCandidate.creator.heartCount,
          verified: false,
        },
        recentPosts: ALL_POSTS.map((p) => ({ views: p.views, likes: p.likes, comments: p.comments, shares: p.shares })),
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
      if (!t) throw new Error("vettingScript exhausted");
      return t;
    },
  };
}

async function seedHealthyCreator(): Promise<void> {
  const db = await getDb();
  await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).insertOne({
    ...baseCandidate.creator,
    updatedAt: new Date(),
  });
}

describe("vettingAgent — unit", () => {
  it("happy path: drives the 3-tool flow and returns a CandidateSchema with fitScore + flags + vettedAt", async () => {
    await seedHealthyCreator();
    const ctx = ctx0();
    const out = await runAgent(vettingAgent, { brief, candidate: baseCandidate }, { ...ctx, model: vettingScript({ fitScore: 0.78, flags: [] }) });

    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok, got " + JSON.stringify(out));
    expect(out.value.fitScore).toBe(0.78);
    expect(out.value.flags).toEqual([]);
    expect(out.value.creator.uniqueId).toBe("@glow_kr");
    expect(out.value.vettedAt).toBeInstanceOf(Date);

    // Trace contains the agent span + the 3 expected tool spans + at least 4 llm spans
    const spanNames = ctx.trace.spans.map((s) => `${s.kind}:${s.name}`);
    expect(spanNames).toContain("agent:agent:vetting");
    expect(spanNames).toContain("tool:tool:blacklist.check");
    expect(spanNames).toContain("tool:tool:tiktok.getCreator");
    expect(spanNames).toContain("tool:tool:ranking.score");
    expect(ctx.trace.spans.filter((s) => s.kind === "llm")).toHaveLength(4);
  });

  it("escalation path: the agent says it can't proceed → AgentOutcome.escalate", async () => {
    await seedHealthyCreator();
    const fake: ModelClient = {
      complete: async () => ({ kind: "text", text: JSON.stringify({ escalate: "candidate has no recent posts" }), inputTokens: 30, outputTokens: 10 }),
    };
    const out = await runAgent(vettingAgent, { brief, candidate: baseCandidate }, { ...ctx0(), model: fake });
    expect(out.kind).toBe("escalate");
    if (out.kind !== "escalate") throw new Error("expected escalate");
    expect(out.reason).toContain("no recent posts");
  });
});
