/**
 * Pure-helper tests for lib/ap2/*. Vitest only, no DOM.
 *
 * D-IDs touched:
 *   D27 — Intent-only protocol surface; schemas verified verbatim.
 *   D34 — currency formatting per locale.
 *
 * Edge cases (EC-2.29) covered:
 *   - UUIDv7 monotonicity within the same millisecond.
 *   - Timestamp extraction round-trips.
 */

import { describe, expect, it } from "vitest";
import { ApprovalSchema, PaymentMandateRecommendationSchema } from "@ss/contracts";
import {
  AP2_STATE_TONE,
  expiryGuard,
  formatMoney,
  formatMoneyAriaLabel,
  isPaymentMandateDraft,
  IntentMandateSchema,
  isZeroDecimalCurrency,
  moneyGreaterThan,
  PaymentMandateDraftSchema,
  RejectMandateRequestSchema,
  SignMandateRequestSchema,
  sumMoney,
  uuidv7,
  uuidv7Timestamp,
  DEFAULT_HIGH_VALUE_THRESHOLD,
} from "../../lib/ap2/mandate";
import {
  PARTNER_COUNT,
  PAYMENT_PARTNERS,
  findPartner,
  partnerBreakdown,
  partnerOrUnknown,
} from "../../lib/ap2/partner-registry";
import {
  authenticatorTransportFor,
  base64UrlToBuffer,
  bufferToBase64Url,
  canonicalize,
} from "../../lib/ap2/webauthn";

