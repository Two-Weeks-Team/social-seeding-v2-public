/**
 * AP2 v0.2.0 payment partner registry — a curated subset (58 entries) of
 * AP2's 60+ announced ecosystem, per `PROTOCOLS.md §2.6`. Each entry tells
 * the UI:
 *   - displayName  — what the operator sees in the row / drill-in / readback.
 *   - icon         — short glyph rendered next to the name (no third-party
 *                    asset deps — keeps the bundle tiny per Frontend-Architect
 *                    "Optimize Performance" focus).
 *   - apNative     — true if AP2 rails carry `agentic_signals` end-to-end;
 *                    false means transactions route via merchant-side
 *                    orchestration (e.g. Adyen → Stripe-acquired merchant).
 *                    Per AP2-UX.md §3.1 the `⚠` decoration appears in the
 *                    inbox for `apNative === false` partners.
 *   - category     — `card_network`, `processor`, `wallet`, `crypto`,
 *                    `commerce_platform`, `saas`, `identity`, `infra`,
 *                    `consulting`, `other`.
 *   - tone         — Badge variant; partner badges use a non-default color
 *                    when the partner is on the "AP2 launch" list and slate
 *                    otherwise (a quiet visual cue without a second `⚠`).
 *
 * D-IDs touched:
 *   D27 — partner info is displayed prominently because the operator's risk
 *         model differs by partner; hiding it is anti-pattern §9.5.
 *   D34 — `displayName` is the partner's brand name in Latin script. The
 *         locale-specific copy (e.g. "Adyen payment gateway") lives in
 *         next-intl messages keyed by `approvals.ap2.partner.{id}.name` when
 *         a translation is needed; otherwise we use displayName verbatim.
 *
 * The list is intentionally broad (58 entries at v0.2.0) because the
 * inbox row Badge needs to find any partner the agent picks. New partners
 * post-launch are added here; the verifier's allowlist is server-side.
 */

export type PartnerCategory =
  | "card_network"
  | "processor"
  | "wallet"
  | "crypto"
  | "commerce_platform"
  | "saas"
  | "identity"
  | "infra"
  | "consulting"
  | "other";

export interface PaymentPartner {
  id: string;
  displayName: string;
  /** 1-2 char glyph rendered in the inbox / drill-in / bottom-sheet. */
  icon: string;
  /** True = native AP2 rails; false = via merchant orchestration. */
  apNative: boolean;
  category: PartnerCategory;
  /** Badge variant; falls back to "slate" if absent. */
  tone?: "slate" | "blue" | "emerald" | "amber" | "rose" | "cyan" | "violet";
}

/**
 * Source: https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol
 * + Klarna post-launch addition per PROTOCOLS.md §2.6.
 *
 * Visa / Stripe are intentionally NOT marked `apNative: true` — they back
 * competing protocols (Visa TAP, Stripe ACP) and AP2 reaches them only via
 * merchant-side orchestration (e.g. Adyen routing to a Stripe-acquired
 * merchant). We still list them so the UI doesn't render "unknown partner".
 */
