import { z } from "zod";
import { TikTokCreatorSchema } from "@ss/contracts";
import { defineCapability } from "../registry";

/**
 * tiktok.search — port of v1's 3-phase Progressive search:
 *   Phase 0: MongoDB Atlas Search → up to 1000 immediate (weights:
 *            hashtags 10x / signature 5x / nickname 2x / uniqueId 1x)
 *   Phase 1: RapidAPI live data (background, key rotation pool)
 *   Phase 2: Mongo remainder (background)
 * For agent use, the capability returns Phase-0 synchronously and exposes a
 * continuation token; the Sourcing agent typically only needs Phase 0.
 * See v1 `src/app/api/search`, `docs/current/architecture/search-flow.md`.
 */
export const tiktokSearch = defineCapability({
  name: "tiktok.search",
  description:
    "Search TikTok creators by free text / hashtags / handle. AND (comma) and OR (space) supported. Returns ranked creators.",
  scope: "read",
  idempotent: true,
  rateLimitClass: "tiktok_read",
  input: z.object({
    query: z.string().min(1),
    mode: z.enum(["text", "hashtag", "and", "or"]).default("text"),
    minFollowers: z.number().int().optional(),
    maxFollowers: z.number().int().optional(),
    minEngagementRate: z.number().min(0).max(1).optional(),
    languages: z.array(z.string().length(2)).optional(),
    limit: z.number().int().min(1).max(1000).default(200),
  }),
  output: z.object({
    creators: z.array(TikTokCreatorSchema),
    total: z.number().int().nonnegative(),
    continuation: z.string().nullable(), // present if Phase 1/2 results pending
  }),
  async handler(_input, _ctx) {
    // TODO(phase-1, task S2): port the Atlas Search aggregation from v1.
    throw new Error("tiktok.search not implemented — see docs/PHASE-1-PLAN.md task S2");
  },
});
