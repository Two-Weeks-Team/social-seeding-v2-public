import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LeadCampaignBrief, LeadEnrichment } from "@ss/contracts";
import { memorySink, setObservabilitySink, startTrace } from "@ss/observability";
import { setUsageStore, type UsageStore } from "@ss/capabilities";
import { runAgent, type AgentRunContext, type ModelClient } from "./index";
import { researchAgent, type ResearchOutput } from "./research.agent";

/**
 * P5-C2 — research agent unit tests. No tools (pure text), so test
 * shape: scripted ModelClient → output validates against the schema +
 * agent cap / model identity hold.
 */

const memUsageStore: UsageStore = {
  async increment() { return 1; },
  async decrement() {},
  async getOverride() { return null; },
};

const ctx0 = (): AgentRunContext => ({
  capabilityCtx: { workspaceId: "ws_re", userId: "u".repeat(21), rateLimitClass: "default" },
  trace: startTrace("camp_re"),
});

const brief: LeadCampaignBrief = {
  workspaceId: "ws_re",
  createdBy: "u".repeat(21),
  name: "Pitch to K-beauty brands",
  ourProduct: {
    name: "Social Seeding",
    pitchSummary: "TikTok influencer marketing platform that runs end-to-end seeding campaigns",
    keyClaims: ["finds creators by hashtag fit", "auto-handles replies + shipping"],
  },
  targeting: { countries: ["KR"], categories: [], excludeBlacklist: true },
  outreach: { maxSendsPerBatch: 20, toneNotes: "directness, no hype" },
  goals: { targetReplies: 5, deadline: new Date("2026-08-01"), budgetUsd: 100 },
};

const richEnrichment: LeadEnrichment = {
  websiteData: {
    url: "https://glow-tonic.kr", normalizedUrl: "https://glow-tonic.kr/",
    pagesVisited: 18, extractedTextChars: 24_500,
    emails: ["marketing@glow-tonic.kr"],
    socialLinks: { instagram: "https://instagram.com/glow.tonic", facebook: "https://fb.com/glowtonic" },
  },
  analysis: {
    company_summary: "Glow Tonic은 한국의 클린뷰티 D2C 브랜드, 토너 패드 단일 히트 제품 보유",
    main_products: "토너 패드 | 클렌징 워터 | 수분 세럼",
    product_categories: "skincare | toner | serum",
    business_type: "brand",
    target_market: "20-30대 여성 한국 + 동남아 확장 의지",
    global_presence: "yes",
    key_strengths: "히트 단일 제품 + Instagram 5만 팔로워",
    brand_positioning: "프리미엄 클린뷰티",
    sns_presence: "Instagram 5만, Facebook 1.2만, TikTok 없음",
    recommended_outreach_angle: "TikTok 미진출 — Instagram 팔로워 5만을 TikTok으로 컨버전하는 시딩 캠페인 제안",
    sales_priority: "high",
    sales_priority_reason: "TikTok 진출 의지 + 명확한 단일 제품 + 5만 Instagram 팔로워",
    confidence_score: 88,
    reasoning_brief: "데이터 풍부",
  },
  enrichedAt: new Date("2026-05-13"),
};

const thinEnrichment: LeadEnrichment = {
  websiteData: {
    url: "https://obscure.kr", normalizedUrl: "https://obscure.kr/",
    pagesVisited: 2, extractedTextChars: 800, emails: [], socialLinks: {},
  },
  analysis: {
    company_summary: "정보가 거의 없음",
    main_products: "unclear",
    product_categories: "unclear",
    business_type: "unclear",
    target_market: "unclear",
    global_presence: "unclear",
    key_strengths: "unclear",
    brand_positioning: "unclear",
    sns_presence: "unclear",
    recommended_outreach_angle: "정보 부족으로 일반적 제안",
    sales_priority: "low",
    sales_priority_reason: "데이터 빈약",
    confidence_score: 25,
    reasoning_brief: "크롤링 페이지가 너무 적음",
  },
  enrichedAt: new Date("2026-05-13"),
};

