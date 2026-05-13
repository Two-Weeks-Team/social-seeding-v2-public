import { z } from "zod";
import { CandidateSchema, CampaignBriefSchema } from "@ss/contracts";
import { defineAgent } from "./runtime.js";

/**
 * Vetting agent. For each candidate: pull profile + recent posts, compute
 * engagement / avg views (port of v1 `calculate-average-views.ts` + ranking
 * algos via the `ranking.score` capability), check brand-safety on bios/posts,
 * confirm language, surface prior-collab outcome. Outputs a fitScore [0,1] and
 * flags. Replaces the human eyeballing Step 2's table.
 *
 * Cheap, high-volume work → Haiku.
 */
export const vettingAgent = defineAgent({
  id: "vetting",
  description: "Score a candidate's brand-fit and surface risk flags using profile + recent-post data.",
  tools: ["tiktok.getCreator", "blacklist.check"],
  model: "claude-haiku-4-5",
  maxUsd: 0.1, // per candidate; the workflow fans out
  input: z.object({ brief: CampaignBriefSchema, candidate: CandidateSchema.omit({ fitScore: true, vettedAt: true }) }),
  output: CandidateSchema,
  systemPrompt: ({ brief, candidate }) => `You are the Vetting agent. Score creator @${candidate.creator.uniqueId} for the "${brief.brandProduct.name}" (${brief.brandProduct.category}) campaign.
Pull recent posts. Compute realistic engagement & avg views. Check the bio and recent captions for brand-safety conflicts (competing brands, unsafe content, political extremes). Confirm content language ∈ ${brief.targeting.languages.join(",")}.
fitScore (0–1): how well this creator fits THIS brand — content topic overlap, audience match, authenticity (not a bot/engagement-pod). Set flags: below_engagement_floor if engagement < ${brief.targeting.minEngagementRate}; blacklisted if blacklist.check says so; wrong_language; brand_unsafe; prior_flake if priorOutcome is "flaked"; data_stale if profile data is old. Be conservative — a false "great fit" wastes a sample and an outreach slot.`,
});
