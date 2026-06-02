/**
 * AP2 v0.2 Mandate **chain** — Intent → Cart → Payment binding.
 *
 * `mandate.ts` defines the Intent Mandate (the only one composed client-side,
 * D27) and the UI-facing PaymentMandateDraft. The official AP2 spec
 * (github.com/google-agentic-commerce/AP2, §"Mandate System") represents every
 * agent purchase as **three signed Mandates**, each cryptographically bound to
 * its predecessor via a hash so the audit trail is unbreakable:
 *
 *   Intent  ──hash──▶  Cart  ──hash──▶  Payment
 *
 * Previously the chain existed only as a comment in `mandate.ts` ("enforced
 * server-side by the AP2 verifier service") with no code. This module makes the
 * **binding + verification** real and unit-tested. It is the data-model /
 * integrity layer:
 *
 *   - `canonicalizeMandate` — RFC-8785-lite JCS (sorted keys, undefined dropped)
 *     so the same mandate always hashes to the same digest.
 *   - `hashMandate` — SHA-256 (hex) over the canonical form.
 *   - `bindCart` / `bindPayment` — stamp the predecessor's hash + jti.
 *   - `verifyMandateChain` — recompute the hashes and assert every link, plus
 *     the scope ceiling (Payment ≤ Intent `price_max`) and expiry.
 *
 * What this module deliberately does NOT do: the **VC signature** (Cloud KMS /
 * WebAuthn SD-JWT). That stays the operator/KMS path (see `HONEST-SCOPE §4 AP2`)
 * — this is the verifiable *binding*, not the signing. The two compose: a
 * verifier checks the chain (here) AND each mandate's JWS (KMS, operator-gated).
 *
 * Citations: AP2 §Mandate System (Intent/Cart/Payment, hash-chained) ·
 * D27 (Intent-only client compose, human-signed) · RFC 8785 (JCS).
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  ConfirmationSchema,
  CurrencySchema,
  MoneySchema,
  PaymentPartnerIdSchema,
  moneyGreaterThanOrEqual,
  type IntentMandate,
  type Money,
} from "./mandate";

/** 64-char lowercase hex (SHA-256 digest). */
const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, "must be 64-char hex SHA-256");

/** One line item in a Cart Mandate. */
export const CartItemSchema = z.object({
  /** Stable SKU / creator-payout id. */
  sku: z.string().min(1),
  /** Human label (display only). */
  label: z.string().min(1),
  /** Whole-unit quantity (≥ 1). */
  quantity: z.number().int().positive(),
  /** Per-unit price. */
  unit_price: MoneySchema,
  /** quantity × unit_price — recomputed + checked by the verifier. */
  line_total: MoneySchema,
});
export type CartItem = z.infer<typeof CartItemSchema>;

/**
 * AP2 Cart Mandate — the concrete basket the user confirms. Binds to the Intent
 * via `intent_jti` + `intent_hash` (SHA-256 of the canonical Intent).
 */
export const CartMandateSchema = z.object({
  credential_type: z.literal("ap2.CartMandate"),
  version: z.literal("0.2.0"),
  jti: z.string().min(1),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
  /** Back-link to the Intent Mandate this cart fulfils. */
  intent_jti: z.string().min(1),
  intent_hash: Sha256HexSchema,
  items: z.array(CartItemSchema).min(1),
  cart_total: MoneySchema,
  cnf: ConfirmationSchema,
});
export type CartMandate = z.infer<typeof CartMandateSchema>;

/**
 * AP2 Payment Mandate (canonical — distinct from the UI `PaymentMandateDraft`).
 * Binds to the Cart via `cart_jti` + `cart_hash`. Shared with the payment rail.
 */
export const PaymentMandateSchema = z.object({
  credential_type: z.literal("ap2.PaymentMandate"),
  version: z.literal("0.2.0"),
  jti: z.string().min(1),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
  /** Back-link to the Cart Mandate this payment settles. */
  cart_jti: z.string().min(1),
  cart_hash: Sha256HexSchema,
  /** Authorized amount — must equal the cart total and not exceed Intent ceiling. */
  amount: MoneySchema,
  partner: PaymentPartnerIdSchema,
  cnf: ConfirmationSchema,
});
export type PaymentMandate = z.infer<typeof PaymentMandateSchema>;

/** Cart core fields the agent fills before binding (no predecessor link yet). */
export type CartCore = Omit<CartMandate, "intent_jti" | "intent_hash">;
/** Payment core fields the agent fills before binding. */
export type PaymentCore = Omit<PaymentMandate, "cart_jti" | "cart_hash">;

/**
 * Deterministic JSON canonicalization (RFC 8785 / JCS, simplified): object keys
 * sorted lexicographically at every depth, `undefined` properties dropped,
 * arrays preserved in order. Numbers/strings/booleans/null via `JSON.stringify`.
 * The same logical mandate therefore always serializes byte-identically, so its
 * SHA-256 is stable across compose-time and verify-time.
 */
export function canonicalizeMandate(value: unknown): string {
  const enc = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(enc);
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const child = obj[key];
      if (child === undefined) continue;
      out[key] = enc(child);
    }
    return out;
  };
  return JSON.stringify(enc(value));
}

/** SHA-256 (lowercase hex) over the canonical form of a mandate. */
export function hashMandate(value: unknown): string {
  return createHash("sha256").update(canonicalizeMandate(value), "utf8").digest("hex");
}