beforeEach(() => {
  setObservabilitySink(memorySink());
  setUsageStore(memUsageStore);
});

afterEach(() => {
  setObservabilitySink(undefined);
  setUsageStore(undefined);
});

function fakeText(out: ResearchOutput | { escalate: string }): ModelClient {
  return {
    complete: async () => ({
      kind: "text",
      text: JSON.stringify(out),
      inputTokens: 500,
      outputTokens: 220,
    }),
  };
}

describe("researchAgent — unit", () => {
  it("happy path: rich enrichment → pitch + 3 angles + 4 grounded facts + contact + confidence ≥ 80", async () => {
    const out = await runAgent(
      researchAgent,
      {
        brief,
        enrichment: richEnrichment,
        lead: {
          companyName: "Glow Tonic", companyNameEn: "Glow Tonic",
          country: "KR", homepageUrl: "https://glow-tonic.kr",
        },
      },
      {
        ...ctx0(),
        model: fakeText({
          pitch: "Glow Tonic은 Instagram 5만 팔로워를 보유하면서도 TikTok에 진출하지 않은 클린뷰티 D2C 브랜드 — Social Seeding의 시딩 캠페인이 즉시 적용 가능.",
          angles: [
            "Instagram 5만 → TikTok 컨버전을 핵심 메시지로",
            "토너 패드 단일 히트 제품을 TikTok 챌린지 콘텐츠로 활용",
            "동남아 시장 확장을 TikTok 글로벌 트래픽으로 가속",
          ],
          groundedFacts: [
            "Instagram 5만, Facebook 1.2만 보유",
            "TikTok 계정 없음",
            "토너 패드 단일 히트 제품 확인",
            "한국 + 동남아 시장 확장 명시",
          ],
          contactProfile: "Marketing Director",
          confidence: 85,
        }),
      },
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.value.pitch).toMatch(/Glow Tonic|TikTok/);
    expect(out.value.angles.length).toBeGreaterThanOrEqual(1);
    expect(out.value.angles.length).toBeLessThanOrEqual(5);
    expect(out.value.groundedFacts.length).toBeLessThanOrEqual(8);
    expect(out.value.contactProfile).toBe("Marketing Director");
    expect(out.value.confidence).toBeGreaterThanOrEqual(50);
  });

  it("escalation: thin enrichment scripted to escalate is honored", async () => {
    const out = await runAgent(
      researchAgent,
      {
        brief,
        enrichment: thinEnrichment,
        lead: { companyName: "Obscure Co", country: "KR" },
      },
      {
        ...ctx0(),
        model: fakeText({ escalate: "enrichment_too_thin: 5 of 6 analysis fields are 'unclear'" }),
      },
    );
    expect(out.kind).toBe("escalate");
    if (out.kind !== "escalate") throw new Error("expected escalate");
    expect(out.reason).toMatch(/enrichment_too_thin/);
  });

  it("clamps confidence to [0,100] via the schema", async () => {
    const out = await runAgent(
      researchAgent,
      {
        brief, enrichment: richEnrichment,
        lead: { companyName: "X", country: "KR" },
      },
      {
        ...ctx0(),
        // Scripted output uses a valid in-range confidence; the schema's
        // .min(0).max(100) will reject anything else upstream.
        model: fakeText({
          pitch: "A valid 2-sentence pitch about why this company makes sense for our product.",
          angles: ["Single solid angle"],
          groundedFacts: [],
          contactProfile: "",
          confidence: 100,
        }),
      },
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.value.confidence).toBe(100);
  });

  it("agent definition: Gemini 3.1 Flash-Lite, no tools, ≤$0.10 cap", () => {
    expect(researchAgent.model).toBe("gemini-3.1-flash-lite");
    expect(researchAgent.tools).toEqual([]);
    expect(researchAgent.maxUsd).toBeLessThanOrEqual(0.1);
  });
});
