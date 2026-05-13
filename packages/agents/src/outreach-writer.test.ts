import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CampaignBrief, TikTokCreator } from "@ss/contracts";
import { closeMongo } from "@ss/db";
import { memorySink, setObservabilitySink, startTrace } from "@ss/observability";
import { setUsageStore, type UsageStore } from "@ss/capabilities";
import {
  runAgent,
  type AgentRunContext,
  type ModelClient,
  type ModelTurn,
} from "./index";
import { outreachWriterAgent } from "./outreach-writer.agent";

/**
 * P2-C3c — outreachWriterAgent unit. Drives the agent through the real
 * deterministic capabilities (outreach.extractFacts + outreach.judge +
 * templates.render) with a scripted ModelClient simulating the tournament.
 *
 * No Mongo writes here (extract-facts and judge are pure capabilities), so
 * the suite is genuinely credential-free — only the dev-mongo URI is
 * required because @ss/db's getDb() is consulted lazily when @ss/capabilities
 * is imported (no actual reads happen in pure-tool paths).
 */

const memUsageStore: UsageStore = {
  async increment() { return 1; },
  async decrement() {},
  async getOverride() { return null; },
};

const ctx0 = (): AgentRunContext => ({
  capabilityCtx: { workspaceId: "ws_w", userId: "u".repeat(21), rateLimitClass: "default" },
  trace: startTrace("camp_writer_test"),
});

const brief: CampaignBrief = {
  workspaceId: "ws_w",
  createdBy: "u".repeat(21),
  brandProduct: {
    name: "Hydra Serum",
    category: "skincare/serum",
    description: "수분 세럼",
    keyClaims: ["7-day hydration", "fragrance-free"],
  },
  targeting: {
    creatorCount: 3,
    minEngagementRate: 0.02,
    languages: ["ko"],
    hashtags: ["스킨케어"],
    excludeBlacklist: true,
  },
  logistics: { shipsSamples: true },
  goals: { targetLivePosts: 3, deadline: new Date("2026-08-01") },
};

const creator: TikTokCreator = {
  id: "id_freshly",
  uniqueId: "@freshly",
  nickname: "freshly",
  signature: "k-beauty / 수분",
  verified: false,
  privateAccount: false,
  followerCount: 42_000,
  followingCount: 110,
  videoCount: 80,
  heartCount: 1_500_000,
  hashtags: ["스킨케어", "kbeauty"],
};

const recentPosts = [
  { desc: "겨울철 보습 루틴 공유합니다!", hashtags: ["스킨케어"] },
  { desc: "신상 세럼 후기. 발림성 만족.", hashtags: [] },
];

const winningDraft = {
  subject: "Quick collab idea — your 겨울철 보습 루틴 video",
  body:
    "<p>Hi @freshly, your '겨울철 보습 루틴' video stuck with me — that's exactly the moment Hydra Serum was built for: 7-day hydration, fragrance-free.</p>" +
    "<p>Open to sending you a sample? Your own angle, no script. Brand HQ — 12 Garosu-gil, Gangnam-gu, Seoul.</p>" +
    "<p>If not relevant, unsubscribe here.</p>",
};

/**
 * Stateful script that captures the OutreachFacts the runtime returned from
 * `outreach.extractFacts` and feeds it back to each `outreach.judge` call —
 * mirrors how the real agent threads the fact set through its tool sequence.
 */
