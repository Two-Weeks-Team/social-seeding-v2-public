/**
 * Spam-score pre-check — port of v1 `~/social-seeding/src/lib/spam-score.ts`.
 *
 * Pure rule engine: subject + body + from → a 0–10 score, a `risk` bucket, the
 * list of triggered rules, and human-readable suggestions. No I/O.
 *
 * The score gates `gmail.send`: if it exceeds the workspace's allowed ceiling
 * (resolved via WorkspacePolicy / a sane default), the capability throws so
 * the orchestrator escalates the draft to a human via the `approveOutreachSend`
 * gate instead of silently shipping a deliverability-risky email.
 *
 * Rule IDs and weights track v1 verbatim so a/b comparisons between v1 and v2
 * deliverability data remain apples-to-apples. Localization: v1 looked up
 * per-locale name / description / suggestion from i18n catalogs. v2 keeps the
 * canonical English strings inline — UI translation is a Mission Control
 * concern, not this capability's. Rule IDs are stable; localize at render time.
 */

export type SpamRiskLevel = "low" | "medium" | "high" | "very-high";

export interface SpamRule {
  id: string;
  name: string;
  description: string;
  weight: number;
  suggestion: string;
  check: (subject: string, body: string, from: string) => boolean;
}

export interface SpamRuleHit {
  ruleId: string;
  weight: number;
  suggestion: string;
}

export interface SpamScoreResult {
  /** Normalized to [0,10]. */
  score: number;
  risk: SpamRiskLevel;
  /** Rules that fired, in the order they were evaluated. */
  triggered: SpamRuleHit[];
  /** Deduplicated improvement suggestions, useful for the approval UI. */
  suggestions: string[];
}

/** Default ceiling at which the orchestrator should escalate to a human. */
export const DEFAULT_MAX_SPAM_SCORE = 6;

/** Map a numeric score to v1's risk bucket. */
export function riskFor(score: number): SpamRiskLevel {
  if (score <= 2) return "low";
  if (score <= 5) return "medium";
  if (score <= 8) return "high";
  return "very-high";
}

const RULES: SpamRule[] = [
  {
    id: "excessiveCaps",
    name: "Excessive capitalization",
    description: "More than 30% of the alphabetic characters are uppercase.",
    weight: 2,
    suggestion: "Use sentence case; reserve uppercase for proper nouns.",
    check: (subject, body) => {
      const text = `${subject} ${body}`;
      const upper = (text.match(/[A-Z]/g) ?? []).length;
      const total = (text.match(/[a-zA-Z]/g) ?? []).length;
      return total > 0 && upper / total > 0.3;
    },
  },
  {
    id: "spamWords",
    name: "Spam-trigger phrases",
    description: "Contains a phrase that filters commonly flag.",
    weight: 3,
    suggestion: 'Drop "free / winner / urgent / 무료 / 당첨 …" and similar.',
    check: (subject, body) => {
      const spam = [
        "free",
        "winner",
        "cash",
        "prize",
        "money",
        "offer",
        "guarantee",
        "limited time",
        "act now",
        "urgent",
        "무료",
        "당첨",
        "현금",
        "상금",
        "보장",
        "한정",
      ];
      const text = `${subject} ${body}`.toLowerCase();
      return spam.some((w) => text.includes(w));
    },
  },
  {
    id: "excessivePunctuation",
    name: "Repeated !! / ??",
    description: "More than two runs of repeated ! or ?.",
    weight: 2,
    suggestion: "One terminal punctuation mark per sentence.",
    check: (subject, body) => {
      const text = `${subject} ${body}`;
      return (text.match(/[!?]{2,}/g) ?? []).length > 2;
    },
  },
  {
    id: "noUnsubscribe",
    name: "Missing unsubscribe link",
    description: "Body has no unsubscribe/수신거부 wording.",
    weight: 3,
    suggestion: 'Add a footer like "Unsubscribe — link". gmail.send adds one automatically when configured.',
    check: (_subject, body) => {
      const t = body.toLowerCase();
      return !t.includes("unsubscribe") && !t.includes("수신거부");
    },
  },
  {
    id: "suspiciousLinks",
    name: "URL shorteners",
    description: "Body links via bit.ly / tinyurl / goo.gl / ow.ly / t.co.",
    weight: 2,
    suggestion: "Link directly to the canonical URL.",
    check: (_subject, body) => {
      const shorteners = ["bit.ly", "tinyurl", "goo.gl", "ow.ly", "t.co"];
      return shorteners.some((d) => body.includes(d));
    },
  },
  {
    id: "noPhysicalAddress",
    name: "No physical address",
    description: "CAN-SPAM expects a real-world postal address in commercial mail.",
    weight: 2,
    suggestion: "Include the brand's mailing address in the footer.",
    check: (_subject, body) => {
      const kw = ["address", "street", "city", "state", "zip", "주소", "시", "구", "동"];
      const t = body.toLowerCase();
      return !kw.some((k) => t.includes(k));
    },
  },
  {
    id: "genericGreeting",
    name: "Generic greeting",
    description: '"Dear customer / 고객님께" — addresses no one.',
    weight: 1,
    suggestion: "Address the recipient by name (e.g. via {{name}}).",
    check: (_subject, body) => {
      const generics = ["dear customer", "dear user", "dear friend", "고객님께", "사용자님"];
      const t = body.toLowerCase();
      return generics.some((g) => t.includes(g));
    },
  },
  {
    id: "imageOnly",
    name: "Image-heavy with little text",
    description: "Contains <img> but the visible text is < 100 chars.",
    weight: 3,
    suggestion: "Add meaningful copy alongside images.",
    check: (_subject, body) => {
      const hasImages = /<img|image/i.test(body);
      const textLen = body.replace(/<[^>]*>/g, "").trim().length;
      return hasImages && textLen < 100;
    },
  },
  {
    id: "misleadingSubject",
    name: "Fake Re:/Fwd: prefix",
    description: "Initial outreach pretending to be a reply or forward.",
    weight: 3,
    suggestion: "Drop the Re:/Fwd: prefix on a first-touch email.",
    check: (subject) => /^(re:|fwd:|fw:)/i.test(subject.trim()),
  },
  {
    id: "hiddenText",
    name: "Hidden text",
    description: "CSS that hides text (white-on-white, display:none, font-size:0).",
    weight: 4,
    suggestion: "Don't hide text — Gmail penalizes it heavily.",
    check: (_subject, body) => {
      const patterns = [
        /color:\s*white.*background(-color)?:\s*white/i,
        /color:\s*#fff.*background(-color)?:\s*#fff/i,
        /font-size:\s*0/i,
        /display:\s*none/i,
      ];
      return patterns.some((p) => p.test(body));
    },
  },
];

/**
 * Score a single draft. Pure; safe to call from a tight tournament loop.
 */
export function calculateSpamScore(subject: string, body: string, from = ""): SpamScoreResult {
  const triggered: SpamRuleHit[] = [];
  for (const r of RULES) {
    if (r.check(subject, body, from)) {
      triggered.push({ ruleId: r.id, weight: r.weight, suggestion: r.suggestion });
    }
  }
  const raw = triggered.reduce((sum, h) => sum + h.weight, 0);
  const score = Math.min(10, raw);
  const suggestions = [...new Set(triggered.map((h) => h.suggestion))];
  return { score, risk: riskFor(score), triggered, suggestions };
}

/** Exposed for tests / docs / MC tooltips. */
export function listSpamRules(): ReadonlyArray<Pick<SpamRule, "id" | "name" | "description" | "weight">> {
  return RULES.map(({ id, name, description, weight }) => ({ id, name, description, weight }));
}
