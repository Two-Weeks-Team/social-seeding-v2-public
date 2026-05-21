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
  model: "gemini-3.5-flash",
  // Cap raised from 1.5 → 2.5: live-demo 2026-05-14 observed Gemini 3.5 Flash
  // hitting the cap during the search loop (2-4 queries + blacklist
  // check + revise) on briefs with multiple hashtags. Same reasoning
  // as outreach-writer's cap raise — Flash-Lite-pricing intuition was off.
  maxUsd: 2.5,
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
      "Procedure (FOLLOW IN ORDER — do NOT escalate after step 1):",
      "1) Plan 2–4 distinct tiktok.search queries. Mix text-mode (free-text from the product description or category) and hashtag-mode (the brief's hashtags or related ones you infer). Use comma-separated terms for AND, space-separated for OR.",
      "2) RUN EACH PLANNED QUERY SEQUENTIALLY via tiktok.search — do not stop after a single query just because it returned a small count. The pool size in our index is finite; small per-query results are NORMAL, you must combine queries. Accumulate creators by uniqueId. Stop ONLY when you've run all planned queries, or you've found 3× targeting.creatorCount unique candidates, whichever comes first.",
      "3) Call blacklist.check once with the union of uniqueIds. Drop every PERMANENT-severity hit; flag TEMPORARY / WARNING (the human reviews them downstream).",
      "4) Drop any creator whose id appears in excludeCreatorIds (already used in prior campaigns).",
      "5) For each remaining creator, write a 1-line matchReasons entry that references concrete profile attributes (hashtags / signature / nickname) — no generic praise.",
      "",
      "Honesty contract: if the FINAL accumulated total (after all queries + blacklist + excludeCreatorIds) is LESS than targeting.creatorCount, RETURN WHAT YOU FOUND — set coverageNote to 'tight, only N matched' or 'needs broader queries' and let the human/vetting decide. Escalating with {escalate} is ONLY for genuine failures: zero results after every search, every result blacklisted, or the tool calls themselves erroring. A short honest list ALWAYS beats escalating.",
      "",
      "## Output format (CRITICAL)",
      "",
      "After your tool calls complete, respond with ONE JSON object matching the output schema. No prose, no markdown fences, no further tool calls. The runtime will parse strictly:",
      "",
      "```",
      "{",
      "  \"candidates\": [",
      "    { \"creator\": <TikTokCreator>, \"matchReasons\": [\"...\"], \"flags\": [\"below_engagement_floor\" | \"blacklisted\" | ...] },",
      "    ...",
      "  ],",
      "  \"queriesUsed\": [\"<query string 1>\", \"<query string 2>\"],",
      "  \"coverageNote\": \"found N in-range; brief wants K — <comfortable margin | tight | needs broader queries>\"",
      "}",
      "```",
      "",
      "Reviser-pass note: if (and ONLY if) the runtime sends a user message starting with 'Your response did not satisfy the required output contract', do NOT call another tool on that turn — produce the corrected JSON directly from data you already gathered. This clause applies to the JSON-validation revise loop, NOT to your initial tool sequence. During the normal procedure (steps 1-5 above), you should freely chain multiple tiktok.search + blacklist.check calls.",
      "",
      "Don't pad the list with low-fit picks; an honest small list is better than synthetic candidates.",
    ].join("\n"),
});
