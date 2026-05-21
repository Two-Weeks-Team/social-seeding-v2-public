import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memorySink, setObservabilitySink, startTrace } from "@ss/observability";
import { setUsageStore, type UsageStore } from "@ss/capabilities";
import { runAgent, type AgentRunContext, type ModelClient } from "./index";
import { conversationAgent, needsResponseDraft } from "./conversation.agent";

/**
 * P2-C4a — conversationAgent unit. Drives the classifier through scripted
 * Gemini 3.1 Flash-Lite responses; verifies the shape of `ConversationTurn` output, the
 * extraction targets, and the `needsHumanReason` escalation rule.
 */

const ctx0 = (): AgentRunContext => ({
  capabilityCtx: { workspaceId: "ws_c", userId: "u".repeat(21), rateLimitClass: "default" },
  trace: startTrace("camp_conv_test"),
});

const memUsageStore: UsageStore = {
  async increment() { return 1; },
  async decrement() {},
  async getOverride() { return null; },
};

beforeEach(() => {
  setObservabilitySink(memorySink());
  setUsageStore(memUsageStore);
});

afterEach(() => {
  setObservabilitySink(undefined);
  setUsageStore(undefined);
});

function fakeText(text: string): ModelClient {
  return { complete: async () => ({ kind: "text", text, inputTokens: 200, outputTokens: 80 }) };
}

const baseInput = {
  threadId: "t_001",
  creatorId: "creator_42",
  creatorHandle: "freshly",
  incomingMessage: {
    messageId: "msg_in_001",
    fromEmail: "freshly@example.com",
    subject: "Re: Quick collab idea — your 겨울철 보습 루틴 video",
    bodyText: "samples? 보내주세요. 주소는 서울 강남구 가로수길 12, 101호 우 06000 입니다. 감사합니다!",
  },
  threadHistory: [],
};

