import { z } from "zod";
import {
  LeadCampaignBriefSchema,
  LeadResearchSchema,
  OutreachDraftSchema,
} from "@ss/contracts";
import { defineAgent } from "./runtime";

/**
 * lead-outreach-writer — Phase 5 P5-C3. B2B sibling of the Phase-2
 * outreach-writer. Drafts ONE cold-sales email from the LeadCampaignBrief
 * + the lead's research summary (from P5-C2's research agent).
 *
 * Architecture parity with the brand-side writer:
 *  · Same OutreachDraft output (subject + body + angle + judge scores +
 *    grounded facts + spam score) — the gate, gmail.send, and the
 *    conversation classifier all read this same shape regardless of
 *    which writer produced it.
 *  · Reuses the 4 deterministic judges from Phase 2
 *    (`outreach.judge` capability) — brand / conversion / deliverability
 *    / skeptic. The judge code is general-purpose and works on any
 *    {subject, body, facts} triple.
 *
 * Difference vs the brand writer:
 *  · No tiktok.getCreator / hashtag context. The grounded facts come
 *    from the research agent (P5-C2) which already distilled them.
 *  · Tone leans sales: the system prompt enforces "you are pitching a
 *    SaaS product to a business decision-maker" — not "you are inviting
 *    a creator to a free sample."
 *
 * Gemini 3.5 Flash — same as brand writer; judgment quality is what we pay for.
 * Higher cap ($1.20) than the brand writer because B2B emails are
 * longer + go through more revision passes.
 */
export const leadOutreachWriterAgent = defineAgent({
  id: "lead-outreach-writer",
  description:
    "Write a grounded, personalized cold-sales email for one B2B lead from its research summary. Scores draft with the 4 judges; returns the weighted winner.",
  tools: ["outreach.judge", "templates.render"],
  model: "gemini-3.5-flash",
  maxUsd: 1.2,
  input: z.object({
    brief: LeadCampaignBriefSchema,
    research: LeadResearchSchema,
    lead: z.object({
      companyName: z.string().min(1),
      companyNameEn: z.string().optional(),
      country: z.string().length(2).default("KR"),
      homepageUrl: z.string().url().optional(),
      contactEmail: z.string().email().optional(),
    }),
    /** Sender's signature — appended verbatim to the body. */
    signatureBlock: z.string().default(""),
    /** Phrases banned by workspace policy. */
    bannedPhrases: z.array(z.string()).default([]),
  }),
  output: OutreachDraftSchema,
  systemPrompt: ({ brief, research, lead, signatureBlock, bannedPhrases }) =>
    [
      `You are the Lead Outreach Writer. Compose ONE cold-sales email pitching "${brief.ourProduct.name}" (${brief.ourProduct.pitchSummary}) to ${lead.companyName}${lead.companyNameEn ? ` (${lead.companyNameEn})` : ""}.`,
      "",
      `## What we're pitching`,
      `Product: ${brief.ourProduct.name}`,
      `Summary: ${brief.ourProduct.pitchSummary}`,
      brief.ourProduct.keyClaims.length > 0
        ? `Key claims: ${brief.ourProduct.keyClaims.join(" / ")}`
        : "",
      brief.outreach.toneNotes ? `Voice notes: ${brief.outreach.toneNotes}` : "Voice notes: neutral, warm, concise.",
      bannedPhrases.length > 0 ? `Banned phrases (do not use): ${bannedPhrases.join(", ")}.` : "",
      "",
      `## Lead`,
      `Company: ${lead.companyName}`,
      lead.homepageUrl ? `URL: ${lead.homepageUrl}` : "",
      `Country: ${lead.country}`,
      "",
      `## Research summary (from the research agent — your single source of truth)`,
      `Pitch: ${research.pitch}`,
      "Angles to choose among:",
      ...research.angles.map((a, i) => `  ${i + 1}. ${a}`),
      research.groundedFacts.length > 0
        ? `Grounded facts (cite only what's here):\n${research.groundedFacts.map((f) => `  · ${f}`).join("\n")}`
        : "Grounded facts: (none — your draft must therefore be brief + skip company-specific claims).",
      research.contactProfile ? `Contact profile: ${research.contactProfile}` : "",
      `Research confidence: ${research.confidence}/100.`,
      "",
      "## Procedure",
      "1. Pick the strongest angle from the research summary (you don't need to draft all of them). Justify the choice silently — the chosen angle becomes the `angle` field of your output.",
      "",
      "2. Draft the email:",
      "   · subject: 6-10 words, no spammy phrases (no 'quick chat?', no 'limited time'),",
      "   · body: 3-5 short paragraphs in HTML. Open with a SPECIFIC observation about THIS company (cite a grounded fact). Then the pitch. Then a single, low-pressure CTA.",
      "   · Korean lead → Korean draft. English lead → English draft.",
      "   · Length: ≤220 words.",
      "",
      "3. Call `outreach.judge` 4 times — once for each judge ('brand', 'conversion', 'deliverability', 'skeptic') — passing `{judge, draft, facts}` where `facts` is the research.groundedFacts list. Append each judge's score to your draft's `judgeScores`.",
      "",
      "4. If the weighted score (skeptic 0.40, conversion 0.30, deliverability 0.15, brand 0.15) is < 0.65, REVISE the draft once (different angle or sharper opener) and re-run the judges.",
      "",
      "5. Return the OutreachDraft JSON with:",
      "   · subject, body, angle ('data_specific' | 'pain_killer' | 'mutual_benefit' | 'authority' | 'directness'),",
      "   · spamScore (deliverability judge's raw 0-10 number),",
      "   · groundedFacts (the subset of research.groundedFacts you actually used),",
      "   · judgeScores ({brand, conversion, deliverability, skeptic} all in [0,1]).",
      "",
      "## Discipline",
      "  · Don't invent facts. The research agent's grounded facts are the only company-specific claims you may make.",
      "  · If research.confidence < 30, escalate via `{\"escalate\":\"research_confidence_too_low\"}` — the workflow will skip this lead.",
      "  · Sign off with our brand name. The signature block below is appended verbatim — don't repeat it.",
      "",
      signatureBlock ? `## Signature block (appended automatically — DO NOT include in body):\n${signatureBlock}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
});
