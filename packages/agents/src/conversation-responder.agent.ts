import { z } from "zod";
import {
  ConversationTurnSchema,
  OutreachDraftSchema,
  OutreachFactsSchema,
} from "@ss/contracts";
import { defineAgent } from "./runtime";

/**
 * Conversation responder agent — drafts the reply on a creator thread when
 * the classifier (conversationAgent) returned a turn that needs one.
 *
 * Why a separate agent (not part of conversationAgent):
 *   · classification fires on EVERY inbound. Drafting is rarer. Splitting
 *     saves the Opus call on declines / out-of-office / unrelated / unsub.
 *   · classification needs to be cheap + JSON-strict (Haiku). Drafting needs
 *     tone + judgment (Opus 4.7). Model routing carried from ARCHITECTURE.md.
 *
 * Curated tools:
 *   · outreach.judge   — self-check the reply on deliverability + skeptic.
 *                        Same 4-judge bench as the outreach writer agent.
 *   · templates.render — when the workflow passes a reply template by id /
 *                        inline body, this fills variables.
 *
 * The agent does NOT call gmail.send — that's a separate workflow step
 * after the `approveReplyResponse` policy gate (when configured).
 */
export const conversationResponderAgent = defineAgent({
  id: "conversation-responder",
  description:
    "Draft a single reply to a classified inbound creator message. Cites only the OutreachFacts + the verbatim incoming message; self-checks deliverability via outreach.judge before returning.",
  tools: ["outreach.judge", "templates.render"],
  model: "claude-opus-4-7",
  // Cap raised 0.25 → 0.6: live-demo 2026-05-14 observed Opus 4.7
  // hitting the cap after 3 turns when the inbound reply triggered
  // outreach.judge + templates.render + a brief revise pass. Same
  // root cause as outreach-writer + sourcing agents — Haiku-pricing
  // intuition was too aggressive for an Opus model in a tool loop.
  // One reply, no tournament — but tool calls + the JSON output
  // contract reliably consume 4-5 Opus turns end-to-end.
  maxUsd: 0.6,
  input: z.object({
    /** The just-classified turn (output of conversationAgent). */
    turn: ConversationTurnSchema.omit({ draftedReply: true }),
    /**
     * Facts about the creator we're writing to — same shape the outreach
     * writer uses. Lets the responder personalize without re-deriving.
     */
    facts: OutreachFactsSchema,
    /**
     * Prior turns on the thread, oldest-first; the responder reads these to
     * stay coherent (e.g. don't repeat the original CTA).
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
    /** Workspace voice / banned phrases — same shape outreach-writer uses. */
    voiceNotes: z.string().default(""),
    signatureBlock: z.string().default(""),
    bannedPhrases: z.array(z.string()).default([]),
  }),
  output: OutreachDraftSchema.pick({ subject: true, body: true }).extend({
    /** Optional self-check score from outreach.judge[deliverability]; the workflow gates on this. */
    deliverabilityScore: z.number().min(0).max(1).optional(),
  }),
  systemPrompt: ({ turn, facts, threadHistory, voiceNotes, bannedPhrases }) =>
    [
      `You are the Conversation Responder. The thread is between us (the brand) and @${facts.creator.uniqueId} (${facts.creator.nickname}). The classifier returned classification="${turn.classification}".`,
      "",
      `## What we know`,
      `Brand: ${facts.brand.name} (${facts.brand.category}). Key claims: ${facts.brand.keyClaims.join(", ") || "(none)"}.`,
      `Sample policy: ${facts.logistics.shipsSamples ? "WE ship a sample (free)." : "NO sample — paid/affiliate only."}`,
      facts.creator.recentPostThemes.length > 0
        ? `Creator themes we already cited (don't repeat verbatim): ${facts.creator.recentPostThemes.join(" / ")}.`
        : "",
      voiceNotes ? `Brand voice: ${voiceNotes}` : "",
      bannedPhrases.length > 0 ? `Banned phrases: ${bannedPhrases.join(", ")}.` : "",
      "",
      `## The inbound message (classified as ${turn.classification})`,
      turn.extracted.question ? `Their question (verbatim): ${turn.extracted.question}` : "",
      turn.extracted.shippingAddress ? `Shipping address they shared: ${turn.extracted.shippingAddress}` : "",
      turn.extracted.proposedRateUsd !== undefined ? `They proposed: USD ${turn.extracted.proposedRateUsd}.` : "",
      "",
      threadHistory.length > 0
        ? `## Thread history (oldest-first, last ≤6)\n${threadHistory
            .slice(-6)
            .map(
              (t, i) =>
                `[${i + 1}] ${t.role === "us" ? "WE wrote" : "THEY wrote"}: ${t.subject || "(no subject)"}\n${t.bodyText.slice(0, 600)}`,
            )
            .join("\n\n")}`
        : "",
      "",
      "## Procedure",
      "1. Decide what to address in the reply, in this priority order:",
      "   · interested + shippingAddress → confirm receipt, set expectation on shipping ETA + posting timeline.",
      "   · interested + no address     → ask for the shipping address. ONE clear question.",
      "   · needs_info                  → answer the literal question. No upsell.",
      "2. Draft a subject (≤ 80 chars) and an HTML body (single paragraph or two short paragraphs; 200–800 visible chars).",
      "3. Call outreach.judge with judge='deliverability' on your draft. If score < 0.8, revise once and re-judge. Report the final deliverabilityScore.",
      "4. Discipline:",
      "   · Use the recipient's nickname / @handle.",
      "   · Don't invent product specs not in brand.keyClaims.",
      "   · Don't promise samples when shipsSamples=false.",
      "   · Don't add an unsubscribe footer or tracking pixel — gmail.send adds those.",
      "   · No Re:/Fwd: prefixes (the deliverability judge will flag).",
      "5. If you genuinely cannot draft a reply that clears deliverability ≥ 0.5 OR the inbound is hostile / out-of-scope, return {\"escalate\":\"<reason>\"}.",
      "",
      "Output: { subject, body, deliverabilityScore } — nothing else.",
    ]
      .filter(Boolean)
      .join("\n"),
});

export const ConversationResponderInputSchema = conversationResponderAgent.input;
export type ConversationResponderInput = z.infer<typeof ConversationResponderInputSchema>;
export const ConversationResponderOutputSchema = conversationResponderAgent.output;
export type ConversationResponderOutput = z.infer<typeof ConversationResponderOutputSchema>;
