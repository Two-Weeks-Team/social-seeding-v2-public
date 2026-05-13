import { TikTokCreatorSchema, type TikTokCreator } from "@ss/contracts";
import { getDb } from "../client";
import { Collections } from "../collections";

/**
 * Reads the SHARED `accounts_tiktok` collection (v1-owned). v2 only reads here;
 * fresh TikTok pulls go through the `tiktok.*` capabilities which update v1's
 * collection the same way v1's RapidAPI ingestion does.
 *
 * NOTE: the real text-search query mirrors v1's Atlas Search pipeline
 * (hashtags 10x / signature 5x / nickname 2x / uniqueId 1x). Stubbed below —
 * see docs/CAPABILITIES.md `tiktok.search` and v1 `src/app/api/search`.
 */
export const creatorRepo = {
  async getByUniqueId(uniqueId: string): Promise<TikTokCreator | null> {
    const db = await getDb();
    const doc = await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).findOne({ uniqueId });
    return doc ? TikTokCreatorSchema.parse(doc) : null;
  },

  async search(_query: string, _opts?: { limit?: number }): Promise<TikTokCreator[]> {
    // TODO(phase-1): port v1 Atlas Search aggregation with weighted fields.
    throw new Error("creatorRepo.search not implemented — see docs/PHASE-1-PLAN.md task S2");
  },
};
