import { z } from "zod";
import { CampaignBriefSchema, OutreachDraftSchema, OutreachFactsSchema, TikTokCreatorSchema } from "@ss/contracts";
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
  // Live-demo lesson 2026-05-14: Opus 4.7 in the multi-tool tournament
  // mode (extractFacts + 5 angles × 4 judges) sometimes emits XML-style
  // tool calls as TEXT instead of native tool_use blocks, breaking
  // the runtime's tool-result loop. Mitigations:
  //   · `facts` is now an OPTIONAL input — when provided by the
  //     workflow (via outreach.extractFacts), the prompt instructs the
  //     model to skip extractFacts and use them directly.
  //   · The single-angle prompt path replaces the 5-angle tournament
  //     when facts are pre-computed (the workflow already did the
  //     extractFacts work; tournament-style judging adds more cost than
  //     value at $15/MTok input).
  //   · Tools STAY in the curated list — fake ModelClients in unit
  //     tests script extractFacts + judge tool_use to exercise the
  //     tournament shape; live Opus follows the prompt and skips them.
  // Cap raised from $0.80 to $1.5: Opus is more expensive than the
  // Haiku-pricing intuition the original cap was set on.
  maxUsd: 1.5,
  input: z.object({
    brief: CampaignBriefSchema,
    creator: TikTokCreatorSchema,
    /** Optional pre-fetched posts. Saves a round-trip when the workflow already pulled them via tiktok.getCreator. */
    recentPosts: z
      .array(z.object({ desc: z.string().default(""), hashtags: z.array(z.string()).default([]) }))
      .default([]),
    /**
     * Pre-computed OutreachFacts. When provided, the agent skips the
     * extractFacts tool call (it's deterministic; the workflow already ran
     * it) and uses these facts directly. This is the production path —
     * creator-track already calls `outreach.extractFacts` before invoking
     * the writer to early-exit on `hasMinimumContext=false`, so passing
     * the result through here saves a round-trip + sidesteps Opus's
     * occasional refusal to call the tool (live-demo lesson 2026-05-14).
     */
    facts: OutreachFactsSchema.optional(),
    /** Voice + style guidance from workspace policy (free-text). */
    voiceNotes: z.string().default(""),
    /** Sender's signature block, appended verbatim to the final body. */
    signatureBlock: z.string().default(""),
    /** Phrases that should NEVER appear in a draft (brand-judge enforces). */
    bannedPhrases: z.array(z.string()).default([]),
  }),
  output: OutreachDraftSchema,
  systemPrompt: ({ brief, creator, facts, voiceNotes, bannedPhrases }) =>
    [
      `You are the Outreach Writer agent. Compose ONE cold-outreach email inviting @${creator.uniqueId} ("${creator.nickname}") to a "${brief.brandProduct.name}" (${brief.brandProduct.category}) TikTok collaboration.`,
      brief.logistics.shipsSamples
        ? "Sample policy: we ARE sending a free sample. The draft must invite the creator to receive it."
        : "Sample policy: NO sample. This is a paid / affiliate ask — never imply a free sample.",
      voiceNotes ? `Brand voice: ${voiceNotes}` : "Brand voice: neutral, warm, concise (no specific style notes provided).",
      bannedPhrases.length > 0 ? `Banned phrases (do not use): ${bannedPhrases.join(", ")}.` : "",
      "",
      facts
        ? [
            "## OutreachFacts (already computed by the workflow — your closed fact set)",
            "",
            "```json",
            JSON.stringify(facts, null, 2),
            "```",
            "",
            "These are the ONLY claims you may cite about the creator + brand. Do NOT call `outreach.extractFacts` — it would return the same data.",
            facts.hasMinimumContext === false
              ? "hasMinimumContext is FALSE — respond immediately with {\"escalate\":\"insufficient_context\"}."
              : "hasMinimumContext is TRUE — proceed to drafting.",
            "",
          ].join("\n")
        : "",
      "## Procedure",
      "",
      "1. Pick THE strongest ANGLE for this creator from this hypothesis space:",
      "   · pain_killer        — empathize with a friction point the creator has shown.",
      "   · aspirational       — reach-goal framing tied to the creator's themes.",
      "   · peer_proof         — same-niche success pattern, citing themes from the fact set.",
      "   · data_specific      — a concrete claim from `brand.keyClaims`, anchored to one creator theme.",
      "   · contrarian_hook    — open with a counter-intuitive insight relevant to the creator's content.",
      "   Pick ONE based on the facts above. Do NOT draft alternatives.",
      "",
      "2. Write ONE draft for the chosen angle (subject ≤ 80 chars; body ≈ 200–800 chars when stripped of HTML; exactly one '?' as the call-to-action; cite at least one fact from `OutreachFacts.creator.recentPostThemes` or `topHashtags`).",
      "",
      "3. Self-rate `spamScore` 0–10 (lower = better): start at 1, add 1 for each spammy phrase ('urgent', 'limited time', overuse of CAPS, multiple '!'s, '$', 'free!', etc).",
      "",
      "4. Respond with ONE JSON object matching the OutreachDraft schema. No tool calls. No prose, no markdown fences. The 4 judges (brand / conversion / deliverability / skeptic) run AFTER you, deterministically, in the workflow — leave `judgeScores` as { brand: 0.7, conversion: 0.7, deliverability: 0.7, skeptic: 0.7 } and the workflow will overwrite with real scores.",
      "",
      "   { subject, body, angle: <one of the AngleKey strings above>, spamScore: <your 0–10 self-rate>, groundedFacts: [<short strings naming what the body cited, e.g. 'recentPostThemes[0]', 'topHashtags[1]', 'brand.keyClaims[0]'>], judgeScores: { brand: 0.7, conversion: 0.7, deliverability: 0.7, skeptic: 0.7 } }",
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