function writerScriptStateful(args: { angle: string; draft: { subject: string; body: string } }): ModelClient {
  let extractedFacts: Record<string, unknown> | undefined;
  const queue: ModelTurn[] = [
    // 1) call extractFacts
    {
      kind: "tool_use",
      toolUseId: "ef",
      toolName: "outreach.extractFacts",
      toolInput: { brief, creator, recentPosts },
      inputTokens: 60,
      outputTokens: 12,
    },
    // (judges 2-5 are pushed below after we observe the ef result)
  ];
  const judges: ("brand" | "conversion" | "deliverability" | "skeptic")[] = [
    "brand",
    "conversion",
    "deliverability",
    "skeptic",
  ];
  let idx = 0;
  let judgeCursor = 0;
  return {
    complete: async ({ messages }) => {
      // Detect the most-recent "Tool result for outreach.extractFacts" payload
      // and capture it for subsequent judge calls.
      if (!extractedFacts) {
        const last = messages[messages.length - 1];
        if (last?.content?.startsWith("Tool result for outreach.extractFacts")) {
          const jsonPart = last.content.slice(last.content.indexOf("\n") + 1);
          try {
            extractedFacts = JSON.parse(jsonPart) as Record<string, unknown>;
          } catch {
            // ignore — judge will get an empty facts shape and surface a useful error
          }
        }
      }

      if (idx === 0) {
        idx++;
        return queue[0]!;
      }
      if (judgeCursor < judges.length) {
        const judge = judges[judgeCursor++]!;
        return {
          kind: "tool_use",
          toolUseId: `j${judgeCursor}`,
          toolName: "outreach.judge",
          toolInput: { judge, draft: args.draft, facts: extractedFacts ?? {}, bannedPhrases: [] },
          inputTokens: 60,
          outputTokens: 10,
        };
      }
      return {
        kind: "text",
        text: JSON.stringify({
          subject: args.draft.subject,
          body: args.draft.body,
          angle: args.angle,
          spamScore: 0,
          groundedFacts: ["recentPostThemes[0]", "brand.keyClaims[0]"],
          judgeScores: { brand: 0.95, conversion: 1.0, deliverability: 1.0, skeptic: 1.0 },
        }),
        inputTokens: 80,
        outputTokens: 220,
      };
    },
  };
}

beforeAll(() => {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI not set — start scripts/dev-mongo first");
  }
});

beforeEach(() => {
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

describe("outreachWriterAgent — unit", () => {
  it("happy path: extractFacts → 4 judges → returns the winning draft with judgeScores attached", async () => {
    const ctx = ctx0();
    const out = await runAgent(
      outreachWriterAgent,
      { brief, creator, recentPosts, voiceNotes: "", signatureBlock: "", bannedPhrases: [] },
      { ...ctx, model: writerScriptStateful({ angle: "data_specific", draft: winningDraft }) },
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.value.subject).toBe(winningDraft.subject);
    expect(out.value.angle).toBe("data_specific");
    expect(out.value.judgeScores?.brand).toBeCloseTo(0.95, 2);
    expect(out.value.groundedFacts.length).toBeGreaterThan(0);

    // trace: 1 extractFacts + 4 judges
    const toolSpans = ctx.trace.spans.filter((s) => s.kind === "tool").map((s) => s.name);
    expect(toolSpans.filter((n) => n === "tool:outreach.extractFacts")).toHaveLength(1);
    expect(toolSpans.filter((n) => n === "tool:outreach.judge")).toHaveLength(4);
  });

  it("escalation: insufficient_context surfaces from the runtime", async () => {
    const fake: ModelClient = {
      complete: async () => ({
        kind: "text",
        text: JSON.stringify({ escalate: "insufficient_context" }),
        inputTokens: 40,
        outputTokens: 8,
      }),
    };
    const out = await runAgent(
      outreachWriterAgent,
      { brief, creator, recentPosts: [], voiceNotes: "", signatureBlock: "", bannedPhrases: [] },
      { ...ctx0(), model: fake },
    );
    expect(out.kind).toBe("escalate");
    if (out.kind !== "escalate") throw new Error("expected escalate");
    expect(out.reason).toContain("insufficient_context");
  });

  it("agent definition exposes exactly the curated tool set (no surprise capabilities)", () => {
    expect(outreachWriterAgent.tools.sort()).toEqual(
      ["outreach.extractFacts", "outreach.judge", "templates.render"].sort(),
    );
  });
});
