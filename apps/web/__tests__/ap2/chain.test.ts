import { describe, expect, it } from "vitest";
import type { IntentMandate } from "@/lib/ap2/mandate";
import {
  bindCart,
  bindPayment,
  canonicalizeMandate,
  hashMandate,
  verifyMandateChain,
  type CartCore,
  type PaymentCore,
} from "@/lib/ap2/chain";

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

describe("AP2 mandate chain — canonicalize + hash", () => {
  it("canonicalization is stable regardless of key order", () => {
    expect(canonicalizeMandate({ b: 1, a: 2 })).toBe(canonicalizeMandate({ a: 2, b: 1 }));
  });
  it("drops undefined properties (so optional fields don't change the hash)", () => {
    expect(hashMandate({ a: 1, b: undefined })).toBe(hashMandate({ a: 1 }));
  });
  it("hash is a 64-char hex digest and changes on any content change", () => {
    const h = hashMandate(makeIntent());
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashMandate(makeIntent({ jti: "different" }))).not.toBe(h);
  });
});

describe("AP2 mandate chain — bind + verify (happy path)", () => {
  it("binds Cart→Intent and Payment→Cart and verifies the full chain", () => {
    const intent = makeIntent();
    const cart = bindCart(intent, makeCartCore());
    const payment = bindPayment(cart, makePaymentCore());

    expect(cart.intent_jti).toBe(intent.jti);
    expect(cart.intent_hash).toBe(hashMandate(intent));
    expect(payment.cart_jti).toBe(cart.jti);
    expect(payment.cart_hash).toBe(hashMandate(cart));

    const res = verifyMandateChain(intent, cart, payment, { now: NOW });
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });
});

describe("AP2 mandate chain — rejects broken invariants", () => {
  it("rejects a TAMPERED Intent (hash no longer matches)", () => {
    const intent = makeIntent();
    const cart = bindCart(intent, makeCartCore());
    const payment = bindPayment(cart, makePaymentCore());
    // Operator-undetectable swap: a different Intent with the same jti.
    const tampered = makeIntent({ prompt_playback: "pay 10x more" });
    const res = verifyMandateChain(tampered, cart, payment, { now: NOW });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("intent_hash"))).toBe(true);
  });

  it("rejects a Payment that references the WRONG Cart", () => {
    const intent = makeIntent();
    const cart = bindCart(intent, makeCartCore());
    const otherCart = bindCart(intent, makeCartCore({ jti: "cart-jti-2" }));
    const payment = bindPayment(otherCart, makePaymentCore());
    const res = verifyMandateChain(intent, cart, payment, { now: NOW });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("cart_jti") || e.includes("cart_hash"))).toBe(true);
  });

  it("rejects Payment amount that EXCEEDS the Intent price_max ceiling", () => {
    const intent = makeIntent();
    const cart = bindCart(intent, makeCartCore({
      items: [{ sku: "c1", label: "Creator 1", quantity: 1, unit_price: { amount: "2000.00", currency: "USD" }, line_total: { amount: "2000.00", currency: "USD" } }],
      cart_total: { amount: "2000.00", currency: "USD" },
    }));
    const payment = bindPayment(cart, makePaymentCore({ amount: { amount: "2000.00", currency: "USD" } }));
    const res = verifyMandateChain(intent, cart, payment, { now: NOW });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("exceeds the Intent price_max"))).toBe(true);
  });

  it("rejects when cart_total != sum of line_totals", () => {
    const intent = makeIntent();
    const cart = bindCart(intent, makeCartCore({ cart_total: { amount: "999.00", currency: "USD" } }));
    const payment = bindPayment(cart, makePaymentCore({ amount: { amount: "999.00", currency: "USD" } }));
    const res = verifyMandateChain(intent, cart, payment, { now: NOW });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("sum of item line_totals"))).toBe(true);
  });

  it("rejects when payment.amount != cart_total", () => {
    const intent = makeIntent();
    const cart = bindCart(intent, makeCartCore());
    const payment = bindPayment(cart, makePaymentCore({ amount: { amount: "500.00", currency: "USD" } }));
    const res = verifyMandateChain(intent, cart, payment, { now: NOW });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("does not equal cart_total"))).toBe(true);
  });

  it("rejects an EXPIRED mandate", () => {
    const intent = makeIntent({ exp: 1_500 });
    const cart = bindCart(intent, makeCartCore());
    const payment = bindPayment(cart, makePaymentCore());
    const res = verifyMandateChain(intent, cart, payment, { now: NOW });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("expired"))).toBe(true);
  });

  it("rejects a currency mismatch across the chain", () => {
    const intent = makeIntent();
    const cart = bindCart(intent, makeCartCore());
    const payment = bindPayment(cart, makePaymentCore({ amount: { amount: "1000.00", currency: "KRW" } }));
    const res = verifyMandateChain(intent, cart, payment, { now: NOW });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("currency mismatch"))).toBe(true);
  });
});
