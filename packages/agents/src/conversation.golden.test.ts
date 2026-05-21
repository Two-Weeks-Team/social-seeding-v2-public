import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OutreachFacts } from "@ss/contracts";
import { closeMongo } from "@ss/db";
import { memorySink, setObservabilitySink, startTrace } from "@ss/observability";
import { setUsageStore, type UsageStore } from "@ss/capabilities";
import {
  conversationAgent,
  conversationResponderAgent,
  needsResponseDraft,
  runAgent,
  type AgentRunContext,
  type ModelClient,
  type ModelTurn,
} from "./index";

/**
 * P2-C4 golden — the classifier × responder handoff pinned across the
 * branching matrix that drives Phase-2 creator-track. Real LLM evaluation
 * (Gemini 3.1 Flash-Lite for classification, Gemini 3.5 Flash for the reply) is a follow-up that needs
 * GEMINI_API_KEY; these tests pin the plumbing — handoff direction, the
 * draft-only-when-warranted contract, and trace shape.
 */

const memUsageStore: UsageStore = {
  async increment() { return 1; },
  async decrement() {},
  async getOverride() { return null; },
};

const ctx0 = (label: string): AgentRunContext => ({
  capabilityCtx: { workspaceId: "ws_cg", userId: "u".repeat(21), rateLimitClass: "default" },
  trace: startTrace(`camp_${label}`),
});

const facts: OutreachFacts = {
  creator: {
    uniqueId: "@freshly",
    nickname: "freshly",
    signature: "k-beauty / 수분",
    topHashtags: ["스킨케어"],
    recentPostThemes: ["겨울철 보습 루틴"],
    followerCount: 42_000,
  },
  brand: {
    name: "Hydra Serum",
    category: "skincare/serum",
    description: "수분 세럼",
    keyClaims: ["7-day hydration", "fragrance-free"],
  },
  logistics: { shipsSamples: true },
  hasMinimumContext: true,
};

const baseInput = {
  threadId: "t_g_001",
  creatorId: "creator_42",
  creatorHandle: "freshly",
  threadHistory: [
    {
      role: "us" as const,
      subject: "Quick collab idea — your 겨울철 보습 루틴 video",
      bodyText: "Hi @freshly, your '겨울철 보습 루틴' video — open to sending you a sample?",
    },
  ],
};

function classifierFake(json: Record<string, unknown>): ModelClient {
  return {
    complete: async () => ({
      kind: "text",
      text: JSON.stringify(json),
      inputTokens: 220,
      outputTokens: 60,
    }),
  };
}

