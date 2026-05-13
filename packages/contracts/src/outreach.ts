import { z } from "zod";

/**
 * GroundedFacts for outreach — deterministic extraction from
 * (brief + creator + recentPosts). The Outreach Writer agent only cites
 * what's in here; v1's "positive-only" prompt discipline carries over.
 *
 * Why a closed schema: the judges (and a future LLM-as-fact-verifier) check
 * each draft's claims against this exact set. An open free-text "context"
 * blob defeats the audit trail.
 *
 * v1's `GroundedFacts` (~/social-seeding/src/lib/cold-mail/schemas.ts) is
 * CRM-account-centric (company / industry / NumberFact[]). v2's outreach is
 * to TikTok creators, so the fact shape is creator-centric: handle, signature
 * (bio), recent post themes, and the brand's pitch. Numbers are pulled from
 * the ranking-score capability output (avgViews, engagementRate), not
 * re-extracted from prose.
 */
export const OutreachFactsSchema = z.object({
  creator: z.object({
    uniqueId: z.string(), // "@freshly"
    nickname: z.string(),
    signature: z.string().default(""), // TikTok bio
    /** Up to 5 of the creator's most-used hashtags (from profile + recent posts). */
    topHashtags: z.array(z.string()).max(5).default([]),
    /** Up to 3 short descriptors of recent post themes (extracted phrases). */
    recentPostThemes: z.array(z.string()).max(3).default([]),
    followerCount: z.number().int().nonnegative(),
    /** R1 outputs if available — the judges and conversion rubric read these. */
    avgViews: z.number().int().nonnegative().optional(),
    engagementRate: z.number().min(0).max(1).optional(),
  }),
  brand: z.object({
    name: z.string(),
    category: z.string(),
    description: z.string(),
    /** Verbatim from the brief — only these may be cited by the drafter. */
    keyClaims: z.array(z.string()).default([]),
  }),
  logistics: z.object({
    shipsSamples: z.boolean(),
  }),
  /**
   * False when the creator profile has neither a signature nor recent post
   * themes — the drafter would have nothing concrete to cite, so the agent
   * should escalate instead of inventing details. v1's
   * `InsufficientContextError` carried over as a return-value flag (no throw).
   */
  hasMinimumContext: z.boolean(),
});
export type OutreachFacts = z.infer<typeof OutreachFactsSchema>;

/**
 * Judge scorecard — one per tournament judge, mirrors v1's `ScoreCard` shape.
 * Score range [0, 1]; the agent computes the weighted sum via JUDGE_WEIGHTS
 * to pick a tournament winner.
 */
export const JudgeKeySchema = z.enum(["brand", "conversion", "deliverability", "skeptic"]);
export type JudgeKey = z.infer<typeof JudgeKeySchema>;

export const JudgeScoreCardSchema = z.object({
  judge: JudgeKeySchema,
  score: z.number().min(0).max(1),
  rationale: z.string(),
  flags: z.array(z.string()).default([]),
});
export type JudgeScoreCard = z.infer<typeof JudgeScoreCardSchema>;

/**
 * Tournament weights carried verbatim from v1
 * (~/social-seeding/src/lib/cold-mail/judges.ts:JUDGE_WEIGHTS) so a/b
 * comparisons between v1 and v2 tournament winners stay calibrated.
 */
export const JUDGE_WEIGHTS: Record<JudgeKey, number> = {
  skeptic: 0.4,
  conversion: 0.3,
  deliverability: 0.15,
  brand: 0.15,
};

/** Weighted sum of a draft's 4 scorecards. */
export function weightedJudgeScore(cards: JudgeScoreCard[]): number {
  let total = 0;
  let weightSum = 0;
  for (const c of cards) {
    const w = JUDGE_WEIGHTS[c.judge];
    total += c.score * w;
    weightSum += w;
  }
  return weightSum === 0 ? 0 : total / weightSum;
}

/**
 * Outreach draft — output contract of the Outreach Writer agent
 * (which wraps v1's `lib/cold-mail` extractFacts→draft→reviser→tournament pipeline).
 */
export const OutreachDraftSchema = z.object({
  subject: z.string().min(1).max(120),
  body: z.string().min(1),
  angle: z.string(), // which of the cold-mail "angles" won the tournament
  spamScore: z.number().min(0).max(10), // v1 spam-score.ts
  groundedFacts: z.array(z.string()), // every claim must trace to a fact (v1 verifiers)
  judgeScores: z
    .object({ brand: z.number(), conversion: z.number(), deliverability: z.number(), skeptic: z.number() })
    .partial()
    .optional(),
});
export type OutreachDraft = z.infer<typeof OutreachDraftSchema>;

/** Reply classification — output contract of the Conversation agent. */
export const ReplyClassSchema = z.enum([
  "interested", // wants to proceed
  "needs_info", // asked a question we can answer
  "negotiating", // rate/terms — usually escalates
  "not_now", // soft no, maybe later
  "declined", // hard no
  "out_of_office",
  "unsubscribe",
  "unrelated",
]);
export type ReplyClass = z.infer<typeof ReplyClassSchema>;

export const ConversationTurnSchema = z.object({
  threadId: z.string(),
  creatorId: z.string(),
  incomingMessageId: z.string(),
  classification: ReplyClassSchema,
  extracted: z
    .object({
      shippingAddress: z.string().optional(),
      proposedRateUsd: z.number().optional(),
      question: z.string().optional(),
    })
    .partial(),
  draftedReply: OutreachDraftSchema.pick({ subject: true, body: true }).optional(),
  needsHumanReason: z.string().optional(), // set when classification ⇒ escalate
});
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;
