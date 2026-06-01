import { z } from "zod";

/**
 * TikTok creator. Mirrors v1 `accounts_tiktok` (so v2 can read the shared
 * Atlas collection directly) plus v2-only derived/relationship fields.
 */
export const TikTokCreatorSchema = z.object({
  // identity (v1 parity)
  id: z.string(), // TikTok unique numeric id
  uniqueId: z.string(), // @handle
  nickname: z.string(),
  signature: z.string().default(""),
  avatarThumb: z.string().url().optional(),
  avatarLarger: z.string().url().optional(),
  verified: z.boolean().default(false),
  privateAccount: z.boolean().default(false),
  // metrics (v1 parity)
  followerCount: z.number().int().nonnegative(),
  followingCount: z.number().int().nonnegative(),
  videoCount: z.number().int().nonnegative(),
  heartCount: z.number().int().nonnegative().optional(),
  hashtags: z.array(z.string()).default([]),
  // v2-derived. The shared v1 `accounts_tiktok` stores `language: null` (it tracks
  // `textLanguage` instead), and `.optional()` rejects an explicit null — which
  // silently failed EVERY creator's safeParse and made tiktok.search return zero.
  // Accept null and normalize it to undefined.
  language: z.preprocess((v) => (v === null ? undefined : v), z.string().length(2).optional()),
  avgViews: z.number().nonnegative().optional(),
  engagementRate: z.number().min(0).max(1).optional(),
  influenceScore: z.number().min(0).max(100).optional(),
  // v2 relationship memory (per workspace) — populated by the vetting agent
  priorOutcome: z
    .enum(["responded", "ignored", "declined", "flaked", "delivered", "overperformed"])
    .optional(),
});
export type TikTokCreator = z.infer<typeof TikTokCreatorSchema>;

/** A candidate the sourcing agent produced, before/after vetting. */
export const CandidateSchema = z.object({
  creator: TikTokCreatorSchema,
  matchReasons: z.array(z.string()), // why the sourcing agent picked this creator
  fitScore: z.number().min(0).max(1), // vetting agent's brand-fit score
  flags: z.array(z.enum(["below_engagement_floor", "blacklisted", "wrong_language", "brand_unsafe", "prior_flake", "data_stale"])).default([]),
  vettedAt: z.coerce.date().optional(),
});
export type Candidate = z.infer<typeof CandidateSchema>;
