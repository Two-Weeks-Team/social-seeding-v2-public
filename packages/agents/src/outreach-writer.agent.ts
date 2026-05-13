import { z } from "zod";
import { CampaignBriefSchema, OutreachDraftSchema, TikTokCreatorSchema } from "@ss/contracts";
import { defineAgent } from "./runtime";

/**
 * Outreach Writer agent. THIS WRAPS v1's `lib/cold-mail` pipeline verbatim:
 *   extractFacts(brief + creator) → GroundedFacts
 *   → if !has_minimum_context: escalate (don't guess)
 *   → draftWriter → reviser loop (evaluator-optimizer, ≤3 iters) → verifiers
 *   → tournament: plan ≤5 angles, draft each, critic-revise each, score with
 *     4 judges (brand / conversion / deliverability / skeptic) → pick winner
 *   → spam-score (v1 spam-score.ts) pre-check
 * The output is grounded — every claim traces to a fact. The send itself is a
 * separate capability (`gmail.send`, scope external_send) and a policy gate.
 *
 * This is the highest-leverage port: it's already an agent done right.
 */
export const outreachWriterAgent = defineAgent({
  id: "outreach-writer",
  description: "Write a grounded, personalized outreach email for one creator, picked from a multi-angle tournament and judged for brand/conversion/deliverability.",
  tools: [], // pure given inputs; facts pre-extracted by the workflow (no I/O — mirrors v1 agent.ts boundary)
  model: "claude-opus-4-7",
  maxUsd: 0.8,
  input: z.object({
    brief: CampaignBriefSchema,
    creator: TikTokCreatorSchema,
    voiceNotes: z.string().default(""), // from workspace policy
    signatureBlock: z.string().default(""),
    bannedPhrases: z.array(z.string()).default([]),
  }),
  output: OutreachDraftSchema,
  systemPrompt: ({ brief, creator, voiceNotes }) => `You are the Outreach Writer. Compose a cold email inviting @${creator.uniqueId} to a "${brief.brandProduct.name}" TikTok collaboration.
RULES (carried from the cold-mail pipeline):
- Every concrete claim must be grounded in the facts you were given. No invented metrics, no fake mutual connections.
- ${brief.logistics.shipsSamples ? "We're sending a free sample." : "No sample; this is a paid/affiliate ask."}
- Match the brand voice: ${voiceNotes || "(none specified — neutral, warm, concise)"}.
- One clear ask. Subject ≤ 80 chars. Body short enough to read on a phone.
- It will be scored by brand / conversion / deliverability / skeptic-recipient judges and a spam-score check — write to survive all four.
If you don't have enough grounded facts to write something a real person would reply to, do not pad — escalate.`,
});
