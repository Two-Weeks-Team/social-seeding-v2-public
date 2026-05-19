/**
 * AP2 v0.2.0 Mandate Zod schemas — verbatim from
 * `/Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/protocols/PROTOCOLS.md §2`.
 *
 * Implements:
 *   D27 — Intent Mandate is the only Mandate the agent composes day-1 (Cart /
 *         Payment Mandates flow through, but every signature in v2 day-1 is
 *         performed by a human via WebAuthn, never by an agent autonomously).
 *   D33 — Mandate lifecycle (TTL, retention 30/90/14 day rules apply to the
 *         operator_note text only — the signed Mandate JWS is financial
 *         evidence and retained 5y per PIPA Article 25, see O5.4 in AP2-UX.md).
 *   D34 — currency / locale formatting helpers live alongside.
 *
 * The cryptographic chain (Intent → Cart → Payment, each binding to its
 * predecessor via SHA-256) is enforced server-side by the AP2 verifier
 * service (`/api/approvals/[id]/sign-mandate`); the client only ever
 * constructs an Intent (and possibly a "bundle" referencing multiple Intents
 * for §3.4 bulk approve in AP2-UX.md).
 *
 * Anti-replay primitives required on every Mandate (AP2-UX.md §1):
 *   - jti — unique credential id; verifier rejects duplicate jti within TTL.
 *   - exp — strict expiry.
 *   - iat — issued-at; verifier rejects future iat or stale iat.
 *   - +kb JWT (Key Binding) — holder must prove fresh possession.
 *
 * Edge case EC-2.29 (replay protection): client uses UUIDv7 nonce + exp check.
 */
import { z } from "zod";

/** ISO 4217 currency code subset — D34 i18n locales × v2 day-1 partners. */
export const CurrencySchema = z.enum(["KRW", "USD", "JPY", "CNY", "EUR", "GBP"]);
export type Currency = z.infer<typeof CurrencySchema>;

/** Amount of money — string-encoded to preserve precision; no IEEE-754 issues. */
export const MoneySchema = z.object({
  /** Decimal amount as string, e.g. "147.34" or "2340000". */
  amount: z.string().regex(/^\d+(\.\d+)?$/, "amount must be a non-negative decimal string"),
  currency: CurrencySchema,
});
export type Money = z.infer<typeof MoneySchema>;

/** EC ES256 public key (JWK form) — what the user's WebAuthn passkey produces. */
export const EcPublicJwkSchema = z.object({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().min(1),
  y: z.string().min(1),
});
export type EcPublicJwk = z.infer<typeof EcPublicJwkSchema>;

/** Key Binding `cnf` claim — proves the holder controls this key. */
export const ConfirmationSchema = z.object({
  jwk: EcPublicJwkSchema,
});
export type Confirmation = z.infer<typeof ConfirmationSchema>;

/**
 * Shopping intent — the scope of authority the user delegates to the agent.
 * Per AP2-UX.md §3.2, the drill-in surfaces these as semantic fields, never
 * as raw JSON (anti-pattern §9.4).
 */
export const ShoppingIntentSchema = z.object({
  /** category — drives the rationale + the inbox row description. */
  category: z.enum([
    "creator_payout",
    "sample_carrier",
    "ads_topup",
    "platform_subscription",
    "tax_remittance",
    "refund_disbursement",
    "other",
  ]),
  /** Free-form attributes — locale-agnostic; per AP2-UX.md §7.1 NOT translated. */
  attributes: z.record(z.string(), z.string()).optional(),
  /** Hard scope ceiling — operator-edit may NOT exceed this. */
  price_max: MoneySchema,
  /**
   * Per-recipient amount upper-bound multiplier — for §3.3 edit-then-sign guard.
   * Operator's edit may not exceed agent_proposed × 1.2 without an additional
   * confirmation prompt (AP2-UX.md §3.3).
   */
  per_recipient_uplift_max: z.number().min(1).max(2).default(1.2),
  /** did:web:* identifiers — the only payees the agent may transact with. */
  merchant_allowlist: z.array(z.string().regex(/^did:web:.+$/)).min(1),
  /** Per PIPA + Marketplace risk (D22) — every Intent must be refundable. */
  refundable_required: z.boolean(),
});
export type ShoppingIntent = z.infer<typeof ShoppingIntentSchema>;

