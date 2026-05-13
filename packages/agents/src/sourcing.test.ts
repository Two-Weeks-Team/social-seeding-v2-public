import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { closeMongo, Collections, getDb } from "@ss/db";
import { memorySink, setObservabilitySink, startTrace } from "@ss/observability";
import { setUsageStore, type UsageStore } from "@ss/capabilities";
import { runAgent, type AgentRunContext, type ModelClient, type ModelTurn } from "./index";
import { sourcingAgent } from "./sourcing.agent";

/**
 * A-sourcing unit + golden tests. Drives the agent through 2-3 real
 * tiktok.search calls (executing against seeded accounts_tiktok in dev-mongo)
 * + a real blacklist.check (against seeded influencer_blacklist), with a
 * scripted fake ModelClient providing the final candidate list.
 */

type SourcingOutput = z.infer<typeof sourcingAgent.output>;
type Candidate = SourcingOutput["candidates"][number];

const ctx0 = (): AgentRunContext => ({
  capabilityCtx: { workspaceId: "ws_s", userId: "u".repeat(21), rateLimitClass: "default" },
  trace: startTrace("camp_source_test"),
});

const memUsageStore: UsageStore = {
  async increment() { return 1; },
  async decrement() {},
  async getOverride() { return null; },
};

function makeCreator(uniqueId: string, hashtags: string[], over: Record<string, unknown> = {}): Record<string, unknown> {
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

const brief = {
  workspaceId: "ws_s",
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

function asCandidate(uniqueId: string, hashtags: string[], reason: string, extra: Record<string, unknown> = {}): Candidate {
  return {
    creator: {
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
      ...extra,
    },
    matchReasons: [reason],
    flags: [],
  };
}

function sourcingScript(args: {
  queries: Array<{ query: string; mode: "text" | "hashtag" | "and" | "or" }>;
  uniqueIds: string[]; // for the blacklist check
  candidates: Candidate[];
  coverageNote: string;
}): ModelClient {
  const turns: ModelTurn[] = [
    ...args.queries.map(
      (q, i): ModelTurn => ({
        kind: "tool_use",
        toolUseId: `s${i}`,
        toolName: "tiktok.search",
        toolInput: { query: q.query, mode: q.mode, languages: ["ko"], limit: 50 },
        inputTokens: 80,
        outputTokens: 15,
      }),
    ),
    { kind: "tool_use", toolUseId: "bl", toolName: "blacklist.check", toolInput: { uniqueIds: args.uniqueIds }, inputTokens: 80, outputTokens: 12 },
    {
      kind: "text",
      text: JSON.stringify({
        candidates: args.candidates,
        queriesUsed: args.queries.map((q) => `${q.mode}:${q.query}`),
        coverageNote: args.coverageNote,
      }),
      inputTokens: 80,
      outputTokens: 220,
    },
  ];
  let i = 0;
  return {
    complete: async () => {
      const t = turns[Math.min(i++, turns.length - 1)];
      if (!t) throw new Error("sourcingScript exhausted");
      return t;
    },
  };
}

async function seedFive(): Promise<void> {
  const db = await getDb();
  await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).insertMany([
    makeCreator("@glow_kr", ["스킨케어"]),
    makeCreator("@dewy_kr", ["스킨케어", "kbeauty"]),
    makeCreator("@minji_skin", ["서울뷰티"]),
    makeCreator("@cleankr", ["스킨케어"]),
    makeCreator("@flaky_kr", ["스킨케어"]),
  ]);
}

describe("sourcingAgent — unit", () => {
  it("happy path: orchestrates tiktok.search × 2 + blacklist.check + returns the candidate set with coverageNote", async () => {
    await seedFive();
    const candidates = [
      asCandidate("@glow_kr", ["스킨케어"], "hashtag #스킨케어 + bio overlap"),
      asCandidate("@dewy_kr", ["스킨케어", "kbeauty"], "hashtags 스킨케어 + kbeauty"),
      asCandidate("@cleankr", ["스킨케어"], "active in 스킨케어 hashtag"),
    ];
    const ctx = ctx0();
    const out = await runAgent(
      sourcingAgent,
      { brief, excludeCreatorIds: [] },
      {
        ...ctx,
        model: sourcingScript({
          queries: [
            { query: "skincare hydration", mode: "text" },
            { query: "스킨케어", mode: "hashtag" },
          ],
          uniqueIds: ["@glow_kr", "@dewy_kr", "@minji_skin", "@cleankr", "@flaky_kr"],
          candidates,
          coverageNote: "found 5 in-range; brief wants 3 — comfortable margin",
        }),
      },
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.value.candidates.map((c) => c.creator.uniqueId)).toEqual(["@glow_kr", "@dewy_kr", "@cleankr"]);
    expect(out.value.queriesUsed).toHaveLength(2);
    expect(out.value.coverageNote).toMatch(/comfortable margin/);

    // trace: 2 tiktok.search + 1 blacklist.check
    const toolSpans = ctx.trace.spans.filter((s) => s.kind === "tool").map((s) => s.name);
    expect(toolSpans.filter((n) => n === "tool:tiktok.search")).toHaveLength(2);
    expect(toolSpans).toContain("tool:blacklist.check");
  });

  it("escalation path: agent declares insufficient coverage", async () => {
    await seedFive();
    const fake: ModelClient = {
      complete: async () => ({ kind: "text", text: JSON.stringify({ escalate: "no in-range creators for this niche" }), inputTokens: 50, outputTokens: 12 }),
    };
    const out = await runAgent(sourcingAgent, { brief, excludeCreatorIds: [] }, { ...ctx0(), model: fake });
    expect(out.kind).toBe("escalate");
    if (out.kind !== "escalate") throw new Error("expected escalate");
    expect(out.reason).toContain("no in-range creators");
  });
});
