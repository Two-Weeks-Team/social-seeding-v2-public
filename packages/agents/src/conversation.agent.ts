import { z } from "zod";
import { ConversationTurnSchema, ReplyClassSchema } from "@ss/contracts";
import { defineAgent } from "./runtime";

/**
 * Conversation agent — classifies an inbound reply on a creator thread and
 * extracts the structured signals the workflow needs to branch on (shipping
 * address, proposed rate, the question being asked).
 *
 * Haiku 4.5 by design: this fires on every inbound message and runs hot. The
 * agent itself never drafts a reply — that's the Opus-grade
 * `conversationResponderAgent` (next file), which the workflow invokes only
 * when the classification calls for one (`interested` / `needs_info` /
 * `negotiating`).
 *
 * Split rationale (port of v1's email-handling discipline): keep the
 * thread-classifier cheap, predictable, and JSON-shaped; reserve Opus for
 * the actual creative judgment-call of replying. ARCHITECTURE.md routing:
 * Haiku for bulk, Opus for judgment.
 *
 * Extraction targets — only what the workflow branches on:
 *   · `shippingAddress`  → unlocks `shipment.create` (Phase 3) when classification = "interested".
 *   · `proposedRateUsd`  → drives the `approveReplyResponse` gate when classification = "negotiating".
 *   · `question`         → fed to the responder agent when classification = "needs_info".
 *
 * `needsHumanReason` is set when (a) classification ∈ {negotiating, declined,
 * unsubscribe} — these always escalate — OR (b) the agent's confidence in its
 * own classification is low and the workflow should pause for a human review.
 */
export const conversationAgent = defineAgent({
  id: "conversation",
  description:
    "Classify an inbound creator reply and extract structured signals (address / rate / question) for the workflow to branch on. Never drafts — that's the responder agent.",
  tools: [], // pure classification — no I/O
  model: "claude-haiku-4-5",
  maxUsd: 0.02, // tight cap; Haiku on a short reply should be << $0.01
  input: z.object({
    threadId: z.string().min(1),
    creatorId: z.string().min(1),
    /** The just-arrived message. */
    incomingMessage: z.object({
      messageId: z.string().min(1),
      fromEmail: z.string().email(),
      subject: z.string().default(""),
      /** Plain-text body of the incoming reply (already stripped of HTML upstream). */
      bodyText: z.string().min(1).max(20_000),
    }),
    /**
     * Prior turns on the thread, oldest-first. Trimmed by the workflow to the
     * most recent ~6 to keep the prompt small.
     */
    threadHistory: z
      .array(
        z.object({
          role: z.enum(["us", "them"]),
          subject: z.string().default(""),
          bodyText: z.string().default(""),
        }),
      )
      .default([]),
    /** Handle / display name we used for outreach — helps the classifier on "is this even the creator". */
    creatorHandle: z.string().default(""),
  }),
  // The agent fills classification + extracted + (optionally) needsHumanReason.
  // draftedReply is always left undefined here; the responder agent fills it
  // in a separate workflow step when applicable. We omit it from the contract
  // shape the agent has to produce, so the output stays simple and the
  // Haiku prompt stays cheap.
  output: ConversationTurnSchema.omit({ draftedReply: true }),
  systemPrompt: ({ incomingMessage, threadHistory, creatorHandle }) =>
    [
      "You are the Conversation agent for an automated TikTok seeding operator.",
      `You classify an inbound reply from a creator${creatorHandle ? ` (@${creatorHandle})` : ""} and extract the structured signals the workflow branches on. You DO NOT draft responses — that's a separate agent the workflow invokes when needed.`,
      "",
      `## Inbound message`,
      `From: ${incomingMessage.fromEmail}`,
      `Subject: ${incomingMessage.subject || "(no subject)"}`,
      `Body:`,
      "```",
      incomingMessage.bodyText,
      "```",
      "",
      threadHistory.length > 0
        ? `## Prior turns on this thread (${threadHistory.length}, oldest-first)\n${threadHistory
            .map(
              (t, i) =>
                `[${i + 1}] ${t.role === "us" ? "WE wrote" : "THEY wrote"}: ${t.subject || "(no subject)"}\n${t.bodyText.slice(0, 600)}`,
            )
            .join("\n\n")}`
        : "## Prior turns on this thread\n(none — this is the first reply)",
      "",
      "## Classification — pick exactly ONE:",
      "  · interested      — wants to proceed (positive tone, asking for next steps, agreeing to terms, sharing address).",
      "  · needs_info      — asked a concrete question that we can answer (product details, timing, what we expect).",
      "  · negotiating     — counter-offered on rate / terms / sample quantity / posting requirements. ALWAYS escalates.",
      "  · not_now         — soft no, maybe later (busy this month, vacation, comeback later).",
      "  · declined        — hard no. ALWAYS escalates.",
      "  · out_of_office   — automated OOO bounce.",
      "  · unsubscribe     — asks to be removed / used the unsubscribe link / 'don't email again'. ALWAYS escalates.",
      "  · unrelated       — spam / wrong person / nothing to do with the original outreach.",
      "",
      "## Extraction — populate only when the body actually contains the signal (string match, not paraphrase):",
      "  · shippingAddress  — full mailing address if the creator shared one. Strip the surrounding sentence; just the address.",
      "  · proposedRateUsd  — a USD-equivalent number if they proposed a rate (convert from KRW at ~1300:1 when given in 원; round to integer).",
      "  · question         — the literal question they asked, verbatim, if classification = needs_info.",
      "",
      "## When to set needsHumanReason:",
      "  · classification ∈ {negotiating, declined, unsubscribe}.",
      "  · or the body contains anything you can't parse cleanly (multiple competing requests, legal threats, anything off-topic and tense).",
      "  · or your classification confidence is low — say so honestly.",
      "",
      "Discipline:",
      "  · Match the body literally. If they said 'next week', that's not 'not_now' unless context confirms it.",
      "  · Don't draft anything. The OutreachDraft fields are filled by a separate agent — leave them out.",
      "  · If the body is empty after trimming auto-reply noise, classify as out_of_office.",
      "  · Always include threadId, creatorId, and incomingMessageId verbatim from the input — the workflow joins on them.",
    ].join("\n"),
});

export const ConversationAgentInputSchema = conversationAgent.input;
export type ConversationAgentInput = z.infer<typeof ConversationAgentInputSchema>;
export const ConversationAgentOutputSchema = conversationAgent.output;
export type ConversationAgentOutput = z.infer<typeof ConversationAgentOutputSchema>;

/**
 * Pure helper exposed for the workflow + tests: do we need the (expensive)
 * responder agent to draft a reply for this turn? Centralizes the branching
 * rule so the workflow + the responder unit-tests stay in sync.
 */
export function needsResponseDraft(turn: { classification: ReplyClass }): boolean {
  return turn.classification === "interested" || turn.classification === "needs_info";
}
type ReplyClass = z.infer<typeof ReplyClassSchema>;