describe("conversationAgent — unit", () => {
  it("interested + shipping address → classification 'interested', extracted.shippingAddress filled", async () => {
    const out = await runAgent(
      conversationAgent,
      baseInput,
      {
        ...ctx0(),
        model: fakeText(
          JSON.stringify({
            threadId: "t_001",
            creatorId: "creator_42",
            incomingMessageId: "msg_in_001",
            classification: "interested",
            extracted: { shippingAddress: "서울 강남구 가로수길 12, 101호 우 06000" },
          }),
        ),
      },
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.value.classification).toBe("interested");
    expect(out.value.extracted.shippingAddress).toContain("강남구");
    expect(out.value.needsHumanReason).toBeUndefined();
    expect(needsResponseDraft(out.value)).toBe(true);
  });

  it("needs_info: extracts the verbatim question, signals the responder is needed", async () => {
    const out = await runAgent(
      conversationAgent,
      {
        ...baseInput,
        incomingMessage: {
          messageId: "msg_in_002",
          fromEmail: "freshly@example.com",
          subject: "Re: Quick collab",
          bodyText: "Hi! 혹시 영상에 꼭 들어가야 하는 핵심 메시지가 있나요? 영상 길이 기준도 알려주세요.",
        },
      },
      {
        ...ctx0(),
        model: fakeText(
          JSON.stringify({
            threadId: "t_001",
            creatorId: "creator_42",
            incomingMessageId: "msg_in_002",
            classification: "needs_info",
            extracted: {
              question: "영상에 꼭 들어가야 하는 핵심 메시지가 있나요? 영상 길이 기준도 알려주세요.",
            },
          }),
        ),
      },
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.value.classification).toBe("needs_info");
    expect(out.value.extracted.question).toContain("핵심 메시지");
    expect(needsResponseDraft(out.value)).toBe(true);
  });

  it("negotiating: ALWAYS escalates regardless of confidence; extracts proposedRateUsd", async () => {
    const out = await runAgent(
      conversationAgent,
      {
        ...baseInput,
        incomingMessage: {
          messageId: "msg_in_003",
          fromEmail: "freshly@example.com",
          subject: "Re: Quick collab",
          bodyText: "관심 있긴 한데 보통 영상 하나에 130만 원 정도 받아요. 가능하면 진행 가능합니다.",
        },
      },
      {
        ...ctx0(),
        model: fakeText(
          JSON.stringify({
            threadId: "t_001",
            creatorId: "creator_42",
            incomingMessageId: "msg_in_003",
            classification: "negotiating",
            extracted: { proposedRateUsd: 1000 },
            needsHumanReason: "Counter-offer on rate (130만 원 ≈ $1000) — needs human approval per policy.",
          }),
        ),
      },
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.value.classification).toBe("negotiating");
    expect(out.value.extracted.proposedRateUsd).toBe(1000);
    expect(out.value.needsHumanReason).toMatch(/Counter-offer/);
    expect(needsResponseDraft(out.value)).toBe(false); // negotiating → human, not responder
  });

  it("declined and unsubscribe: needsHumanReason set, responder skipped", async () => {
    const declined = await runAgent(
      conversationAgent,
      {
        ...baseInput,
        incomingMessage: {
          messageId: "msg_in_004",
          fromEmail: "freshly@example.com",
          subject: "Re: Quick collab",
          bodyText: "관심 없습니다.",
        },
      },
      {
        ...ctx0(),
        model: fakeText(
          JSON.stringify({
            threadId: "t_001",
            creatorId: "creator_42",
            incomingMessageId: "msg_in_004",
            classification: "declined",
            extracted: {},
            needsHumanReason: "Hard decline.",
          }),
        ),
      },
    );
    expect(declined.kind).toBe("ok");
    if (declined.kind !== "ok") throw new Error("expected ok");
    expect(declined.value.classification).toBe("declined");
    expect(needsResponseDraft(declined.value)).toBe(false);

    const unsub = await runAgent(
      conversationAgent,
      {
        ...baseInput,
        incomingMessage: {
          messageId: "msg_in_005",
          fromEmail: "freshly@example.com",
          subject: "Re: Quick collab",
          bodyText: "이메일 보내지 마세요. 수신거부 부탁드립니다.",
        },
      },
      {
        ...ctx0(),
        model: fakeText(
          JSON.stringify({
            threadId: "t_001",
            creatorId: "creator_42",
            incomingMessageId: "msg_in_005",
            classification: "unsubscribe",
            extracted: {},
            needsHumanReason: "Explicit unsubscribe — add to suppression list.",
          }),
        ),
      },
    );
    expect(unsub.kind).toBe("ok");
    if (unsub.kind !== "ok") throw new Error("expected ok");
    expect(unsub.value.classification).toBe("unsubscribe");
    expect(unsub.value.needsHumanReason).toMatch(/suppression/);
  });

  it("out_of_office: auto-reply text → no escalation, no responder", async () => {
    const out = await runAgent(
      conversationAgent,
      {
        ...baseInput,
        incomingMessage: {
          messageId: "msg_in_006",
          fromEmail: "freshly@example.com",
          subject: "[Auto] Out of Office",
          bodyText: "I'm currently out of office until next Monday. Will reply on return.",
        },
      },
      {
        ...ctx0(),
        model: fakeText(
          JSON.stringify({
            threadId: "t_001",
            creatorId: "creator_42",
            incomingMessageId: "msg_in_006",
            classification: "out_of_office",
            extracted: {},
          }),
        ),
      },
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.value.classification).toBe("out_of_office");
    expect(out.value.needsHumanReason).toBeUndefined();
    expect(needsResponseDraft(out.value)).toBe(false);
  });

  it("agent definition is bounded: Gemini 3.1 Flash-Lite, no tools, sub-$0.05 cap", () => {
    expect(conversationAgent.model).toBe("gemini-3.1-flash-lite");
    expect(conversationAgent.tools).toEqual([]);
    expect(conversationAgent.maxUsd).toBeLessThan(0.05);
  });

  it("needsResponseDraft: only 'interested' and 'needs_info' return true", () => {
    expect(needsResponseDraft({ classification: "interested" })).toBe(true);
    expect(needsResponseDraft({ classification: "needs_info" })).toBe(true);
    for (const c of ["negotiating", "not_now", "declined", "out_of_office", "unsubscribe", "unrelated"] as const) {
      expect(needsResponseDraft({ classification: c })).toBe(false);
    }
  });
});