/** Bind a Cart core to its Intent — stamps `intent_jti` + `intent_hash`. */
export function bindCart(intent: IntentMandate, core: CartCore): CartMandate {
  return CartMandateSchema.parse({
    ...core,
    intent_jti: intent.jti,
    intent_hash: hashMandate(intent),
  });
}

/** Bind a Payment core to its Cart — stamps `cart_jti` + `cart_hash`. */
export function bindPayment(cart: CartMandate, core: PaymentCore): PaymentMandate {
  return PaymentMandateSchema.parse({
    ...core,
    cart_jti: cart.jti,
    cart_hash: hashMandate(cart),
  });
}

function sameCurrency(a: Money, b: Money): boolean {
  return CurrencySchema.parse(a.currency) === CurrencySchema.parse(b.currency);
}

/** Money equality without IEEE-754 drift (uses the chain's `>=` both ways). */
function moneyEquals(a: Money, b: Money): boolean {
  return sameCurrency(a, b) && moneyGreaterThanOrEqual(a, b) && moneyGreaterThanOrEqual(b, a);
}

export interface ChainVerifyResult {
  ok: boolean;
  errors: string[];
}

/**
 * Verify the full Intent → Cart → Payment chain. Pure + deterministic.
 *
 * Checks, in order (all collected, never short-circuits — the caller sees every
 * broken invariant):
 *   1. Cart links the right Intent (`intent_jti`) and its hash matches.
 *   2. Payment links the right Cart (`cart_jti`) and its hash matches.
 *   3. Currency is consistent across Intent ceiling, cart total, payment amount.
 *   4. `cart_total` equals the sum of line totals.
 *   5. `payment.amount` equals `cart_total` and does not exceed Intent `price_max`.
 *   6. None of the three mandates is expired at `now` (UNIX seconds, default = real now).
 */
export function verifyMandateChain(
  intent: IntentMandate,
  cart: CartMandate,
  payment: PaymentMandate,
  opts?: { now?: number },
): ChainVerifyResult {
  const errors: string[] = [];
  const now = opts?.now ?? Math.floor(Date.now() / 1000);

  // 1. Intent ↔ Cart
  if (cart.intent_jti !== intent.jti) {
    errors.push(`cart.intent_jti (${cart.intent_jti}) does not reference intent.jti (${intent.jti})`);
  }
  if (cart.intent_hash !== hashMandate(intent)) {
    errors.push("cart.intent_hash does not match the SHA-256 of the Intent Mandate (tampered or wrong Intent)");
  }
  // 2. Cart ↔ Payment
  if (payment.cart_jti !== cart.jti) {
    errors.push(`payment.cart_jti (${payment.cart_jti}) does not reference cart.jti (${cart.jti})`);
  }
  if (payment.cart_hash !== hashMandate(cart)) {
    errors.push("payment.cart_hash does not match the SHA-256 of the Cart Mandate (tampered or wrong Cart)");
  }

  const ceiling = intent.shopping_intent.price_max;
  // 3. currency consistency
  if (!sameCurrency(cart.cart_total, ceiling) || !sameCurrency(payment.amount, ceiling)) {
    errors.push("currency mismatch across Intent ceiling / cart total / payment amount");
  } else {
    // 4. cart_total == Σ line_total
    let sumOk = true;
    let acc: Money | null = null;
    for (const item of cart.items) {
      if (!sameCurrency(item.line_total, cart.cart_total)) {
        sumOk = false;
        break;
      }
      acc = acc === null ? item.line_total : addMoney(acc, item.line_total);
    }
    if (!sumOk || acc === null || !moneyEquals(acc, cart.cart_total)) {
      errors.push("cart_total does not equal the sum of item line_totals");
    }
    // 5. payment == cart_total ≤ ceiling
    if (!moneyEquals(payment.amount, cart.cart_total)) {
      errors.push("payment.amount does not equal cart_total");
    }
    if (!moneyGreaterThanOrEqual(ceiling, payment.amount)) {
      errors.push("payment.amount exceeds the Intent price_max ceiling");
    }
  }

  // 6. expiry
  if (intent.exp <= now) errors.push("Intent Mandate is expired");
  if (cart.exp <= now) errors.push("Cart Mandate is expired");
  if (payment.exp <= now) errors.push("Payment Mandate is expired");

  return { ok: errors.length === 0, errors };
}

/** Add two same-currency Money values without float drift (string-decimal BigInt). */
function addMoney(a: Money, b: Money): Money {
  if (!sameCurrency(a, b)) throw new Error("addMoney: currency mismatch");
  const scale = Math.max(decimals(a.amount), decimals(b.amount));
  const sum = toScaledBigInt(a.amount, scale) + toScaledBigInt(b.amount, scale);
  return { amount: fromScaledBigInt(sum, scale), currency: a.currency };
}
function decimals(s: string): number {
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}
function toScaledBigInt(s: string, scale: number): bigint {
  const [int, frac = ""] = s.split(".");
  return BigInt((int ?? "0") + frac.padEnd(scale, "0").slice(0, scale));
}
function fromScaledBigInt(v: bigint, scale: number): string {
  if (scale === 0) return v.toString();
  const s = v.toString().padStart(scale + 1, "0");
  return `${s.slice(0, -scale)}.${s.slice(-scale)}`;
}
