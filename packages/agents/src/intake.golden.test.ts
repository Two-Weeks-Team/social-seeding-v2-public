import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { memorySink, setObservabilitySink, startTrace } from "@ss/observability";
import { setUsageStore, type UsageStore } from "@ss/capabilities";
import { runAgent, type AgentRunContext, type ModelClient } from "./index";
import { intakeAgent } from "./intake.agent";

/**
 * A-intake golden set — 4 transcript → expected status scenarios pin the
 * branch the agent takes (done / asking / escalate) and the schema validity
 * of each. With a fake ModelClient: real brief-extraction quality eval needs
 * GEMINI_API_KEY and is a Phase-1 follow-up.
 */

type IntakeInput = z.infer<typeof intakeAgent.input>;

const ctx0 = (): AgentRunContext => ({
  capabilityCtx: { workspaceId: "ws_ig", userId: "u".repeat(21), rateLimitClass: "default" },
  trace: startTrace("camp_intake_golden"),
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

function briefFor(name: string, category: string, creatorCount: number, targetLivePosts: number, deadline: string, opts: Partial<{ minEngagementRate: number; languages: string[]; hashtags: string[]; shipsSamples: boolean }> = {}) {
  return {
    workspaceId: "ws_ig",
    createdBy: "u".repeat(21),
    brandProduct: { name, category, description: `${name} description`, keyClaims: [] },
    targeting: {
      creatorCount,
      minEngagementRate: opts.minEngagementRate ?? 0.02,
      languages: opts.languages ?? ["ko"],
      hashtags: opts.hashtags ?? [],
      excludeBlacklist: true,
    },
    logistics: { shipsSamples: opts.shipsSamples ?? true },
    goals: { targetLivePosts, deadline },
  };
}

interface GoldenCase {
  name: string;
  messages: IntakeInput["messages"];
  fakeResponse: object;
  expect: "done" | "asking" | "escalate";
}

const cases: GoldenCase[] = [
  {
    name: "Korean rich intent → done with full brief",
    messages: [{ role: "user", content: "수분 세럼 K-beauty 시딩이야. 한국어 3명, ER 2% 이상, 샘플 보내고 8월 1일까지 라이브 포스트 3개." }],
    fakeResponse: { status: "done", brief: briefFor("Hydra Serum", "skincare/serum", 3, 3, "2026-08-01T00:00:00Z", { hashtags: ["스킨케어"] }) },
    expect: "done",
  },
  {
    name: "English rich intent → done with full brief (different vertical)",
    messages: [{ role: "user", content: "Launching a vitamin C serum. Want 5 US English creators, ≥1% ER, send samples, 4 live posts by Sept 30." }],
    fakeResponse: { status: "done", brief: briefFor("Vitamin C Serum", "skincare/serum", 5, 4, "2026-09-30T00:00:00Z", { minEngagementRate: 0.01, languages: ["en"] }) },
    expect: "done",
  },
  {
    name: "Vague single-line intent → asking",
    messages: [{ role: "user", content: "캠페인 하나 만들고 싶어" }],
    fakeResponse: { status: "asking", question: "어떤 제품을 어떤 분야의 크리에이터에게 보내시려나요? (예: '수분 세럼 / 스킨케어')" },
    expect: "asking",
  },
  {
    name: "Contradictory follow-up (3 then 30 creators) → escalate",
    messages: [
      { role: "user", content: "3명 한국어 크리에이터에게 세럼 보내고 싶어" },
      { role: "assistant", content: "샘플 발송 여부 알려주세요." },
      { role: "user", content: "어 잠깐, 30명으로 바꿔. 아니, 3명. 아니, 잘 모르겠어." },
    ],
    fakeResponse: { escalate: "user can't settle on creatorCount after 3 turns" },
    expect: "escalate",
  },
];

describe("intakeAgent — golden set", () => {
  for (const c of cases) {
    it(c.name, async () => {
      const out = await runAgent(
        intakeAgent,
        { messages: c.messages, workspaceId: "ws_ig", createdBy: "u".repeat(21) },
        { ...ctx0(), model: fakeText(JSON.stringify(c.fakeResponse)) },
      );
      if (c.expect === "escalate") {
        expect(out.kind).toBe("escalate");
        return;
      }
      expect(out.kind).toBe("ok");
      if (out.kind !== "ok") throw new Error("expected ok");
      expect(out.value.status).toBe(c.expect);
    });
  }
});