export const PAYMENT_PARTNERS: ReadonlyArray<PaymentPartner> = [
  // ── Card networks & issuers ─────────────────────────────────────────────
  { id: "americanexpress", displayName: "American Express", icon: "💳", apNative: true, category: "card_network", tone: "blue" },
  { id: "mastercard", displayName: "Mastercard", icon: "💳", apNative: true, category: "card_network", tone: "rose" },
  { id: "jcb", displayName: "JCB", icon: "💳", apNative: true, category: "card_network", tone: "blue" },
  { id: "unionpay", displayName: "UnionPay International", icon: "💳", apNative: true, category: "card_network", tone: "rose" },
  { id: "discover", displayName: "Discover", icon: "💳", apNative: true, category: "card_network", tone: "amber" },
  { id: "visa", displayName: "Visa", icon: "💳", apNative: false, category: "card_network", tone: "slate" },

  // ── Processors / acquirers / orchestration ──────────────────────────────
  { id: "adyen", displayName: "Adyen", icon: "🏦", apNative: true, category: "processor", tone: "emerald" },
  { id: "paypal", displayName: "PayPal", icon: "🅿️", apNative: true, category: "processor", tone: "blue" },
  { id: "worldpay", displayName: "Worldpay", icon: "🌐", apNative: true, category: "processor", tone: "blue" },
  { id: "checkout", displayName: "Checkout.com", icon: "✔️", apNative: true, category: "processor", tone: "emerald" },
  { id: "dlocal", displayName: "DLocal", icon: "🌎", apNative: true, category: "processor", tone: "cyan" },
  { id: "juspay", displayName: "JusPay", icon: "💼", apNative: true, category: "processor", tone: "violet" },
  { id: "nexi", displayName: "Nexi", icon: "🅴", apNative: true, category: "processor", tone: "blue" },
  { id: "airwallex", displayName: "Airwallex", icon: "✈️", apNative: true, category: "processor", tone: "cyan" },
  { id: "antintl", displayName: "Ant International", icon: "🐜", apNative: true, category: "processor", tone: "blue" },
  { id: "ebanx", displayName: "Ebanx", icon: "🇧🇷", apNative: true, category: "processor", tone: "emerald" },
  { id: "gr4vy", displayName: "Gr4vy", icon: "🪐", apNative: true, category: "processor", tone: "violet" },
  { id: "payoneer", displayName: "Payoneer", icon: "🌍", apNative: true, category: "processor", tone: "amber" },
  { id: "fiuu", displayName: "Fiuu", icon: "🇲🇾", apNative: true, category: "processor", tone: "blue" },
  { id: "kcp", displayName: "KCP", icon: "🇰🇷", apNative: true, category: "processor", tone: "rose" },
  { id: "bhn", displayName: "BHN", icon: "🎁", apNative: true, category: "processor", tone: "slate" },
  { id: "worldline", displayName: "Worldline", icon: "🌐", apNative: true, category: "processor", tone: "blue" },
  { id: "stripe", displayName: "Stripe", icon: "Ⓢ", apNative: false, category: "processor", tone: "slate" },

  // ── Wallets / BNPL ──────────────────────────────────────────────────────
  { id: "klarna", displayName: "Klarna", icon: "K", apNative: true, category: "wallet", tone: "rose" },
  { id: "googlewallet", displayName: "Google Wallet", icon: "G", apNative: true, category: "wallet", tone: "blue" },

  // ── KR-region (per CLAUDE.md project map; not AP2 launch partners but the
  //              v2 product targets KR creators day-1) ───────────────────────
  { id: "toss", displayName: "Toss", icon: "₩", apNative: false, category: "wallet", tone: "slate" },
  { id: "kakaopay", displayName: "KakaoPay", icon: "K", apNative: false, category: "wallet", tone: "amber" },
  { id: "naverpay", displayName: "Naver Pay", icon: "N", apNative: false, category: "wallet", tone: "emerald" },
  { id: "nicepay", displayName: "NicePay", icon: "₩", apNative: false, category: "processor", tone: "slate" },
  { id: "inicis", displayName: "KG Inicis", icon: "₩", apNative: false, category: "processor", tone: "slate" },

  // ── Crypto / Web3 ───────────────────────────────────────────────────────
  { id: "coinbase", displayName: "Coinbase", icon: "₿", apNative: true, category: "crypto", tone: "blue" },
  { id: "mysten", displayName: "Mysten Labs", icon: "⛓️", apNative: true, category: "crypto", tone: "cyan" },
  { id: "metamask", displayName: "MetaMask", icon: "🦊", apNative: true, category: "crypto", tone: "amber" },
  { id: "ethfoundation", displayName: "Ethereum Foundation", icon: "Ξ", apNative: true, category: "crypto", tone: "slate" },
  { id: "lightspark", displayName: "Lightspark", icon: "⚡", apNative: true, category: "crypto", tone: "amber" },
  { id: "crossmint", displayName: "Crossmint", icon: "✦", apNative: true, category: "crypto", tone: "violet" },
  { id: "bvnk", displayName: "BVNK", icon: "B", apNative: true, category: "crypto", tone: "blue" },
  { id: "mesh", displayName: "Mesh", icon: "M", apNative: true, category: "crypto", tone: "cyan" },

  // ── Commerce platforms ──────────────────────────────────────────────────
  { id: "shopify", displayName: "Shopify", icon: "🛍️", apNative: true, category: "commerce_platform", tone: "emerald" },
  { id: "etsy", displayName: "Etsy", icon: "E", apNative: true, category: "commerce_platform", tone: "amber" },
  { id: "shopee", displayName: "Shopee", icon: "S", apNative: true, category: "commerce_platform", tone: "rose" },
  { id: "gfg", displayName: "Global Fashion Group", icon: "👗", apNative: true, category: "commerce_platform", tone: "violet" },

  // ── SaaS / enterprise ───────────────────────────────────────────────────
  { id: "salesforce", displayName: "Salesforce", icon: "☁️", apNative: true, category: "saas", tone: "cyan" },
  { id: "servicenow", displayName: "ServiceNow", icon: "S", apNative: true, category: "saas", tone: "emerald" },
  { id: "intuit", displayName: "Intuit", icon: "🧾", apNative: true, category: "saas", tone: "blue" },
  { id: "adobe", displayName: "Adobe", icon: "A", apNative: true, category: "saas", tone: "rose" },

  // ── Identity & security ─────────────────────────────────────────────────
  { id: "okta", displayName: "Okta / Auth0", icon: "🔐", apNative: true, category: "identity", tone: "blue" },
  { id: "onepass", displayName: "1Password", icon: "🔑", apNative: true, category: "identity", tone: "blue" },
  { id: "forter", displayName: "Forter", icon: "F", apNative: true, category: "identity", tone: "violet" },

  // ── Infrastructure ──────────────────────────────────────────────────────
  { id: "confluent", displayName: "Confluent", icon: "C", apNative: true, category: "infra", tone: "violet" },
  { id: "gravitee", displayName: "Gravitee", icon: "G", apNative: true, category: "infra", tone: "rose" },
  { id: "eigenlabs", displayName: "Eigenlabs", icon: "Λ", apNative: true, category: "infra", tone: "slate" },
  { id: "cloudflare", displayName: "Cloudflare", icon: "🔥", apNative: true, category: "infra", tone: "amber" },

  // ── Consulting / SI ─────────────────────────────────────────────────────
  { id: "accenture", displayName: "Accenture", icon: "A", apNative: true, category: "consulting", tone: "violet" },
  { id: "deloitte", displayName: "Deloitte", icon: "D", apNative: true, category: "consulting", tone: "emerald" },
  { id: "dell", displayName: "Dell", icon: "D", apNative: true, category: "consulting", tone: "blue" },
  { id: "pwc", displayName: "PwC", icon: "P", apNative: true, category: "consulting", tone: "amber" },

  // ── Other ───────────────────────────────────────────────────────────────
  { id: "manusai", displayName: "ManusAI", icon: "M", apNative: true, category: "other", tone: "cyan" },
] as const;

