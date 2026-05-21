import { z } from "zod";
import { CandidateSchema, CampaignBriefSchema } from "@ss/contracts";
import { defineAgent } from "./runtime";

/**
 * Vetting agent. For each candidate: check the blacklist, pull profile +
 * recent posts via `tiktok.getCreator`, then compose `ranking.score` (R1 — the
 * shared ranking math) for engagement / avg views / influence score. Decides a
 * fitScore [0,1] and surfaces flags (below_engagement_floor / blacklisted /
 * wrong_language / brand_unsafe / prior_flake / data_stale). Replaces the
 * human eyeballing v1's Step 2 table.
 *
 * Cheap, high-volume — Gemini 3.1 Flash-Lite. The brand-campaign workflow
 * fans this out one call per candidate (see WF1 in PHASE-1-PLAN), so maxUsd
 * is per-invocation.
 */
export const vettingAgent = defineAgent({
  id: "vetting",
  description: "Score a candidate's brand-fit and surface risk flags using profile + recent-post data.",
  tools: ["tiktok.getCreator", "blacklist.check", "ranking.score"],
  model: "gemini-3.1-flash-lite",
  maxUsd: 0.1, // per candidate
  input: z.object({
    brief: CampaignBriefSchema,
    candidate: CandidateSchema.omit({ fitScore: true, vettedAt: true }),
  }),
  output: CandidateSchema,
  systemPrompt: ({ brief, candidate }) =>
    [
      `You are the Vetting agent. Score creator @${candidate.creator.uniqueId} for the "${brief.brandProduct.name}" (${brief.brandProduct.category}) campaign.`,
      "",
      "Procedure:",
      "1) Call blacklist.check on the candidate's uniqueId. If a hit returns severity=\"permanent\", return immediately with fitScore ≤ 0.1 and flags including \"blacklisted\".",
      "2) Call tiktok.getCreator with withRecentPosts=true to load profile + recent posts.",
      "3) Call ranking.score with { creator, recentPosts } from step (2) to compute avgViews / engagementRate / influenceScore.",
      "4) Decide fitScore (0–1) from: content-topic overlap with the brand, audience match, authenticity (penalize engagement-pod / bot patterns).",
      `5) Set flags from this list when applicable: below_engagement_floor (engagementRate < ${brief.targeting.minEngagementRate}), blacklisted, wrong_language (creator language ∉ ${brief.targeting.languages.join(",")}), brand_unsafe (bio/captions show competing brands, unsafe content, political extremes), prior_flake (priorOutcome="flaked"), data_stale (profile data > 30 days old).`,
      "",
      "Return the candidate exactly as given, with fitScore and flags filled and vettedAt set to the current ISO timestamp. Be conservative — a false \"great fit\" wastes a sample.",
    ].join("\n"),
});