function responderFake(args: { reply: { subject: string; body: string } }): ModelClient {
  let step = 0;
  return {
    complete: async () => {
      const at = step++;
      if (at === 0) {
        return {
          kind: "tool_use",
          toolUseId: "j1",
          toolName: "outreach.judge",
          toolInput: { judge: "deliverability", draft: args.reply, facts, bannedPhrases: [] },
          inputTokens: 60,
          outputTokens: 10,
        } satisfies ModelTurn;
      }
      return {
        kind: "text",
        text: JSON.stringify({ subject: args.reply.subject, body: args.reply.body, deliverabilityScore: 0.95 }),
        inputTokens: 80,
        outputTokens: 200,
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

describe("conversation × responder — golden set (workflow branching matrix)", () => {
  it("interested + address: classifier → responder confirms receipt; reply mentions ETA + sample", async () => {
    const ctxClass = ctx0("g_interested_class");
    const classified = await runAgent(
      conversationAgent,
      {
        ...baseInput,
        incomingMessage: {
          messageId: "msg_g_001",
          fromEmail: "freshly@example.com",
          subject: "Re: Quick collab",
          bodyText: "보내주세요. 주소는 서울 강남구 가로수길 12, 101호 우 06000 입니다.",
        },
      },
      {
        ...ctxClass,
        model: classifierFake({
          threadId: "t_g_001",
          creatorId: "creator_42",
          incomingMessageId: "msg_g_001",
          classification: "interested",
          extracted: { shippingAddress: "서울 강남구 가로수길 12, 101호 우 06000" },
        }),
      },
    );
    expect(classified.kind).toBe("ok");
    if (classified.kind !== "ok") throw new Error("expected ok");
    expect(classified.value.classification).toBe("interested");
    expect(needsResponseDraft(classified.value)).toBe(true);

    // Responder step (real workflow would gate via approveReplyResponse first).
    const ctxResp = ctx0("g_interested_resp");
    const replied = await runAgent(
      conversationResponderAgent,
      {
        turn: classified.value,
        facts,
        threadHistory: baseInput.threadHistory,
        voiceNotes: "",
        signatureBlock: "",
        bannedPhrases: [],
      },
      {
        ...ctxResp,
        model: responderFake({
          reply: {
            subject: "Thanks @freshly — sample on the way",
            body:
              "<p>Hi @freshly — got the address, shipping one Hydra Serum out today (ETA 3–5 business days).</p>" +
              "<p>No script — pick the angle that fits your rhythm. Anything else from us? Brand HQ: 12 Garosu-gil, Seoul.</p>" +
              "<p>If not relevant, unsubscribe here.</p>",
          },
        }),
      },
    );
    expect(replied.kind).toBe("ok");
    if (replied.kind !== "ok") throw new Error("expected ok");
    expect(replied.value.subject).toMatch(/sample/);
    expect(replied.value.body).toContain("Hydra Serum");
    expect(replied.value.deliverabilityScore).toBeGreaterThan(0.7);

    // Trace shape: classifier had zero tool spans (it has no tools);
    // responder had exactly one outreach.judge span.
    expect(ctxClass.trace.spans.filter((s) => s.kind === "tool")).toHaveLength(0);
    expect(ctxResp.trace.spans.filter((s) => s.name === "tool:outreach.judge")).toHaveLength(1);
  });

  it("needs_info: classifier extracts the verbatim question; responder answers it", async () => {
    const classified = await runAgent(
      conversationAgent,
      {
        ...baseInput,
        incomingMessage: {
          messageId: "msg_g_002",
          fromEmail: "freshly@example.com",
          subject: "Re: Quick collab",
          bodyText: "혹시 영상에 꼭 들어가야 하는 핵심 메시지가 있나요?",
        },
      },
      {
        ...ctx0("g_needsinfo_class"),
        model: classifierFake({
          threadId: "t_g_001",
          creatorId: "creator_42",
          incomingMessageId: "msg_g_002",
          classification: "needs_info",
          extracted: { question: "혹시 영상에 꼭 들어가야 하는 핵심 메시지가 있나요?" },
        }),
      },
    );
    expect(classified.kind).toBe("ok");
    if (classified.kind !== "ok") throw new Error("expected ok");
    expect(classified.value.extracted.question).toContain("핵심 메시지");
    expect(needsResponseDraft(classified.value)).toBe(true);

    const replied = await runAgent(
      conversationResponderAgent,
      {
        turn: classified.value,
        facts,
        threadHistory: baseInput.threadHistory,
        voiceNotes: "",
        signatureBlock: "",
        bannedPhrases: [],
      },
      {
        ...ctx0("g_needsinfo_resp"),
        model: responderFake({
          reply: {
            subject: "Re: 핵심 메시지 — your call on Hydra Serum",
            body:
              "<p>좋은 질문 감사합니다! 핵심은 '7-day hydration, fragrance-free' 두 가지 — 그 외에는 본인이 평소 쓰시는 톤 그대로면 좋아요.</p>" +
              "<p>영상 길이 / 형식은 모두 자유입니다. 더 궁금한 점 있으면 회신 주세요.</p>" +
              "<p>If not relevant, unsubscribe here. Brand HQ: 12 Garosu-gil, Seoul.</p>",
          },
        }),
      },
    );
    expect(replied.kind).toBe("ok");
    if (replied.kind !== "ok") throw new Error("expected ok");
    expect(replied.value.body).toMatch(/7-day hydration/);
  });

  it("negotiating: ALWAYS escalates; responder is NOT invoked", async () => {
    const classified = await runAgent(
      conversationAgent,
      {
        ...baseInput,
        incomingMessage: {
          messageId: "msg_g_003",
          fromEmail: "freshly@example.com",
          subject: "Re: Quick collab",
          bodyText: "관심 있는데 영상당 130만 원 받습니다. 가능한가요?",
        },
      },
      {
        ...ctx0("g_negotiating"),
        model: classifierFake({
          threadId: "t_g_001",
          creatorId: "creator_42",
          incomingMessageId: "msg_g_003",
          classification: "negotiating",
          extracted: { proposedRateUsd: 1000 },
          needsHumanReason: "Counter-offer on rate (130만 원 ≈ USD 1000) — workspace policy escalates.",
        }),
      },
    );
    expect(classified.kind).toBe("ok");
    if (classified.kind !== "ok") throw new Error("expected ok");
    expect(classified.value.classification).toBe("negotiating");
    expect(classified.value.needsHumanReason).toMatch(/Counter-offer/);
    // The workflow short-circuit: responder agent is NOT invoked here.
    expect(needsResponseDraft(classified.value)).toBe(false);
  });

  it("unsubscribe: classifier flags suppression; responder never runs", async () => {
    const classified = await runAgent(
      conversationAgent,
      {
        ...baseInput,
        incomingMessage: {
          messageId: "msg_g_004",
          fromEmail: "freshly@example.com",
          subject: "Re: Quick collab",
          bodyText: "이메일 보내지 마세요. 수신거부 부탁드립니다.",
        },
      },
      {
        ...ctx0("g_unsubscribe"),
        model: classifierFake({
          threadId: "t_g_001",
          creatorId: "creator_42",
          incomingMessageId: "msg_g_004",
          classification: "unsubscribe",
          extracted: {},
          needsHumanReason: "Explicit unsubscribe — add to suppression list.",
        }),
      },
    );
    expect(classified.kind).toBe("ok");
    if (classified.kind !== "ok") throw new Error("expected ok");
    expect(classified.value.classification).toBe("unsubscribe");
    expect(needsResponseDraft(classified.value)).toBe(false);
    expect(classified.value.needsHumanReason).toMatch(/suppression/);
  });

  it("out_of_office: classifier returns OOO; responder never runs; no escalation", async () => {
    const classified = await runAgent(
      conversationAgent,
      {
        ...baseInput,
        incomingMessage: {
          messageId: "msg_g_005",
          fromEmail: "freshly@example.com",
          subject: "[Auto] Out of Office",
          bodyText: "I'm currently out of office until next Monday. Will reply on return.",
        },
      },
      {
        ...ctx0("g_ooo"),
        model: classifierFake({
          threadId: "t_g_001",
          creatorId: "creator_42",
          incomingMessageId: "msg_g_005",
          classification: "out_of_office",
          extracted: {},
        }),
      },
    );
    expect(classified.kind).toBe("ok");
    if (classified.kind !== "ok") throw new Error("expected ok");
    expect(classified.value.classification).toBe("out_of_office");
    expect(classified.value.needsHumanReason).toBeUndefined();
    expect(needsResponseDraft(classified.value)).toBe(false);
  });
});
