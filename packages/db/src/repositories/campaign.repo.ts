import { ObjectId, type WithId } from "mongodb";
import { CampaignSchema, type Campaign, type CreatorTrack } from "@ss/contracts";
import { getDb } from "../client";
import { Collections } from "../collections";

/**
 * Campaign repository. v2-owned collection. The Inngest workflow is the only
 * writer of `status`/`stage`/`tracks` transitions; the web API only creates
 * drafts and reads.
 */

/** The Mongo document shape (Campaign minus the string `id`, which is `_id`). */
type CampaignDoc = Omit<Campaign, "id">;

async function campaigns() {
  return (await getDb()).collection<CampaignDoc>(Collections.V2_CAMPAIGNS);
}

function toCampaign(doc: WithId<CampaignDoc>): Campaign {
  const { _id, ...rest } = doc;
  return CampaignSchema.parse({ ...rest, id: String(_id) });
}

export const campaignRepo = {
  async create(input: Omit<Campaign, "id" | "createdAt" | "updatedAt">): Promise<Campaign> {
    const col = await campaigns();
    const now = new Date();
    const doc: CampaignDoc = { ...input, createdAt: now, updatedAt: now };
    const res = await col.insertOne(doc);
    return { ...input, id: String(res.insertedId), createdAt: now, updatedAt: now };
  },

  async get(id: string): Promise<Campaign | null> {
    const col = await campaigns();
    const doc = await col.findOne({ _id: new ObjectId(id) });
    return doc ? toCampaign(doc) : null;
  },

  async listByWorkspace(workspaceId: string): Promise<Campaign[]> {
    const col = await campaigns();
    const docs = await col.find({ "brief.workspaceId": workspaceId }).sort({ updatedAt: -1 }).toArray();
    return docs.map(toCampaign);
  },

  async patchStage(id: string, stage: Campaign["stage"], status?: Campaign["status"]): Promise<void> {
    const col = await campaigns();
    await col.updateOne(
      { _id: new ObjectId(id) },
      { $set: { stage, ...(status ? { status } : {}), updatedAt: new Date() } },
    );
  },

  async upsertTrack(id: string, track: CreatorTrack): Promise<void> {
    const col = await campaigns();
    // pull-then-push keeps `tracks` a set keyed by creatorId
    await col.updateOne({ _id: new ObjectId(id) }, { $pull: { tracks: { creatorId: track.creatorId } } });
    await col.updateOne({ _id: new ObjectId(id) }, { $push: { tracks: track }, $set: { updatedAt: new Date() } });
  },
};