/** Per-recipient row inside the Intent — drives the AP2-UX.md §3.2 table. */
export const MandateRecipientSchema = z.object({
  creatorId: z.string().min(1),
  /** TikTok @-handle for human display only — never the source of truth. */
  uniqueId: z.string().min(1),
  /** Agent's proposed amount — the value the operator sees in the drill-in. */
  proposedAmount: MoneySchema,
  /** Floor amount — operator's edit may not go below this without a warning. */
  floorAmount: MoneySchema.optional(),
  /** 4-glyph judge summary — brand · conversion · deliverability · skeptic. */
  judgeSummary: z.tuple([
    z.enum(["pass", "neutral", "fail"]),
    z.enum(["pass", "neutral", "fail"]),
    z.enum(["pass", "neutral", "fail"]),
    z.enum(["pass", "neutral", "fail"]),
  ]),
  /** Contract artifact id, surfaced as a link in the recipient table. */
  contractId: z.string().min(1).optional(),
  /** PIPA Article 23 consent verifier — true means we have consent on file. */
  pipaConsentVerified: z.boolean(),
});
export type MandateRecipient = z.infer<typeof MandateRecipientSchema>;

/** Delegation mode — D27 forces `human_present` for v2 day-1. */
export const DelegationModeSchema = z.enum(["human_present", "human_not_present"]);
export type DelegationMode = z.infer<typeof DelegationModeSchema>;

/** Boolean risk chips surfaced in AP2-UX.md §3.2 + §3.4. */
export const JudgmentChipSchema = z.enum([
  "within-budget",
  "PIPA-cleared",
  "merchant-allowlist",
  "refundable",
  "Model-Armor-passed",
  "first-time",
  "first-time-partner",
  "post-30-day-TTL",
  "high-value",
]);
export type JudgmentChip = z.infer<typeof JudgmentChipSchema>;

export const ChipStateSchema = z.object({
  chip: JudgmentChipSchema,
  passed: z.boolean(),
  /** Why this chip flipped — surfaced in the drill-in tooltip + SR aria-label. */
  detail: z.string().optional(),
});
export type ChipState = z.infer<typeof ChipStateSchema>;

/**
 * Payment partner — the PSP / processor that will actually settle.
 * AP2-UX.md §3.1: partner badge is mandatory on inbox row, drill-in, bulk
 * modal, and readback. The `apNative` field tells the operator whether the
 * transaction routes through AP2 rails (true → all signals reach issuer) or
 * via merchant-side orchestration (false → some signals are lost).
 */
export const PaymentPartnerIdSchema = z.string().min(1);
export type PaymentPartnerId = z.infer<typeof PaymentPartnerIdSchema>;

/**
 * AP2 Intent Mandate — the only Mandate composed client-side in v2 day-1.
 * Matches PROTOCOLS.md §2.2.1 schema verbatim. The `+kb` JWT (Key Binding)
 * lives outside this object and is appended by the WebAuthn assertion in
 * `webauthn.ts`.
 */
export const IntentMandateSchema = z.object({
  credential_type: z.literal("ap2.IntentMandate"),
  version: z.literal("0.2.0"),
  /** Issuer = the user; did:web:user.<workspace>.socialseed.ing */
  iss: z.string().min(1),
  /** Subject = the agent holding the credential. */
  sub: z.string().regex(/^did:web:.+$/),
  /** Issued at (UNIX seconds). */
  iat: z.number().int().nonnegative(),
  /**
   * Expires at (UNIX seconds). Per AP2-UX.md §3.3 the operator can REDUCE
   * this (shrink replay window) but never extend.
   */
  exp: z.number().int().nonnegative(),
  /** Unique credential id — replay protection. UUIDv7 recommended (EC-2.29). */
  jti: z.string().min(1),
  shopping_intent: ShoppingIntentSchema,
  /** Verbatim playback of the operator note, surfaced in the drill-in. */
  prompt_playback: z.string(),
  /** D27 forces this to "human_present" for v2 day-1. */
  delegation_mode: DelegationModeSchema,
  /** Key Binding — agent's public key (or operator key for human-present). */
  cnf: ConfirmationSchema,
  /** Risk signals (device id, geo, etc.) — server-side enriched. */
  risk_payload: z
    .object({
      device_id: z.string().optional(),
      location: z.string().optional(),
      ip_hash: z.string().optional(),
    })
    .partial()
    .optional(),
  /** Back-reference to a prior Intent (e.g. expired draft that was re-composed). */
  prior_intent_jti: z.string().optional(),
  /** Operator's free-text note (≤500 chars per AP2-UX.md §3.3). */
  operator_note: z.string().max(500).optional(),
});
export type IntentMandate = z.infer<typeof IntentMandateSchema>;

