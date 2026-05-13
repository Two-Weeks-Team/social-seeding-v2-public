import { z } from "zod";
import { CampaignBriefSchema, OutreachDraftSchema, TikTokCreatorSchema } from "@ss/contracts";
import { defineAgent } from "./runtime";

/**
 * Outreach Writer agent — port of v1's `lib/cold-mail` discipline reshaped to
 * fit the v2 single-agent runtime.
 *
 * v1 was a multi-LLM-call orchestration (extract-facts → drafter → reviser ×3
 * → tournament: 5 angles × 4 judges → winner). v2's runtime keeps the agent as
 * ONE bounded LLM session that calls deterministic capabilities as tools:
 *
 *   1. outreach.extractFacts(brief, creator, recentPosts?) → OutreachFacts
 *      → if hasMinimumContext === false, escalate (don't pad with guesses).
 *   2. plan 2–5 candidate "angles" (the agent decides internally — same
 *      hypothesis space as v1: pain-killer / aspirational / peer-proof /
 *      data-specific / contrarian-hook).
 *   3. for each angle: draft a subject + body that cites ONLY facts from
 *      step (1); call outreach.judge once per (brand, conversion,
 *      deliverability, skeptic) on the draft.
 *   4. compute the weighted tournament score (JUDGE_WEIGHTS in @ss/contracts).
 *   5. if the best draft's deliverability flags include a CRITICAL spam-rule
 *      hit (e.g. hiddenText), revise once and re-judge; otherwise return the
 *      winner with its judgeScores attached.
 *
 * `tools` (curated): outreach.extractFacts, outreach.judge, templates.render.
 * The agent cannot send mail itself — that's gmail.send, a separate
 * `external_send`-scoped capability gated by `approveOutreachSend`.
 *
 * The OutreachDraft contract has not changed since the scaffold; the agent
 * fills `groundedFacts` from the OutreachFacts.creator.* that were actually
 * cited so the approval UI can render the audit trail.
 */
export const outreachWriterAgent = defineAgent({
  id: "outreach-writer",
  description:
    "Write a grounded, personalized outreach email for one creator. Drafts ≤5 angles internally, scores each with the 4 deterministic judges (brand/conversion/deliverability/skeptic), returns the weighted winner with its judge scorecards attached.",
  tools: ["outreach.extractFacts", "outreach.judge", "templates.render"],
  model: "claude-opus-4-7",
  maxUsd: 0.8,
  input: z.object({
    brief: CampaignBriefSchema,
    creator: TikTokCreatorSchema,
    /** Optional pre-fetched posts. Saves a round-trip when the workflow already pulled them via tiktok.getCreator. */
    recentPosts: z
      .array(z.object({ desc: z.string().default(""), hashtags: z.array(z.string()).default([]) }))
      .default([]),
    /** Voice + style guidance from workspace policy (free-text). */
    voiceNotes: z.string().default(""),
    /** Sender's signature block, appended verbatim to the final body. */
    signatureBlock: z.string().default(""),
    /** Phrases that should NEVER appear in a draft (brand-judge enforces). */
    bannedPhrases: z.array(z.string()).default([]),
  }),
  output: OutreachDraftSchema,
  systemPrompt: ({ brief, creator, voiceNotes, bannedPhrases }) =>
    [
      `You are the Outreach Writer agent. Compose ONE cold-outreach email inviting @${creator.uniqueId} ("${creator.nickname}") to a "${brief.brandProduct.name}" (${brief.brandProduct.category}) TikTok collaboration.`,
      brief.logistics.shipsSamples
        ? "Sample policy: we ARE sending a free sample. The draft must invite the creator to receive it."
        : "Sample policy: NO sample. This is a paid / affiliate ask — never imply a free sample.",
      voiceNotes ? `Brand voice: ${voiceNotes}` : "Brand voice: neutral, warm, concise (no specific style notes provided).",
      bannedPhrases.length > 0 ? `Banned phrases (do not use): ${bannedPhrases.join(", ")}.` : "",
      "",
      "## Procedure",
      "",
      "1. Call `outreach.extractFacts` with the brief, creator, and any recentPosts that were provided. The returned OutreachFacts is the ONLY thing you may cite — no other claims about the creator are permitted. If `hasMinimumContext` is false, immediately return `{\"escalate\":\"insufficient_context\"}` — do not invent details.",
      "",
      "2. Internally plan 2–5 distinct candidate ANGLES from this hypothesis space (carried from v1's cold-mail tournament):",
      "   · pain_killer        — empathize with a friction point the creator has shown (slow brand response, sample fatigue, etc.).",
      "   · aspirational       — reach-goal framing tied to the creator's themes.",
      "   · peer_proof         — same-niche success pattern, citing themes from the fact set.",
      "   · data_specific      — a concrete claim from `brand.keyClaims`, anchored to one creator theme.",
      "   · contrarian_hook    — open with a counter-intuitive insight relevant to the creator's content.",
      "",
      "3. For each angle, write a candidate draft (subject ≤ 80 chars; body ≈ 200–800 chars when stripped of HTML; exactly one '?' as the call-to-action; cite at least one fact from `OutreachFacts.creator.recentPostThemes` or `topHashtags`).",
      "",
      "4. For EACH candidate, call `outreach.judge` four times — once with judge='brand', once 'conversion', once 'deliverability', once 'skeptic' — passing { draft: { subject, body }, facts: <from step 1>, bannedPhrases }.",
      "",
      "5. Compute the weighted tournament score for each candidate: skeptic·0.4 + conversion·0.3 + deliverability·0.15 + brand·0.15. Pick the best.",
      "",
      "6. If the winner's deliverability judge fired a `spam:hiddenText` / `spam:misleadingSubject` flag, revise that candidate once and re-judge deliverability only; otherwise the winner stands.",
      "",
      "7. Respond with the final OutreachDraft object:",
      "   { subject, body, angle: <one of the AngleKey strings above>, spamScore: <0–10, from deliverability judge's rationale>, groundedFacts: [<short strings naming what the body cited, e.g. 'recentPostThemes[0]', 'topHashtags[1]', 'brand.keyClaims[0]'>], judgeScores: { brand, conversion, deliverability, skeptic } }",
      "",
      "Discipline:",
      "  · No invented metrics (follower counts, view counts not in the fact set).",
      "  · No fake mutual connections / 'I saw your DM' / 'a friend recommended'.",
      "  · Subject line is plain text — no Re:/Fwd: prefixes (the deliverability judge will fail you on this).",
      "  · Body is HTML; the unsubscribe footer + tracking pixel are added by gmail.send — do NOT add them yourself.",
      "  · If you genuinely cannot produce a draft that clears every judge ≥ 0.5, escalate.",
    ]
      .filter(Boolean)
      .join("\n"),
});
