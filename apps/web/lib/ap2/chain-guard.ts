/**
 * AP2 chain guard — route-level enforcement seam (GT6).
 *
 * `chain.ts` makes the Intent→Cart→Payment binding + verification real and
 * unit-tested as a pure data-model layer. This module is the thin adapter that
 * lets a request handler (the `sign-mandate` route) actually *run* that verifier
 * against whatever the agent attached to an approval, WITHOUT coupling the route
 * to a shape it doesn't own.
 *
 * D27 keeps the client composing the Intent only; the Cart + Payment mandates are
 * agent-composed server-side and (when present) ride on the approval's
 * `recommendation` as an optional `ap2Chain` object. The contract types
 * (`packages/contracts/policy.ts`) leave `recommendation: z.unknown()`, so we
 * parse defensively here:
 *
 *   - no `ap2Chain` present            → `{ checked: false }` (Intent-only flow; skip)
 *   - `ap2Chain` present but malformed → `{ checked: true, ok: false, errors }` (reject)
 *   - `ap2Chain` present + well-formed → run `verifyMandateChain` (binding/ceiling/expiry)
 *
 * The route rejects with HTTP 422 when `checked && !ok`, so a human can never
 * resolve a gate over a tampered or over-ceiling chain. The VC signature (KMS /
 * WebAuthn SD-JWT) stays the operator-gated path — this is the binding check,
 * which composes with it (see `chain.ts` header + HONEST-SCOPE §4 AP2).
 */
import { z } from "zod";
import { IntentMandateSchema } from "./mandate";
import {
  CartMandateSchema,
  PaymentMandateSchema,
  verifyMandateChain,
  type ChainVerifyResult,
} from "./chain";

/** The full signed chain an agent may attach to an approval recommendation. */
export const Ap2ChainSchema = z.object({
  intent: IntentMandateSchema,
  cart: CartMandateSchema,
  payment: PaymentMandateSchema,
});
export type Ap2Chain = z.infer<typeof Ap2ChainSchema>;

/** Recommendation envelope that *may* carry an AP2 chain (everything else ignored). */
const RecommendationEnvelopeSchema = z
  .object({ ap2Chain: z.unknown().optional() })
  .passthrough();

export type ChainGuardResult =
  | { checked: false }
  | { checked: true; ok: boolean; errors: string[] };

/**
 * Run the AP2 chain verifier against an approval's `recommendation` if (and only
 * if) it carries an `ap2Chain`. Pure + deterministic given `opts.now`.
 */
export function verifyRecommendationChain(
  recommendation: unknown,
  opts?: { now?: number },
): ChainGuardResult {
  const env = RecommendationEnvelopeSchema.safeParse(recommendation);
  if (!env.success || env.data.ap2Chain === undefined || env.data.ap2Chain === null) {
    return { checked: false };
  }

  const parsed = Ap2ChainSchema.safeParse(env.data.ap2Chain);
  if (!parsed.success) {
    // A present-but-malformed chain is a hard reject, not a skip — an agent that
    // attached a chain at all must attach a well-formed one.
    return {
      checked: true,
      ok: false,
      errors: ["ap2Chain is present but malformed", ...flattenZodErrors(parsed.error)],
    };
  }

  const { intent, cart, payment } = parsed.data;
  const res: ChainVerifyResult = verifyMandateChain(intent, cart, payment, opts);
  return { checked: true, ok: res.ok, errors: res.errors };
}

function flattenZodErrors(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
}
