import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { memorySink, setObservabilitySink, startTrace } from "@ss/observability";
import { setUsageStore, type UsageStore } from "@ss/capabilities";
import { runAgent, type AgentRunContext, type ModelClient } from "./index";
import { intakeAgent } from "./intake.agent";

/**
 * A-intake unit + golden tests. Each invocation is one deliberation step —
 * "asking" responses are mid-conversation, "done" responses are when the
 * agent decides the brief is complete. With a fake ModelClient these pin
 * schema validation across the two output branches; real LLM brief-extraction
 * quality is a Phase-1 follow-up (needs ANTHROPIC_API_KEY).
 */

type IntakeInput = z.infer<typeof intakeAgent.input>;

const ctx0 = (): AgentRunContext => ({
  capabilityCtx: { workspaceId: "ws_i", userId: "u".repeat(21), rateLimitClass: "default" },
  trace: startTrace("camp_intake_test"),
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

const completeBriefJson = {
  status: "done",
  brief: {
    workspaceId: "ws_i",
    createdBy: "u".repeat(21),
    brandProduct: { name: "Hydra Serum", category: "skincare/serum", description: "hydration serum for the demo", keyClaims: [] },
    targeting: { creatorCount: 3, minEngagementRate: 0.02, languages: ["ko"], hashtags: [], excludeBlacklist: true },
    logistics: { shipsSamples: true },
    goals: { targetLivePosts: 3, deadline: "2026-08-01T00:00:00Z" },
  },
};

describe("intakeAgent — unit", () => {
  it("happy path: agent returns status='done' with a valid CampaignBrief when the user supplied enough", async () => {
    const input: IntakeInput = {
      messages: [{ role: "user", content: "수분 세럼 K-beauty 시딩이야. 한국어 3명, ER 2% 이상, 샘플 보내고 8월 1일까지 라이브 포스트 3개." }],
      workspaceId: "ws_i",
      createdBy: "u".repeat(21),
    };
    const out = await runAgent(intakeAgent, input, { ...ctx0(), model: fakeText(JSON.stringify(completeBriefJson)) });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    if (out.value.status !== "done") throw new Error("expected done");
    expect(out.value.brief.brandProduct.name).toBe("Hydra Serum");
    expect(out.value.brief.targeting.creatorCount).toBe(3);
  });

  it("asking path: agent returns status='asking' with a question when more info is needed", async () => {
    const input: IntakeInput = {
      messages: [{ role: "user", content: "캠페인 하나 시작하고 싶어" }],
      workspaceId: "ws_i",
      createdBy: "u".repeat(21),
    };
    const out = await runAgent(intakeAgent, input, {
      ...ctx0(),
      model: fakeText(JSON.stringify({ status: "asking", question: "어떤 제품을 어떤 카테고리의 크리에이터에게 보내시려나요? (예: '수분 세럼 / 스킨케어')" })),
    });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    if (out.value.status !== "asking") throw new Error("expected asking");
    expect(out.value.question).toContain("제품");
  });

  it("escalation path: agent declares it can't extract a brief from the conversation", async () => {
    const input: IntakeInput = {
      messages: [{ role: "user", content: "asdfqwer" }],
      workspaceId: "ws_i",
      createdBy: "u".repeat(21),
    };
    const out = await runAgent(intakeAgent, input, { ...ctx0(), model: fakeText(JSON.stringify({ escalate: "user input not parseable as campaign intent" })) });
    expect(out.kind).toBe("escalate");
    if (out.kind !== "escalate") throw new Error("expected escalate");
    expect(out.reason).toContain("not parseable");
  });
});
