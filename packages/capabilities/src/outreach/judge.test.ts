import { describe, expect, it } from "vitest";
import type { OutreachFacts } from "@ss/contracts";
import { JUDGE_WEIGHTS, weightedJudgeScore } from "@ss/contracts";
import { outreachJudge } from "./judge";

/**
 * P2-C3b — outreach.judge. Pure, deterministic. Verifies each of the 4
 * judges + the weighted tournament-score helper.
 */

const ctx = { workspaceId: "ws", userId: "u".repeat(21), rateLimitClass: "default" as const };

const facts: OutreachFacts = {
  creator: {
    uniqueId: "@freshly",
    nickname: "freshly",
    signature: "k-beauty / 수분",
    topHashtags: ["스킨케어", "kbeauty", "수분"],
    recentPostThemes: ["겨울철 보습 루틴", "신상 세럼 후기"],
    followerCount: 42_000,
    avgViews: 18_400,
    engagementRate: 0.034,
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

// A draft that cites a recent post theme + the brand name, has one CTA, and
// is in the 200–1500 char window. Anchors the "low-flags" baseline.
const goodDraft = {
  subject: "Quick collab idea for your skincare content",
  body:
    "<p>Hi @freshly, your '겨울철 보습 루틴' video got me — that's exactly the moment our Hydra Serum was built for.</p>" +
    "<p>Open to sending you a sample? No script — your own angle. Brand HQ — 12 Garosu-gil, Gangnam-gu, Seoul.</p>" +
    "<p>If not relevant, unsubscribe here.</p>",
};

describe("outreach.judge — brand", () => {
  it("clean draft scores high; brand name present, no banned phrases", async () => {
    const card = await outreachJudge.handler(
      { judge: "brand", draft: goodDraft, facts, bannedPhrases: [] },
      ctx,
    );
    expect(card.judge).toBe("brand");
    expect(card.score).toBeGreaterThanOrEqual(0.9);
    expect(card.flags).toEqual([]);
  });

  it("missing brand name → flag + score drop", async () => {
    const card = await outreachJudge.handler(
      {
        judge: "brand",
        draft: { ...goodDraft, body: goodDraft.body.replace("Hydra Serum", "our product") },
        facts,
        bannedPhrases: [],
      },
      ctx,
    );
    expect(card.flags).toContain("brand_name_missing");
    expect(card.score).toBeLessThan(0.7);
  });

  it("banned phrase used → flag + drop", async () => {
    const card = await outreachJudge.handler(
      { judge: "brand", draft: goodDraft, facts, bannedPhrases: ["got me"] },
      ctx,
    );
    expect(card.flags).toContain("banned_phrase_used");
    expect(card.score).toBeLessThan(0.9);
  });

  it("promises a free sample when policy says shipsSamples=false → hard flag", async () => {
    const noShipFacts: OutreachFacts = { ...facts, logistics: { shipsSamples: false } };
    const card = await outreachJudge.handler(
      {
        judge: "brand",
        draft: { subject: "x", body: "We'd love to send you a free sample of Hydra Serum — interested? unsubscribe address" },
        facts: noShipFacts,
        bannedPhrases: [],
      },
      ctx,
    );
    expect(card.flags).toContain("sample_promised_against_policy");
    expect(card.score).toBeLessThan(0.7);
  });
});

describe("outreach.judge — conversion", () => {
  it("good draft (one CTA, 200–1500 chars, cites a fact) → high score, no flags", async () => {
    const card = await outreachJudge.handler(
      { judge: "conversion", draft: goodDraft, facts, bannedPhrases: [] },
      ctx,
    );
    expect(card.judge).toBe("conversion");
    expect(card.flags).toEqual([]);
    expect(card.score).toBe(1);
  });

  it("no CTA (no '?' in body) → no_cta flag", async () => {
    const card = await outreachJudge.handler(
      {
        judge: "conversion",
        draft: { ...goodDraft, body: goodDraft.body.replace("?", ".") },
        facts,
        bannedPhrases: [],
      },
      ctx,
    );
    expect(card.flags).toContain("no_cta");
  });

  it("no specific fact cited → no_specific_fact_cited flag", async () => {
    const card = await outreachJudge.handler(
      {
        judge: "conversion",
        draft: {
          subject: "Collab idea",
          body: "<p>Hello, we're a skincare brand and we'd love to send you something. Interested? unsubscribe.</p>",
        },
        facts,
        bannedPhrases: [],
      },
      ctx,
    );
    expect(card.flags).toContain("no_specific_fact_cited");
    expect(card.flags).toContain("body_too_short"); // also short
  });

  it("oversized subject → subject_length_out_of_band", async () => {
    const card = await outreachJudge.handler(
      {
        judge: "conversion",
        draft: { ...goodDraft, subject: "x".repeat(120) },
        facts,
        bannedPhrases: [],
      },
      ctx,
    );
    expect(card.flags).toContain("subject_length_out_of_band");
  });
});

describe("outreach.judge — deliverability", () => {
  it("clean draft → spam score low → judge score high", async () => {
    const card = await outreachJudge.handler(
      { judge: "deliverability", draft: goodDraft, facts, bannedPhrases: [] },
      ctx,
    );
    expect(card.score).toBeGreaterThan(0.7);
    expect(card.rationale).toMatch(/Spam score/);
  });

  it("spammy draft → judge score plummets", async () => {
    const card = await outreachJudge.handler(
      {
        judge: "deliverability",
        draft: {
          subject: "FREE!! WINNER!! URGENT!!",
          body: '<span style="display:none">hide</span>Dear customer',
        },
        facts,
        bannedPhrases: [],
      },
      ctx,
    );
    expect(card.score).toBeLessThan(0.2);
    expect(card.flags.length).toBeGreaterThan(0);
  });
});

describe("outreach.judge — skeptic", () => {
  it("concrete cite → high score, no_concrete_reference flag absent", async () => {
    const card = await outreachJudge.handler(
      { judge: "skeptic", draft: goodDraft, facts, bannedPhrases: [] },
      ctx,
    );
    expect(card.score).toBeGreaterThan(0.9);
    expect(card.flags).not.toContain("no_concrete_reference");
  });

  it("generic greeting + vague flattery → multiple flags", async () => {
    const card = await outreachJudge.handler(
      {
        judge: "skeptic",
        draft: {
          subject: "Quick collab",
          body: "<p>Dear creator, we love your content! Want to chat?</p>",
        },
        facts,
        bannedPhrases: [],
      },
      ctx,
    );
    expect(card.flags).toContain("generic_greeting");
    expect(card.flags).toContain("vague_flattery");
    expect(card.score).toBeLessThan(0.5);
  });
});

describe("JUDGE_WEIGHTS + weightedJudgeScore", () => {
  it("weights match v1 verbatim: skeptic 0.4 / conversion 0.3 / deliverability 0.15 / brand 0.15", () => {
    expect(JUDGE_WEIGHTS.skeptic).toBe(0.4);
    expect(JUDGE_WEIGHTS.conversion).toBe(0.3);
    expect(JUDGE_WEIGHTS.deliverability).toBe(0.15);
    expect(JUDGE_WEIGHTS.brand).toBe(0.15);
    expect(
      JUDGE_WEIGHTS.skeptic + JUDGE_WEIGHTS.conversion + JUDGE_WEIGHTS.deliverability + JUDGE_WEIGHTS.brand,
    ).toBeCloseTo(1, 6);
  });

  it("weightedJudgeScore: 4 cards all 1.0 → weighted sum 1.0; one 0 → drops by that judge's weight", () => {
    const cards = [
      { judge: "brand" as const, score: 1, rationale: "x", flags: [] },
      { judge: "conversion" as const, score: 1, rationale: "x", flags: [] },
      { judge: "deliverability" as const, score: 1, rationale: "x", flags: [] },
      { judge: "skeptic" as const, score: 1, rationale: "x", flags: [] },
    ];
    expect(weightedJudgeScore(cards)).toBeCloseTo(1, 6);
    cards[3]!.score = 0;
    expect(weightedJudgeScore(cards)).toBeCloseTo(1 - 0.4, 6); // skeptic weight = 0.4
  });

  it("empty cards → 0 (defensive)", () => {
    expect(weightedJudgeScore([])).toBe(0);
  });
});