/**
 * The payload `payment_mandate` agent writes to the approval row. This is the
 * "draft" that the operator sees pre-signing. After WebAuthn sign-off it
 * becomes an IntentMandate JWS stored in the AP2 store (Spanner).
 */
export const PaymentMandateDraftSchema = z.object({
  /** UUIDv7 — server enforces uniqueness within rolling 48 h window (R1). */
  jti: z.string().min(1),
  /** UNIX seconds — strict expiry. UI greys out submit when within 60 s. */
  exp: z.number().int().nonnegative(),
  /** AP2-UX.md §3.2 — semantic summary of the Intent (NOT the raw JWS). */
  intent: ShoppingIntentSchema,
  delegation_mode: DelegationModeSchema,
  /** Per-recipient table — rendered in §3.2. */
  recipients: z.array(MandateRecipientSchema).min(1),
  /** Pre-computed by the `payment_mandate` agent at compose time. */
  initialChips: z.array(ChipStateSchema),
  /** Server re-evaluates chips at render time per R10 (anti-stale-chip). */
  serverChips: z.array(ChipStateSchema).optional(),
  /** Payment partner id (see partner-registry.ts). */
  partner: PaymentPartnerIdSchema,
  /** Raw SD-JWT payload, surfaced ONLY in the collapsed disclosure (§3.2 #7). */
  rawJws: z.string().optional(),
  /** Computed: total of all recipient.proposedAmount values. */
  totalAmount: MoneySchema,
  /** When the agent composed this draft (UNIX seconds). */
  composedAt: z.number().int().nonnegative(),
});
export type PaymentMandateDraft = z.infer<typeof PaymentMandateDraftSchema>;

/**
 * Operator-edited variant — per AP2-UX.md §3.3, the edit-then-sign path
 * creates a NEW Intent with a back-ref to the original. We capture the diff
 * so the audit log records both.
 */
export const RecipientEditSchema = z.object({
  creatorId: z.string().min(1),
  /** Final amount after edit. null = the row is being dropped from the bundle. */
  amount: MoneySchema.nullable(),
  acknowledgedFloor: z.boolean().default(false),
});
export type RecipientEdit = z.infer<typeof RecipientEditSchema>;

export const MandateEditSchema = z.object({
  /** Per-recipient overrides — only changed rows appear here. */
  recipientEdits: z.array(RecipientEditSchema).default([]),
  /** Reduced TTL (UNIX seconds). Must be ≤ original exp. */
  reducedExp: z.number().int().nonnegative().optional(),
  /** Free-text operator note (≤500 chars). */
  operatorNote: z.string().max(500).optional(),
  /** True if the operator acknowledged the >1.2× confirmation prompt. */
  uplift_acknowledged: z.boolean().default(false),
});
export type MandateEdit = z.infer<typeof MandateEditSchema>;

/** Sign request — sent to /api/approvals/[id]/sign-mandate. */
export const SignMandateRequestSchema = z.object({
  /** The approval row id (drives idempotency at the workflow gate). */
  approvalId: z.string().min(1),
  /** UUIDv7 nonce — replay protection (EC-2.29). Must match WebAuthn challenge. */
  nonce: z.string().min(1),
  /** Edits, if any. Empty object = 1-click sign. */
  edits: MandateEditSchema.optional(),
  /** WebAuthn assertion — base64url-encoded. */
  webAuthnAssertion: z.object({
    id: z.string().min(1),
    rawId: z.string().min(1),
    response: z.object({
      clientDataJSON: z.string().min(1),
      authenticatorData: z.string().min(1),
      signature: z.string().min(1),
      userHandle: z.string().optional(),
    }),
    type: z.literal("public-key"),
  }),
});
export type SignMandateRequest = z.infer<typeof SignMandateRequestSchema>;

/** Reject request — paired structured-reason picklist per §9.8. */
export const RejectReasonSchema = z.enum([
  "amount_too_high",
  "wrong_recipient",
  "partner_concern",
  "policy_violation",
  "other",
]);
export type RejectReason = z.infer<typeof RejectReasonSchema>;

