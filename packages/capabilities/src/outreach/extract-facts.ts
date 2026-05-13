import { z } from "zod";
import { CampaignBriefSchema, OutreachFactsSchema, TikTokCreatorSchema } from "@ss/contracts";
import { defineCapability } from "../registry";

/**
 * outreach.extractFacts — port of v1
 * `~/social-seeding/src/lib/cold-mail/extract-facts.ts`, adapted to TikTok
 * creators (not CRM accounts). Pure: no LLM, no I/O — agents call this so the
 * downstream prompt becomes "positive-only" (cite from this fact set, never
 * invent), and the judge heuristics + a future LLM-as-fact-verifier can
 * audit each claim against a closed set.
 *
 * What gets extracted:
 *  - the creator's handle / nickname / signature (untouched, but
 *    optionally sanitized — that's the agent runtime's job via prompt-guard);
 *  - up to 5 of their most-used hashtags (union of profile + recent posts,
 *    deduped, ordered by frequency);
 *  - up to 3 short "recent post themes" pulled by simple tokenization from
 *    each post's `desc` (caps + length + dedupe). Deliberately heuristic —
 *    if the downstream agent wants something richer, it can ground a
 *    sentence in the raw posts via the model client itself;
 *  - the brand pitch verbatim from the brief (name, category, description,
 *    keyClaims);
 *  - logistics.shipsSamples (governs the angle).
 *
 * `hasMinimumContext = false` ⇔ the creator has neither a signature NOR any
 * recent post themes — i.e. nothing concrete the drafter could cite. v1
 * threw `InsufficientContextError`; v2 surfaces the flag and lets the
 * agent's escalation path decide (closer to the v2 "no exceptions across
 * agent boundaries" design).
 */

const MAX_HASHTAGS = 5;
const MAX_THEMES = 3;
const MAX_THEME_LEN = 60;

function dedupeKeepOrder<T>(items: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of items) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function extractThemes(descriptions: string[]): string[] {
  const themes: string[] = [];
  for (const raw of descriptions) {
    if (!raw) continue;
    // first clause (split on . / ! / ? / line breaks), trimmed, no hashtags
    const first = raw
      .split(/[.!?\n]/)[0]
      ?.replace(/#[\p{L}\p{N}_]+/gu, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!first) continue;
    if (first.length > MAX_THEME_LEN) {
      themes.push(`${first.slice(0, MAX_THEME_LEN - 1)}…`);
    } else {
      themes.push(first);
    }
  }
  return dedupeKeepOrder(themes).slice(0, MAX_THEMES);
}

const RecentPostInputSchema = z.object({
  desc: z.string().default(""),
  hashtags: z.array(z.string()).default([]),
});

export const outreachExtractFacts = defineCapability({
  name: "outreach.extractFacts",
  description:
    "Build the closed fact set the Outreach Writer is allowed to cite (creator hashtags, recent-post themes, brand pitch from the brief). Pure — no LLM, no I/O. Sets hasMinimumContext=false when there's nothing concrete to anchor a personalized draft.",
  scope: "read",
  idempotent: true,
  rateLimitClass: "default",
  input: z.object({
    brief: CampaignBriefSchema,
    creator: TikTokCreatorSchema,
    recentPosts: z.array(RecentPostInputSchema).default([]),
    /** Optional R1 outputs — agents pass these through so the judges can read them. */
    avgViews: z.number().int().nonnegative().optional(),
    engagementRate: z.number().min(0).max(1).optional(),
  }),
  output: OutreachFactsSchema,
  async handler({ brief, creator, recentPosts = [], avgViews, engagementRate }, _ctx) {
    const profileTags = (creator.hashtags ?? []).filter((t): t is string => typeof t === "string" && t.length > 0);
    const postTags = recentPosts.flatMap((p) => p.hashtags);
    const topHashtags = dedupeKeepOrder([...profileTags, ...postTags])
      .map((t) => t.replace(/^#/, ""))
      .slice(0, MAX_HASHTAGS);

    const recentPostThemes = extractThemes(recentPosts.map((p) => p.desc));

    const signature = creator.signature?.trim() ?? "";
    const hasMinimumContext = signature.length > 0 || recentPostThemes.length > 0;

    return {
      creator: {
        uniqueId: creator.uniqueId,
        nickname: creator.nickname,
        signature,
        topHashtags,
        recentPostThemes,
        followerCount: creator.followerCount,
        ...(avgViews !== undefined ? { avgViews } : {}),
        ...(engagementRate !== undefined ? { engagementRate } : {}),
      },
      brand: {
        name: brief.brandProduct.name,
        category: brief.brandProduct.category,
        description: brief.brandProduct.description,
        keyClaims: brief.brandProduct.keyClaims,
      },
      logistics: { shipsSamples: brief.logistics.shipsSamples },
      hasMinimumContext,
    };
  },
});