describe("uuidv7 (EC-2.29 replay nonce)", () => {
  it("produces 36-char dashed strings", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("embeds the ms timestamp such that uuidv7Timestamp round-trips", () => {
    const now = 1747641600000;
    const id = uuidv7(now);
    expect(uuidv7Timestamp(id)).toBe(now);
  });

  it("rejects non-v7 inputs", () => {
    expect(uuidv7Timestamp("not-a-uuid")).toBeNull();
    expect(uuidv7Timestamp("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("generates distinct ids in tight loops", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(uuidv7());
    expect(ids.size).toBe(100);
  });
});

describe("Money formatting (D34)", () => {
  it("formats KRW with no decimals", () => {
    expect(formatMoney({ amount: "2340000", currency: "KRW" }, "ko")).toMatch(/2,340,000/);
  });

  it("formats USD with two decimals", () => {
    expect(formatMoney({ amount: "147.34", currency: "USD" }, "en")).toBe("$147.34");
  });

  it("formats JPY with no decimals", () => {
    expect(formatMoney({ amount: "16200", currency: "JPY" }, "ja")).toMatch(/16,200/);
  });

  it("formats CNY with two decimals", () => {
    expect(formatMoney({ amount: "1070.00", currency: "CNY" }, "zh")).toMatch(/1,070/);
  });

  it("aria-label includes the currency name", () => {
    const label = formatMoneyAriaLabel({ amount: "2340000", currency: "KRW" }, "en");
    expect(label).toMatch(/Korean/);
  });

  it("isZeroDecimalCurrency identifies KRW + JPY only", () => {
    expect(isZeroDecimalCurrency("KRW")).toBe(true);
    expect(isZeroDecimalCurrency("JPY")).toBe(true);
    expect(isZeroDecimalCurrency("USD")).toBe(false);
    expect(isZeroDecimalCurrency("CNY")).toBe(false);
  });
});

describe("sumMoney", () => {
  it("sums KRW (zero-decimal) accurately", () => {
    const out = sumMoney([
      { amount: "504000", currency: "KRW" },
      { amount: "320000", currency: "KRW" },
      { amount: "480000", currency: "KRW" },
    ]);
    expect(out).toEqual({ amount: "1304000", currency: "KRW" });
  });

  // Codex PR-fix: https://github.com/Two-Weeks-Team/social-seeding-v2/pull/1#discussion_r3266224734
  // Regression for zero-decimal cent-scaling — previously the BigInt total
  // was returned without dividing out the ×100 padding, inflating by 100×.
  it("sums JPY (zero-decimal) accurately — does not inflate by 100×", () => {
    const out = sumMoney([
      { amount: "16200", currency: "JPY" },
      { amount: "8000", currency: "JPY" },
      { amount: "4100", currency: "JPY" },
    ]);
    expect(out).toEqual({ amount: "28300", currency: "JPY" });
  });

  it("sums a single KRW item without inflating (regression)", () => {
    const out = sumMoney([{ amount: "1000000", currency: "KRW" }]);
    expect(out).toEqual({ amount: "1000000", currency: "KRW" });
  });

  it("sums USD with cent precision", () => {
    const out = sumMoney([
      { amount: "100.50", currency: "USD" },
      { amount: "47.00", currency: "USD" },
      { amount: "0.84", currency: "USD" },
    ]);
    expect(out).toEqual({ amount: "148.34", currency: "USD" });
  });

  it("sums EUR / GBP with cent precision (regression — two-decimal path unchanged)", () => {
    expect(
      sumMoney([
        { amount: "10.00", currency: "EUR" },
        { amount: "5.50", currency: "EUR" },
      ]),
    ).toEqual({ amount: "15.50", currency: "EUR" });
    expect(
      sumMoney([
        { amount: "99.99", currency: "GBP" },
        { amount: "0.01", currency: "GBP" },
      ]),
    ).toEqual({ amount: "100.00", currency: "GBP" });
  });

  it("throws on mixed currencies", () => {
    expect(() =>
      sumMoney([
        { amount: "100", currency: "USD" },
        { amount: "1000", currency: "KRW" },
      ]),
    ).toThrow(/mixed currencies/);
  });
});

describe("moneyGreaterThan", () => {
  it("compares same-currency amounts numerically", () => {
    expect(moneyGreaterThan({ amount: "1000", currency: "KRW" }, { amount: "500", currency: "KRW" })).toBe(true);
    expect(moneyGreaterThan({ amount: "500", currency: "KRW" }, { amount: "1000", currency: "KRW" })).toBe(false);
  });

  it("throws on cross-currency comparison", () => {
    expect(() => moneyGreaterThan({ amount: "1", currency: "USD" }, { amount: "1", currency: "KRW" })).toThrow();
  });
});

describe("expiryGuard", () => {
  it("returns expired=true when seconds remaining is non-positive", () => {
    const exp = Math.floor(Date.now() / 1000) - 5;
    const g = expiryGuard(exp);
    expect(g.expired).toBe(true);
    expect(g.block).toBe(true);
  });

  it("blocks within the 60-second pre-expiry window", () => {
    const exp = Math.floor(Date.now() / 1000) + 30;
    const g = expiryGuard(exp);
    expect(g.expired).toBe(false);
    expect(g.block).toBe(true);
  });

  it("warns at <1h but doesn't block", () => {
    const exp = Math.floor(Date.now() / 1000) + 1800;
    const g = expiryGuard(exp);
    expect(g.warn).toBe(true);
    expect(g.block).toBe(false);
  });
});

describe("Partner registry (60+ AP2 partners)", () => {
  it("PARTNER_COUNT is ≥ 60", () => {
    expect(PARTNER_COUNT).toBeGreaterThanOrEqual(60);
    expect(PAYMENT_PARTNERS.length).toBe(PARTNER_COUNT);
  });

  it("findPartner returns the entry by id", () => {
    expect(findPartner("adyen")?.displayName).toBe("Adyen");
    expect(findPartner("paypal")?.apNative).toBe(true);
  });

  it("Stripe and Visa are marked NOT AP2-native", () => {
    expect(findPartner("stripe")?.apNative).toBe(false);
    expect(findPartner("visa")?.apNative).toBe(false);
  });

  it("Toss / KakaoPay / NaverPay are present (KR-region) but not AP2-native", () => {
    expect(findPartner("toss")?.apNative).toBe(false);
    expect(findPartner("kakaopay")?.apNative).toBe(false);
    expect(findPartner("naverpay")?.apNative).toBe(false);
  });

  it("partnerOrUnknown returns a fallback partner for unknown ids", () => {
    const p = partnerOrUnknown("unknown-xyz");
    expect(p.apNative).toBe(false);
    expect(p.icon).toBe("?");
  });

  it("partnerBreakdown groups counts and AP2-native split", () => {
    const out = partnerBreakdown(["adyen", "adyen", "stripe", "paypal"]);
    expect(out.apNative).toBe(3);
    expect(out.orchestrated).toBe(1);
    expect(out.counts.get("adyen")).toBe(2);
  });
});

describe("Zod schemas (PROTOCOLS.md §2 verbatim)", () => {
  it("IntentMandateSchema accepts a minimal valid mandate", () => {
    const ok = IntentMandateSchema.safeParse({
      credential_type: "ap2.IntentMandate",
      version: "0.2.0",
      iss: "did:web:user.example.com",
      sub: "did:web:shopper.example.ai",
      iat: 1747641600,
      exp: 1747728000,
      jti: "intent-7f3",
      shopping_intent: {
        category: "creator_payout",
        price_max: { amount: "150.00", currency: "USD" },
        per_recipient_uplift_max: 1.2,
        merchant_allowlist: ["did:web:adyen.com"],
        refundable_required: true,
      },
      prompt_playback: "pay 5 creators",
      delegation_mode: "human_present",
      cnf: {
        jwk: { kty: "EC", crv: "P-256", x: "abc", y: "def" },
      },
    });
    expect(ok.success).toBe(true);
  });

  it("rejects an Intent Mandate without a merchant_allowlist", () => {
    const bad = IntentMandateSchema.safeParse({
      credential_type: "ap2.IntentMandate",
      version: "0.2.0",
      iss: "did:web:user.example.com",
      sub: "did:web:agent",
      iat: 1,
      exp: 2,
      jti: "j",
      shopping_intent: {
        category: "creator_payout",
        price_max: { amount: "1", currency: "USD" },
        per_recipient_uplift_max: 1.2,
        merchant_allowlist: [],
        refundable_required: true,
      },
      prompt_playback: "x",
      delegation_mode: "human_present",
      cnf: { jwk: { kty: "EC", crv: "P-256", x: "a", y: "b" } },
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an Intent Mandate with non-did:web sub", () => {
    const bad = IntentMandateSchema.safeParse({
      credential_type: "ap2.IntentMandate",
      version: "0.2.0",
      iss: "did:web:user.example.com",
      sub: "http://wrong",
      iat: 1,
      exp: 2,
      jti: "j",
      shopping_intent: {
        category: "creator_payout",
        price_max: { amount: "1", currency: "USD" },
        per_recipient_uplift_max: 1.2,
        merchant_allowlist: ["did:web:x.com"],
        refundable_required: true,
      },
      prompt_playback: "x",
      delegation_mode: "human_present",
      cnf: { jwk: { kty: "EC", crv: "P-256", x: "a", y: "b" } },
    });
    expect(bad.success).toBe(false);
  });

  it("PaymentMandateDraftSchema validates a complete payload", () => {
    const draft = {
      jti: uuidv7(),
      exp: Math.floor(Date.now() / 1000) + 3600,
      intent: {
        category: "creator_payout",
        price_max: { amount: "100", currency: "USD" },
        per_recipient_uplift_max: 1.2,
        merchant_allowlist: ["did:web:adyen.com"],
        refundable_required: true,
      },
      delegation_mode: "human_present",
      recipients: [
        {
          creatorId: "c1",
          uniqueId: "kr_petlover",
          proposedAmount: { amount: "50", currency: "USD" },
          judgeSummary: ["pass", "pass", "pass", "pass"],
          pipaConsentVerified: true,
        },
      ],
      initialChips: [{ chip: "within-budget", passed: true }],
      partner: "adyen",
      totalAmount: { amount: "50", currency: "USD" },
      composedAt: Math.floor(Date.now() / 1000),
    };
    expect(PaymentMandateDraftSchema.safeParse(draft).success).toBe(true);
    expect(isPaymentMandateDraft(draft)).toBe(true);
  });

  it("SignMandateRequestSchema requires the WebAuthn assertion shape", () => {
    const ok = SignMandateRequestSchema.safeParse({
      approvalId: "a1",
      nonce: uuidv7(),
      webAuthnAssertion: {
        id: "cred-id",
        rawId: "rawid-b64",
        type: "public-key",
        response: {
          clientDataJSON: "client-b64",
          authenticatorData: "auth-b64",
          signature: "sig-b64",
        },
      },
    });
    expect(ok.success).toBe(true);
  });

  it("RejectMandateRequestSchema enforces the structured reason enum", () => {
    const ok = RejectMandateRequestSchema.safeParse({
      approvalId: "a1",
      reason: "amount_too_high",
    });
    expect(ok.success).toBe(true);
    const bad = RejectMandateRequestSchema.safeParse({
      approvalId: "a1",
      reason: "freeform",
    });
    expect(bad.success).toBe(false);
  });
});

describe("ApprovalSchema — payment_mandate kind (D27)", () => {
  // Codex PR-fix: https://github.com/Two-Weeks-Team/social-seeding-v2/pull/1#discussion_r3266224720
  // The drill-in branch in apps/web/app/(mission-control)/approvals/[id]/page.tsx
  // assumes ApprovalSchema accepts kind="payment_mandate"; without it the parse
  // throws before the branch is reached and sign/reject routes fail.
  it("accepts kind = 'payment_mandate'", () => {
    const parsed = ApprovalSchema.safeParse({
      id: "a1",
      workspaceId: "ws1",
      campaignId: "camp1",
      kind: "payment_mandate",
      recommendation: { jti: "j1" },
      rationale: "AP2 Intent Mandate composed for 3 creator payouts (조사 완료된 후보들).",
      createdAt: new Date(),
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.kind).toBe("payment_mandate");
    }
  });

  it("still accepts the four legacy kinds (regression)", () => {
    for (const kind of ["shortlist", "outreach_send", "reply_response", "shipment"] as const) {
      const parsed = ApprovalSchema.safeParse({
        id: "a1",
        workspaceId: "ws1",
        campaignId: "camp1",
        kind,
        recommendation: {},
        rationale: "regression",
        createdAt: new Date(),
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("PaymentMandateRecommendationSchema accepts the structural shape", () => {
    const ok = PaymentMandateRecommendationSchema.safeParse({
      jti: uuidv7(),
      exp: Math.floor(Date.now() / 1000) + 3600,
      delegation_mode: "human_present",
      recipients: [{ creatorId: "c1" }],
      partner: "adyen",
      totalAmount: { amount: "1000000", currency: "KRW" },
      composedAt: Math.floor(Date.now() / 1000),
    });
    expect(ok.success).toBe(true);
  });
});

describe("State tone mapping (AP2-UX §8)", () => {
  it("emits emerald for terminal-success states (PAID, SETTLED)", () => {
    expect(AP2_STATE_TONE.PAID).toBe("emerald");
    expect(AP2_STATE_TONE.SETTLED).toBe("emerald");
  });
  it("emits rose for terminal-failure states (REJECTED, REFUNDED)", () => {
    expect(AP2_STATE_TONE.REJECTED).toBe("rose");
    expect(AP2_STATE_TONE.REFUNDED).toBe("rose");
  });
  it("emits amber for PENDING / AWAITING_PAYMENT_HUMAN", () => {
    expect(AP2_STATE_TONE.PENDING).toBe("amber");
    expect(AP2_STATE_TONE.AWAITING_PAYMENT_HUMAN).toBe("amber");
  });
});

describe("WebAuthn helpers", () => {
  it("base64url round-trips", () => {
    const data = new Uint8Array([1, 2, 3, 250, 251, 252]);
    const encoded = bufferToBase64Url(data);
    const decoded = base64UrlToBuffer(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(data));
  });

  it("canonicalize sorts keys and omits undefined", () => {
    expect(canonicalize({ b: 2, a: 1 })).toBe(`{"a":1,"b":2}`);
    expect(canonicalize({ a: 1, b: undefined })).toBe(`{"a":1}`);
  });

  it("authenticatorTransportFor picks platform under threshold", () => {
    const transport = authenticatorTransportFor(
      { amount: "100", currency: "KRW" },
      "ko",
    );
    expect(transport).toBe("platform");
  });

  it("authenticatorTransportFor escalates above threshold", () => {
    const transport = authenticatorTransportFor(
      DEFAULT_HIGH_VALUE_THRESHOLD.ko,
      "ko",
    );
    expect(transport).toBe("cross-platform");
  });

  it("authenticatorTransportFor is conservative on currency mismatch", () => {
    const transport = authenticatorTransportFor(
      { amount: "1", currency: "USD" },
      "ko",
    );
    expect(transport).toBe("cross-platform");
  });
});