export const RejectMandateRequestSchema = z.object({
  approvalId: z.string().min(1),
  reason: RejectReasonSchema,
  /** Free-text note ≤500 chars — appended for the `customer_success` agent. */
  note: z.string().max(500).optional(),
});
export type RejectMandateRequest = z.infer<typeof RejectMandateRequestSchema>;

/** Bulk-approve bundle — N Intents signed by a single WebAuthn assertion. */
export const BulkSignRequestSchema = z.object({
  /** Bundle nonce — UUIDv7, replay-protected (R4 — bundle is atomic). */
  bundleNonce: z.string().min(1),
  /** Approval row ids being signed in this bundle (max 10 per AP2-UX.md §3.4). */
  approvalIds: z.array(z.string().min(1)).min(2).max(10),
  /** Per-approval edits keyed by approval id. */
  editsByApprovalId: z.record(z.string(), MandateEditSchema).default({}),
  webAuthnAssertion: SignMandateRequestSchema.shape.webAuthnAssertion,
});
export type BulkSignRequest = z.infer<typeof BulkSignRequestSchema>;

/**
 * Type guard — the existing v2 `approval.recommendation` is `unknown`. The
 * Phase-6 agent (this task) extends the discriminator. The contract package
 * (`@ss/contracts`) will be amended in a follow-up to add `"payment_mandate"`
 * to the kind enum; until then we narrow at the UI boundary.
 */
export function isPaymentMandateDraft(value: unknown): value is PaymentMandateDraft {
  return PaymentMandateDraftSchema.safeParse(value).success;
}

/**
 * Compute the sum of all selected recipients' amounts as a Money.
 * Pure function — no I/O. Uses BigInt internally to avoid IEEE-754 drift on
 * large KRW figures (e.g. ₩2,340,000 ≪ Number.MAX_SAFE_INTEGER, but stable
 * across arbitrary precision).
 */
export function sumMoney(items: Money[]): Money {
  if (items.length === 0) {
    throw new Error("sumMoney requires at least one item");
  }
  const first = items[0];
  if (!first) throw new Error("sumMoney: unreachable");
  const currency = first.currency;
  // Convert all amounts to fixed-point minor units (×100 then BigInt) for sum.
  let totalMinor = 0n;
  for (const item of items) {
    if (item.currency !== currency) {
      throw new Error(`sumMoney: mixed currencies (${currency} vs ${item.currency})`);
    }
    const [intPart, fracPart = ""] = item.amount.split(".");
    const padded = (fracPart + "00").slice(0, 2);
    totalMinor += BigInt((intPart ?? "0") + padded);
  }
  // For zero-decimal currencies (KRW/JPY per D34) the input amount "504000"
  // has already been ×100-padded into minor units above; we must divide back
  // out so the result represents whole units. Otherwise three KRW recipients
  // at ₩504,000 + ₩320,000 + ₩480,000 would report ₩130,400,000 instead of
  // the correct ₩1,304,000.
  // Codex PR-fix: https://github.com/Two-Weeks-Team/social-seeding-v2/pull/1#discussion_r3266224734
  if (isZeroDecimalCurrency(currency)) {
    return { amount: (totalMinor / 100n).toString(), currency };
  }
  // Two-decimal currencies — re-attach the decimal point at the -2 position.
  const totalStr = totalMinor.toString();
  const minorDigits = 2;
  const padded = totalStr.padStart(minorDigits + 1, "0");
  const head = padded.slice(0, -minorDigits) || "0";
  const tail = padded.slice(-minorDigits);
  return { amount: `${head}.${tail}`, currency };
}

/** KRW + JPY are zero-decimal currencies per ISO 4217. */
export function isZeroDecimalCurrency(currency: Currency): boolean {
  return currency === "KRW" || currency === "JPY";
}

/**
 * Locale-aware currency formatting. D34 — 4 locales. Returns the formatted
 * string used in both visible text and aria-labels.
 *
 * AP2-UX.md §7.1 specifies the exact example outputs:
 *   ko-KR + KRW → ₩2,340,000
 *   en-US + USD → $147.34
 *   ja-JP + JPY → ¥16,200
 *   zh-CN + CNY → ¥1,070
 */
