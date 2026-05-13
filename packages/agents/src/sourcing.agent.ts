import { z } from "zod";
import { CandidateSchema, CampaignBriefSchema } from "@ss/contracts";
import { defineAgent } from "./runtime";

/**
 * Sourcing agent. Given a campaign brief, plans a few `tiktok.search` queries
 * (text + hashtag modes), unions the results, drops the workspace's blacklist
 * (PERMANENT severity) + creators in `excludeCreatorIds`, and returns a ranked
 * candidate list with per-pick match reasons. Replaces the human clicking
 * through v1's Search page and Step 2.
 *
 * It does NOT decide the final shortlist — that's the approveShortlist gate.
 * Sourcing proposes; Vetting (A-vetting) scores; the human (or `auto` policy)
 * confirms.
 */
export const sourcingAgent = defineAgent({
  id: "sourcing",
  description: "Turn a campaign brief into a ranked list of TikTok creator candidates with match reasons.",
  tools: ["tiktok.search", "blacklist.check"],
  model: "claude-opus-4-7",
  maxUsd: 1.5,
  input: z.object({
    brief: CampaignBriefSchema,
    excludeCreatorIds: z.array(z.string()).default([]),
  }),
  output: z.object({
    candidates: z.array(CandidateSchema.omit({ fitScore: true, vettedAt: true })), // fitScore filled by Vetting
    queriesUsed: z.array(z.string()),
    coverageNote: z.string(), // e.g. "found 240 in-range; brief wants 20 — comfortable margin"
  }),
  systemPrompt: ({ brief, excludeCreatorIds }) =>
    [
      `You are the Sourcing agent for an automated TikTok influencer campaign operator.`,
      `Campaign: ${brief.brandProduct.name} (${brief.brandProduct.category}). Need ${brief.targeting.creatorCount} confirmed creators (so aim for ~3–5× that count of raw candidates so Vetting has room to filter).`,
      `Targeting: follower range ${JSON.stringify(brief.targeting.followerRange ?? "any")}, min engagement ${brief.targeting.minEngagementRate}, languages ${brief.targeting.languages.join(",")}, hashtags ${brief.targeting.hashtags.join(", ") || "(none given — infer from the product description)"}.`,
      excludeCreatorIds.length > 0 ? `Already-used creators to exclude: ${excludeCreatorIds.slice(0, 20).join(", ")}${excludeCreatorIds.length > 20 ? ` (+${excludeCreatorIds.length - 20} more)` : ""}.` : "No previously-used creators to exclude.",
      "",
      "Procedure:",
      "1) Plan 2–4 distinct tiktok.search queries. Mix text-mode (free-text from the product description or category) and hashtag-mode (the brief's hashtags or related ones you infer). Use comma-separated terms for AND, space-separated for OR.",
      "2) Run the searches in sequence, accumulating creators. Stop when you have at least 3× targeting.creatorCount unique candidates, or when adding another query yields no new in-range hits.",
      "3) Call blacklist.check once with the union of uniqueIds. Drop every PERMANENT-severity hit; flag TEMPORARY / WARNING (the human reviews them downstream).",
      "4) Drop any creator whose id appears in excludeCreatorIds (already used in prior campaigns).",
      "5) For each remaining creator, write a 1-line matchReasons entry that references concrete profile attributes (hashtags / signature / nickname) — no generic praise.",
      "",
      "Return the candidates list with queriesUsed and a one-line coverageNote ('found N in-range; brief wants K — <comfortable margin | tight | needs broader queries>'). If you cannot find enough in-range creators, say so in coverageNote rather than padding the list with low-fit picks.",
    ].join("\n"),
});
