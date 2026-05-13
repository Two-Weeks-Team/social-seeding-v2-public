import { z } from "zod";
import { TikTokCreatorSchema } from "@ss/contracts";
import { defineCapability } from "../registry";

/**
 * tiktok.getCreator — fetch one creator + recent posts. Reads `accounts_tiktok`
 * first; if stale (>24h, v1 caching policy) refreshes via RapidAPI. Used by the
 * Vetting agent to compute engagement / avg views / brand-safety.
 */
export const tiktokGetCreator = defineCapability({
  name: "tiktok.getCreator",
  description: "Get a TikTok creator profile and recent posts; auto-refreshes if cached data is stale.",
  scope: "read",
  idempotent: true,
  rateLimitClass: "tiktok_read",
  input: z.object({ uniqueId: z.string(), withRecentPosts: z.boolean().default(true), forceRefresh: z.boolean().default(false) }),
  output: z.object({
    creator: TikTokCreatorSchema,
    recentPosts: z
      .array(
        z.object({
          id: z.string(),
          desc: z.string(),
          hashtags: z.array(z.string()),
          views: z.number().int().nonnegative(),
          likes: z.number().int().nonnegative(),
          comments: z.number().int().nonnegative(),
          shares: z.number().int().nonnegative(),
          createdAt: z.coerce.date(),
        }),
      )
      .default([]),
  }),
  async handler(_input, _ctx) {
    // TODO(phase-1, task V1): port v1 `src/app/api/tiktok/*` + `lib/tiktok-mappers.ts`.
    throw new Error("tiktok.getCreator not implemented — see docs/PHASE-1-PLAN.md task V1");
  },
});
