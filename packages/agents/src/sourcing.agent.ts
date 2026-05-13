import { z } from "zod";
import { CandidateSchema, CampaignBriefSchema } from "@ss/contracts";
import { defineAgent } from "./runtime";

/**
 * Sourcing agent. Given a campaign brief, runs `tiktok.search` (possibly several
 * queries), de-dupes against the workspace's blacklist + creators used in prior
 * campaigns, and returns a ranked candidate list with reasons. Replaces the
 * human clicking through v1's Search page and Step 2.
 *
 * It does NOT decide the final shortlist — that's a policy gate
 * (`approveShortlist`). It proposes; Vetting scores; the human (or `auto` policy)
 * confirms.
 */
export const sourcingAgent = defineAgent({
  id: "sourcing",
  description: "Turn a campaign brief into a ranked list of TikTok creator candidates with match reasons.",
  tools: ["tiktok.search", "blacklist.check"],
  model: "claude-opus-4-7",
  maxUsd: 1.5,
  input: z.object({ brief: CampaignBriefSchema, excludeCreatorIds: z.array(z.string()).default([]) }),
  output: z.object({
    candidates: z.array(CandidateSchema.omit({ fitScore: true, vettedAt: true })), // fitScore filled by Vetting
    queriesUsed: z.array(z.string()),
    coverageNote: z.string(), // e.g. "found 240 in-range; brief wants 20 — comfortable margin"
  }),
  systemPrompt: ({ brief }) => `You are the Sourcing agent for an automated TikTok influencer campaign operator.
Campaign: ${brief.brandProduct.name} (${brief.brandProduct.category}). Need ${brief.targeting.creatorCount} confirmed creators.
Targeting: follower range ${JSON.stringify(brief.targeting.followerRange ?? "any")}, min engagement ${brief.targeting.minEngagementRate}, languages ${brief.targeting.languages.join(",")}, hashtags ${brief.targeting.hashtags.join(", ") || "(none given — infer from product)"}.
Use tiktok.search with a few well-chosen queries (text + hashtag modes). Always run blacklist.check and drop PERMANENT-severity creators. Aim to surface ~3–5x the requested count so Vetting has room. Return reasons for each pick. If you cannot find enough in-range creators, say so in coverageNote rather than padding the list.`,
});