export function formatMoney(money: Money, locale: AP2Locale): string {
  const num = Number(money.amount);
  return new Intl.NumberFormat(localeTagFor(locale), {
    style: "currency",
    currency: money.currency,
    // KRW/JPY: 0 fraction digits; others: 2.
    minimumFractionDigits: isZeroDecimalCurrency(money.currency) ? 0 : 2,
    maximumFractionDigits: isZeroDecimalCurrency(money.currency) ? 0 : 2,
  }).format(num);
}

/** Verbose aria-label form — "two million three hundred forty thousand Korean won". */
export function formatMoneyAriaLabel(money: Money, locale: AP2Locale): string {
  const num = Number(money.amount);
  const currencyName = currencyDisplayName(money.currency, locale);
  return `${new Intl.NumberFormat(localeTagFor(locale), {
    style: "decimal",
    minimumFractionDigits: isZeroDecimalCurrency(money.currency) ? 0 : 2,
    maximumFractionDigits: isZeroDecimalCurrency(money.currency) ? 0 : 2,
  }).format(num)} ${currencyName}`;
}

function currencyDisplayName(currency: Currency, locale: AP2Locale): string {
  try {
    const dn = new Intl.DisplayNames([localeTagFor(locale)], { type: "currency" });
    return dn.of(currency) ?? currency;
  } catch {
    return currency;
  }
}

/** D34 — 4-locale enum. Stored in `user_prefs.preferredLocale`. */
export const AP2LocaleSchema = z.enum(["ko", "en", "ja", "zh"]);
export type AP2Locale = z.infer<typeof AP2LocaleSchema>;

/** Map our short locale code to BCP-47 for Intl APIs. */
export function localeTagFor(locale: AP2Locale): string {
  return locale === "ko"
    ? "ko-KR"
    : locale === "en"
      ? "en-US"
      : locale === "ja"
        ? "ja-JP"
        : "zh-CN";
}

/**
 * Default high-value threshold per locale (D27 ties this to operator-set
 * workspace policy; these constants are the day-1 fallbacks per AP2-UX.md §3.6).
 *
 *   ko-KR / KRW   →  ₩10,000,000 (10M won)
 *   en-US / USD   →  $10,000
 *   ja-JP / JPY   →  ¥10,000 (per task brief — note: AP2-UX.md leaves this open;
 *                              we use ¥10K matching JPY zero-decimal scale)
 *   zh-CN / CNY   →  ¥800 (per task brief; below the threshold is "OK
 *                          biometric only", above forces roaming + 2FA)
 */
export const DEFAULT_HIGH_VALUE_THRESHOLD: Record<AP2Locale, Money> = {
  ko: { amount: "10000000", currency: "KRW" },
  en: { amount: "10000.00", currency: "USD" },
  ja: { amount: "10000", currency: "JPY" },
  zh: { amount: "800.00", currency: "CNY" },
};

/**
 * "Step-up amount" — the threshold above which WebAuthn must use a roaming
 * authenticator (YubiKey / Titan) instead of platform. Per AP2-UX.md §3.6
 * this is identical to high-value by default but kept separate so a workspace
 * may relax the *force-roaming* trigger while keeping the *force-2FA* trigger.
 */
export const DEFAULT_ROAMING_THRESHOLD = DEFAULT_HIGH_VALUE_THRESHOLD;

/**
 * Compare two Money values within the SAME currency. Returns true if `a > b`.
 * Throws on currency mismatch (AP2-UX.md §3.4 forbids cross-currency aggregation).
 */
export function moneyGreaterThan(a: Money, b: Money): boolean {
  if (a.currency !== b.currency) {
    throw new Error(`cannot compare ${a.currency} > ${b.currency}`);
  }
  return Number(a.amount) > Number(b.amount);
}

export function moneyGreaterThanOrEqual(a: Money, b: Money): boolean {
  if (a.currency !== b.currency) {
    throw new Error(`cannot compare ${a.currency} >= ${b.currency}`);
  }
  return Number(a.amount) >= Number(b.amount);
}

/**
 * UUIDv7 generation — time-ordered 128-bit identifier per IETF draft.
 * Used for `jti` (per-Mandate replay protection) AND the WebAuthn challenge
 * nonce (EC-2.29).
 *
 * Implementation reference: draft-ietf-uuidrev-rfc4122bis §5.7.
 * Format:
 *   Bits 0-47   — unix_ts_ms (big-endian)
 *   Bits 48-51  — version (0b0111 = 7)
 *   Bits 52-63  — random_a
 *   Bits 64-65  — variant (0b10)
 *   Bits 66-127 — random_b
 */