/** Indexed lookup. */
const BY_ID = new Map(PAYMENT_PARTNERS.map((p) => [p.id, p] as const));

export function findPartner(id: string): PaymentPartner | undefined {
  return BY_ID.get(id.toLowerCase());
}

/**
 * Default fallback for partners we don't know about. Renders as a "?" badge
 * with `apNative: false` (conservative — operator sees the unknown warning).
 */
export function partnerOrUnknown(id: string): PaymentPartner {
  return (
    findPartner(id) ?? {
      id,
      displayName: id,
      icon: "?",
      apNative: false,
      category: "other",
    }
  );
}

/**
 * Count of partners by AP2-native status. Surfaced in §3.4 bulk-approve modal
 * as the "X partners are AP2-native, Y route via orchestration" summary.
 */
export function partnerBreakdown(
  partnerIds: string[],
): { apNative: number; orchestrated: number; counts: Map<string, number> } {
  let apNative = 0;
  let orchestrated = 0;
  const counts = new Map<string, number>();
  for (const id of partnerIds) {
    const p = partnerOrUnknown(id);
    counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
    if (p.apNative) apNative++;
    else orchestrated++;
  }
  return { apNative, orchestrated, counts };
}

/**
 * Length sanity-check — keeps the count in sync with PROTOCOLS.md §2.6.
 * Intentionally exposed so tests can assert the registry stays substantial.
 */
export const PARTNER_COUNT = PAYMENT_PARTNERS.length;
