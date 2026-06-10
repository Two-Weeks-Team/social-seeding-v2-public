import { TikTokCreatorSchema, type TikTokCreator } from "@ss/contracts";
import { getDb } from "../client";
import { Collections } from "../collections";

/**
 * Reads the SHARED `accounts_tiktok` collection (v1-owned). v2 only reads here;
 * fresh TikTok pulls go through the `tiktok.*` capabilities which update v1's
 * collection the same way v1's RapidAPI ingestion does.
 *
 * NOTE: text search (v1's Atlas Search pipeline — hashtags 10x / signature 5x /
 * nickname 2x / uniqueId 1x) is owned by the `tiktok.search` capability, not by
 * this repo (see docs/CAPABILITIES.md). This repo is lookup-by-key only.
 */
export const creatorRepo = {
  async getByUniqueId(uniqueId: string): Promise<TikTokCreator | null> {
    const db = await getDb();
    const doc = await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).findOne({ uniqueId });
    return doc ? TikTokCreatorSchema.parse(doc) : null;
  },

  /**
   * Lookup by TikTok's numeric/internal `id` (not `uniqueId`/handle). The
   * creator-track workflow stores `creatorId = TikTokCreator.id` on each
   * track; downstream callers (e.g. tiktok-post-poller) that need the
   * handle resolve it via this method against the shared accounts_tiktok
   * collection.
   */
  async getById(id: string): Promise<TikTokCreator | null> {
    const db = await getDb();
    const doc = await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).findOne({ id });
    return doc ? TikTokCreatorSchema.parse(doc) : null;
  },

  /**
   * Batch lookup by TikTok `id` for MC views that render a list of tracks and
   * need each creator's handle / nickname / avatar in one query (avoids N round
   * trips). Unparseable docs are skipped, not thrown.
   */
  async listByIds(ids: string[]): Promise<TikTokCreator[]> {
    if (ids.length === 0) return [];
    const db = await getDb();
    // A track's `creatorId` is TikTok's numeric `id` for agent-sourced creators,
    // but fixture/sim-seeded campaigns store the `uniqueId` (handle) instead.
    // Match either key so MC views resolve a face + name regardless of how the
    // campaign was created (resolveCreators then keys results by id AND uniqueId).
    const docs = await db
      .collection(Collections.SHARED_TIKTOK_ACCOUNTS)
      .find({ $or: [{ id: { $in: ids } }, { uniqueId: { $in: ids } }] })
      .toArray();
    const out: TikTokCreator[] = [];
    for (const doc of docs) {
      const parsed = TikTokCreatorSchema.safeParse(doc);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  },
};