export function uuidv7(now: number = Date.now()): string {
  const buf = new Uint8Array(16);
  // 48-bit timestamp (big-endian).
  const ts = BigInt(now);
  buf[0] = Number((ts >> 40n) & 0xffn);
  buf[1] = Number((ts >> 32n) & 0xffn);
  buf[2] = Number((ts >> 24n) & 0xffn);
  buf[3] = Number((ts >> 16n) & 0xffn);
  buf[4] = Number((ts >> 8n) & 0xffn);
  buf[5] = Number(ts & 0xffn);

  // Random 10 bytes — use crypto when available; fall back to Math.random for
  // ssr-safe environments that don't have webcrypto (this is unreachable in
  // Next 16's Edge / Node runtimes, but keeps the type signature pure).
  const rand = new Uint8Array(10);
  const c =
    typeof globalThis !== "undefined" && typeof globalThis.crypto !== "undefined"
      ? globalThis.crypto
      : undefined;
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(rand);
  } else {
    for (let i = 0; i < rand.length; i++) {
      rand[i] = Math.floor(Math.random() * 256);
    }
  }
  // Version 7 in bits 48-51 of byte 6.
  buf[6] = (rand[0]! & 0x0f) | 0x70;
  buf[7] = rand[1]!;
  // Variant (RFC 4122) in bits 64-65 of byte 8 = 0b10xxxxxx.
  buf[8] = (rand[2]! & 0x3f) | 0x80;
  buf[9] = rand[3]!;
  buf[10] = rand[4]!;
  buf[11] = rand[5]!;
  buf[12] = rand[6]!;
  buf[13] = rand[7]!;
  buf[14] = rand[8]!;
  buf[15] = rand[9]!;

  const hex = Array.from(buf).map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

/**
 * Extract the embedded UNIX-ms timestamp from a UUIDv7. Used in the
 * "wait time" column on the inbox (AP2-UX.md §3.1 column 5).
 * Returns null if the input is not a UUIDv7.
 */
export function uuidv7Timestamp(uuid: string): number | null {
  const clean = uuid.replace(/-/g, "");
  if (clean.length !== 32) return null;
  // Version nibble lives at hex offset 12 (= byte 6 high nibble).
  if (clean[12] !== "7") return null;
  const hex = clean.slice(0, 12);
  return parseInt(hex, 16);
}

/**
 * Check whether an Intent's `exp` has passed OR is within a "lock" margin
 * (default 60 s). Per AP2-UX.md §3.2 header: turns rose at < 1 h, blocks
 * submit when within 60 s.
 */
export function expiryGuard(
  exp: number,
  now: number = Math.floor(Date.now() / 1000),
): { expired: boolean; secondsRemaining: number; warn: boolean; block: boolean } {
  const secondsRemaining = exp - now;
  const expired = secondsRemaining <= 0;
  const block = secondsRemaining <= 60;
  const warn = secondsRemaining <= 3600;
  return { expired, secondsRemaining, warn, block };
}

/**
 * AP2 state machine (AP2-UX.md §8). The drill-in only renders if the row is
 * `PENDING`; other states surface in the timeline / campaign view.
 */
export const AP2StateSchema = z.enum([
  "AGENT_DRAFT",
  "PENDING",
  "EDITING",
  "SIGNED",
  "AWAITING_PAYMENT_HUMAN",
  "PAID",
  "SETTLED",
  "REJECTED",
  "EXPIRED",
  "REFUNDED",
]);
export type AP2State = z.infer<typeof AP2StateSchema>;

/** Tone mapping for the state pill — drives the colour token. */
export const AP2_STATE_TONE: Record<AP2State, "slate" | "blue" | "emerald" | "amber" | "rose"> = {
  AGENT_DRAFT: "slate",
  PENDING: "amber",
  EDITING: "blue",
  SIGNED: "blue",
  AWAITING_PAYMENT_HUMAN: "amber",
  PAID: "emerald",
  SETTLED: "emerald",
  REJECTED: "rose",
  EXPIRED: "slate",
  REFUNDED: "rose",
};
