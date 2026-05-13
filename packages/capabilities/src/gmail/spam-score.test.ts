import { describe, expect, it } from "vitest";
import { calculateSpamScore, DEFAULT_MAX_SPAM_SCORE, listSpamRules, riskFor } from "./spam-score";

/**
 * P2-C2c — spam-score. Pure; no env or DB. Mirrors v1's rule set so a/b
 * deliverability comparisons stay apples-to-apples.
 */

const clean = {
  subject: "Quick collab idea for your skincare content",
  // Pre-formatted with unsubscribe + an address so the no-unsubscribe and
  // no-address rules don't fire on the baseline draft.
  body: [
    "<p>Hi {{name}}, we loved your recent serum review on @{{username}}.</p>",
    "<p>Would you be open to a paid collab — 1 short, your own angle?</p>",
    "<p>If not relevant, unsubscribe here.</p>",
    "<p>Brand HQ — 12 Garosu-gil, Gangnam-gu, Seoul.</p>",
  ].join("\n"),
};

describe("spam-score", () => {
  it("clean baseline scores low (single rule may fire on long text/punctuation, but risk≤low)", () => {
    const r = calculateSpamScore(clean.subject, clean.body, "outreach@brand.example");
    expect(r.score).toBeLessThanOrEqual(2);
    expect(r.risk).toBe("low");
  });

  it("flags excessive caps when > 30% of letters are uppercase", () => {
    // Keep the draft short so the all-caps subject dominates the ratio.
    const r = calculateSpamScore("HUGE DEAL TODAY", "ACT NOW. WIN BIG. unsubscribe. address.");
    expect(r.triggered.map((h) => h.ruleId)).toContain("excessiveCaps");
  });

  it("flags spam-trigger phrases (English + Korean)", () => {
    const en = calculateSpamScore("Limited time free offer", clean.body);
    expect(en.triggered.map((h) => h.ruleId)).toContain("spamWords");
    const ko = calculateSpamScore("당첨!!", clean.body);
    expect(ko.triggered.map((h) => h.ruleId)).toContain("spamWords");
  });

  it("flags missing unsubscribe AND missing physical address", () => {
    const r = calculateSpamScore("Hi", "<p>Cool content. Want to talk?</p>");
    const ids = r.triggered.map((h) => h.ruleId);
    expect(ids).toContain("noUnsubscribe");
    expect(ids).toContain("noPhysicalAddress");
  });

  it("flags misleading Re:/Fwd: subjects on cold outreach", () => {
    const r = calculateSpamScore("Re: our chat", clean.body);
    expect(r.triggered.map((h) => h.ruleId)).toContain("misleadingSubject");
  });

  it("flags hidden text via display:none / white-on-white / font-size:0", () => {
    const ids = (body: string) =>
      calculateSpamScore("hi", body)
        .triggered.map((h) => h.ruleId)
        .filter((id) => id === "hiddenText");
    expect(ids('<span style="display: none">cloaked</span>')).toEqual(["hiddenText"]);
    expect(ids('<span style="color: white; background-color: white">cloaked</span>')).toEqual([
      "hiddenText",
    ]);
    expect(ids('<span style="font-size: 0">cloaked</span>')).toEqual(["hiddenText"]);
  });

  it("score caps at 10 even when many rules fire", () => {
    // Maximum-ugliness draft: caps, spam words, repeated punctuation, no unsub, hidden text, etc.
    const subject = "FREE!! ACT NOW!! WINNER!!";
    const body = '<span style="display:none">hide</span>Dear customer';
    const r = calculateSpamScore(subject, body);
    expect(r.score).toBe(10);
    expect(r.risk).toBe("very-high");
  });

  it("risk buckets are derived from the score boundary at 2 / 5 / 8", () => {
    expect(riskFor(0)).toBe("low");
    expect(riskFor(2)).toBe("low");
    expect(riskFor(3)).toBe("medium");
    expect(riskFor(5)).toBe("medium");
    expect(riskFor(6)).toBe("high");
    expect(riskFor(8)).toBe("high");
    expect(riskFor(9)).toBe("very-high");
  });

  it("listSpamRules exposes the canonical rule catalog (for MC tooltips)", () => {
    const cat = listSpamRules();
    expect(cat.length).toBeGreaterThanOrEqual(10);
    expect(cat.every((r) => typeof r.id === "string" && r.weight > 0)).toBe(true);
  });

  it("DEFAULT_MAX_SPAM_SCORE is a sane mid-high threshold (escalate above it)", () => {
    expect(DEFAULT_MAX_SPAM_SCORE).toBeGreaterThanOrEqual(5);
    expect(DEFAULT_MAX_SPAM_SCORE).toBeLessThanOrEqual(8);
  });
});
