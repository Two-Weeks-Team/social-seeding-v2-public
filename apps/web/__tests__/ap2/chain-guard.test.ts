import { describe, expect, it } from "vitest";
import type { IntentMandate } from "@/lib/ap2/mandate";
import { bindCart, bindPayment, type CartCore, type PaymentCore } from "@/lib/ap2/chain";
import { verifyRecommendationChain } from "@/lib/ap2/chain-guard";

const CNF = { jwk: { kty: "EC", crv: "P-256", x: "xcoord", y: "ycoord" } } as const;
const FAR_FUTURE = 9_999_999_999;
const NOW = 2_000;

function makeIntent(overrides: Partial<IntentMandate> = {}): IntentMandate {
  return {
    credential_type: "ap2.IntentMandate",
    version: "0.2.0",
    iss: "did:web:user.wooriliu.socialseed.ing",
    sub: "did:web:agent.payment-mandate.socialseed.ing",
    iat: 1_000,
    exp: FAR_FUTURE,
    jti: "intent-jti-1",
    shopping_intent: {
      category: "creator_payout",
      price_max: { amount: "1000.00", currency: "USD" },
      per_recipient_uplift_max: 1.2,
      merchant_allowlist: ["did:web:creator.example"],
      refundable_required: true,
    },
    prompt_playback: "pay the two shortlisted creators",
    delegation_mode: "human_present",
    cnf: CNF,
    ...overrides,
  };
}

function makeCartCore(overrides: Partial<CartCore> = {}): CartCore {
  return {
    credential_type: "ap2.CartMandate",
    version: "0.2.0",
    jti: "cart-jti-1",
    iat: 1_001,
    exp: FAR_FUTURE,
    items: [
      { sku: "c1", label: "Creator 1", quantity: 1, unit_price: { amount: "600.00", currency: "USD" }, line_total: { amount: "600.00", currency: "USD" } },
      { sku: "c2", label: "Creator 2", quantity: 1, unit_price: { amount: "400.00", currency: "USD" }, line_total: { amount: "400.00", currency: "USD" } },
    ],
    cart_total: { amount: "1000.00", currency: "USD" },
    cnf: CNF,
    ...overrides,
  };
}

function makePaymentCore(overrides: Partial<PaymentCore> = {}): PaymentCore {
  return {
    credential_type: "ap2.PaymentMandate",
    version: "0.2.0",
    jti: "pay-jti-1",
    iat: 1_002,
    exp: FAR_FUTURE,
    amount: { amount: "1000.00", currency: "USD" },
    partner: "stripe-connect",
    cnf: CNF,
    ...overrides,
  };
}

function validChainRecommendation(): { ap2Chain: unknown; question: string } {
  const intent = makeIntent();
  const cart = bindCart(intent, makeCartCore());
  const payment = bindPayment(cart, makePaymentCore());
  return { question: "Sign the payout?", ap2Chain: { intent, cart, payment } };
}

describe("AP2 chain guard — route enforcement seam (GT6)", () => {
  it("SKIPS when the recommendation carries no ap2Chain (Intent-only, D27)", () => {
    const res = verifyRecommendationChain({ question: "approve creator outreach?" }, { now: NOW });
    expect(res.checked).toBe(false);
  });

  it("SKIPS for non-object / nullish recommendations", () => {
    expect(verifyRecommendationChain(undefined).checked).toBe(false);
    expect(verifyRecommendationChain(null).checked).toBe(false);
    expect(verifyRecommendationChain("text").checked).toBe(false);
  });

  it("PASSES a well-formed, correctly-bound chain", () => {
    const res = verifyRecommendationChain(validChainRecommendation(), { now: NOW });
    expect(res.checked).toBe(true);
    expect(res).toMatchObject({ checked: true, ok: true, errors: [] });
  });

  it("REJECTS a tampered chain (Payment exceeds Intent ceiling)", () => {
    const intent = makeIntent();
    const cart = bindCart(intent, makeCartCore({
      items: [{ sku: "c1", label: "Creator 1", quantity: 1, unit_price: { amount: "2000.00", currency: "USD" }, line_total: { amount: "2000.00", currency: "USD" } }],
      cart_total: { amount: "2000.00", currency: "USD" },
    }));
    const payment = bindPayment(cart, makePaymentCore({ amount: { amount: "2000.00", currency: "USD" } }));
    const res = verifyRecommendationChain({ ap2Chain: { intent, cart, payment } }, { now: NOW });
    expect(res.checked).toBe(true);
    expect(res).toMatchObject({ ok: false });
    if (res.checked) {
      expect(res.errors.some((e) => e.includes("exceeds the Intent price_max"))).toBe(true);
    }
  });

  it("REJECTS a present-but-malformed ap2Chain (missing payment)", () => {
    const intent = makeIntent();
    const cart = bindCart(intent, makeCartCore());
    const res = verifyRecommendationChain({ ap2Chain: { intent, cart } }, { now: NOW });
    expect(res.checked).toBe(true);
    expect(res).toMatchObject({ ok: false });
    if (res.checked) {
      expect(res.errors[0]).toContain("malformed");
    }
  });
});
