import { z } from "zod";

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
