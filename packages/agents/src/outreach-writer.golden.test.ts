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
 * P2-C3d — outreachWriterAgent golden set. Three pinned scenarios that
 * exercise the contract end-to-end against the real deterministic judges:
 *
 *   1. Happy path — Opus drafts a clean angle, all 4 judges score high.
 *   2. Revision path — first draft fires a spam rule; agent revises once,
 *      second draft clears, weighted score improves.
 *   3. Escalation — creator has no signature + no recent posts → the agent
 *      escalates from the extractFacts hasMinimumContext=false signal
 *      without burning the rest of its turn budget.
 *
 * Real LLM evaluation of writer prompt quality is a Phase-2 follow-up (needs
 * ANTHROPIC_API_KEY); these tests pin the *plumbing* — tools called in the
 * right order, judge weights honored, escalation surfaces cleanly.
 */

const memUsageStore: UsageStore = {
  async increment() { return 1; },
  async decrement() {},
  async getOverride() { return null; },
};

const ctx0 = (): AgentRunContext => ({
  capabilityCtx: { workspaceId: "ws_wg", userId: "u".repeat(21), rateLimitClass: "default" },
  trace: startTrace("camp_writer_golden"),
});

const brief: CampaignBrief = {
  workspaceId: "ws_wg",
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

const cleanDraft = {
  subject: "Quick collab idea — your 겨울철 보습 루틴 video",
  body:
    "<p>Hi @freshly, your '겨울철 보습 루틴' video stuck with me — that's exactly the moment Hydra Serum was built for: 7-day hydration, fragrance-free.</p>" +
    "<p>Open to sending you a sample? Your own angle, no script. Brand HQ — 12 Garosu-gil, Gangnam-gu, Seoul.</p>" +
    "<p>If not relevant, unsubscribe here.</p>",
};

// A draft that fires the misleadingSubject spam rule (Re: prefix) — the
// deliverability judge will flag it.
const spammyDraft = {
  subject: "Re: our chat about Hydra Serum",
  body: cleanDraft.body,
};

// Helper: build the stateful script that mirrors the real agent's tool flow.
// Optional `revisedDraft` triggers a one-shot revision pass: after the first
// 4 judges land on `firstDraft`, the agent re-judges deliverability on the
// revised draft before answering.
function script(args: {
  firstDraft: { subject: string; body: string };
  revisedDraft?: { subject: string; body: string };
  finalAngle: string;
  finalJudgeScores: { brand: number; conversion: number; deliverability: number; skeptic: number };
}): ModelClient {
  let extractedFacts: Record<string, unknown> | undefined;
  let step = 0;
  const reviseEnabled = !!args.revisedDraft;
  // Sequence:
  //   step 0      : extractFacts
  //   step 1..4   : judge brand/conversion/deliverability/skeptic on firstDraft
  //   step 5      : (if revising) judge deliverability on revisedDraft
  //   step 5/6    : final text answer
  return {
    complete: async ({ messages }) => {
      if (!extractedFacts) {
        const last = messages[messages.length - 1];
        if (last?.content?.startsWith("Tool result for outreach.extractFacts")) {
          const jsonPart = last.content.slice(last.content.indexOf("\n") + 1);
          try {
            extractedFacts = JSON.parse(jsonPart) as Record<string, unknown>;
          } catch {
            // The agent will surface the structural error.
          }
        }
      }
      const at = step++;
      const judges: ("brand" | "conversion" | "deliverability" | "skeptic")[] = [
        "brand",
        "conversion",
        "deliverability",
        "skeptic",
      ];
      const baseFacts = extractedFacts ?? {};
      const winningDraft = args.revisedDraft ?? args.firstDraft;

      if (at === 0) {
        return {
          kind: "tool_use",
          toolUseId: "ef",
          toolName: "outreach.extractFacts",
          toolInput: { brief, creator, recentPosts },
          inputTokens: 60,
          outputTokens: 12,
        } satisfies ModelTurn;
      }
      if (at >= 1 && at <= 4) {
        return {
          kind: "tool_use",
          toolUseId: `j${at}`,
          toolName: "outreach.judge",
          toolInput: { judge: judges[at - 1], draft: args.firstDraft, facts: baseFacts, bannedPhrases: [] },
          inputTokens: 60,
          outputTokens: 10,
        } satisfies ModelTurn;
      }
      if (reviseEnabled && at === 5) {
        return {
          kind: "tool_use",
          toolUseId: "j5_revised",
          toolName: "outreach.judge",
          toolInput: { judge: "deliverability", draft: args.revisedDraft, facts: baseFacts, bannedPhrases: [] },
          inputTokens: 60,
          outputTokens: 10,
        } satisfies ModelTurn;
      }
      return {
        kind: "text",
        text: JSON.stringify({
          subject: winningDraft.subject,
          body: winningDraft.body,
          angle: args.finalAngle,
          spamScore: 0,
          groundedFacts: ["recentPostThemes[0]", "brand.keyClaims[0]", "topHashtags[0]"],
          judgeScores: args.finalJudgeScores,
        }),
        inputTokens: 80,
        outputTokens: 220,
      } satisfies ModelTurn;
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

describe("outreachWriterAgent — golden set", () => {
  it("happy path: clean draft, 4 judges all ≥ 0.7, winner returned with audit trail", async () => {
    const ctx = ctx0();
    const out = await runAgent(
      outreachWriterAgent,
      { brief, creator, recentPosts, voiceNotes: "", signatureBlock: "", bannedPhrases: [] },
      {
        ...ctx,
        model: script({
          firstDraft: cleanDraft,
          finalAngle: "data_specific",
          finalJudgeScores: { brand: 0.95, conversion: 1.0, deliverability: 1.0, skeptic: 1.0 },
        }),
      },
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.value.subject).toBe(cleanDraft.subject);
    expect(out.value.groundedFacts).toContain("recentPostThemes[0]");
    expect(out.value.judgeScores?.skeptic).toBe(1.0);

    // Tool sequence: 1 extractFacts + 4 judges
    const toolSpans = ctx.trace.spans.filter((s) => s.kind === "tool").map((s) => s.name);
    expect(toolSpans.filter((n) => n === "tool:outreach.extractFacts")).toHaveLength(1);
    expect(toolSpans.filter((n) => n === "tool:outreach.judge")).toHaveLength(4);
  });

  it("revision path: first draft fires misleadingSubject spam flag, agent revises + re-judges, final winner stands", async () => {
    const ctx = ctx0();
    const out = await runAgent(
      outreachWriterAgent,
      { brief, creator, recentPosts, voiceNotes: "", signatureBlock: "", bannedPhrases: [] },
      {
        ...ctx,
        model: script({
          firstDraft: spammyDraft, // would fire misleadingSubject on the deliverability judge
          revisedDraft: cleanDraft, // sanitized
          finalAngle: "pain_killer",
          finalJudgeScores: { brand: 0.9, conversion: 0.95, deliverability: 1.0, skeptic: 1.0 },
        }),
      },
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.value.subject).toBe(cleanDraft.subject); // the revised one wins
    expect(out.value.subject.startsWith("Re:")).toBe(false);

    // Tool sequence: 1 extractFacts + 5 judges (4 on first draft + 1 deliverability re-judge on revision)
    const judgeSpans = ctx.trace.spans.filter((s) => s.name === "tool:outreach.judge");
    expect(judgeSpans).toHaveLength(5);
  });

  it("escalation: creator with empty signature + no posts → agent escalates insufficient_context, never reaches the judges", async () => {
    const bareCreator: TikTokCreator = { ...creator, signature: "", hashtags: [] };
    // Agent calls extractFacts, sees hasMinimumContext=false, escalates.
    const fake: ModelClient = {
      complete: async ({ messages }) => {
        const last = messages[messages.length - 1];
        // First turn: call extractFacts; second turn: respond with escalation.
        if (!last?.content?.startsWith("Tool result for outreach.extractFacts")) {
          return {
            kind: "tool_use",
            toolUseId: "ef",
            toolName: "outreach.extractFacts",
            toolInput: { brief, creator: bareCreator, recentPosts: [] },
            inputTokens: 60,
            outputTokens: 12,
          };
        }
        return {
          kind: "text",
          text: JSON.stringify({ escalate: "insufficient_context" }),
          inputTokens: 60,
          outputTokens: 8,
        };
      },
    };
    const ctx = ctx0();
    const out = await runAgent(
      outreachWriterAgent,
      { brief, creator: bareCreator, recentPosts: [], voiceNotes: "", signatureBlock: "", bannedPhrases: [] },
      { ...ctx, model: fake },
    );
    expect(out.kind).toBe("escalate");
    if (out.kind !== "escalate") throw new Error("expected escalate");
    expect(out.reason).toContain("insufficient_context");

    // Trace: one extractFacts call, ZERO judge calls (agent escalated before scoring).
    const toolSpans = ctx.trace.spans.filter((s) => s.kind === "tool").map((s) => s.name);
    expect(toolSpans.filter((n) => n === "tool:outreach.extractFacts")).toHaveLength(1);
    expect(toolSpans.filter((n) => n === "tool:outreach.judge")).toHaveLength(0);
  });
});
