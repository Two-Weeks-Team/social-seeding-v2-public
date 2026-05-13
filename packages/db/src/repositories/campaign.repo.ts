import { ObjectId } from "mongodb";
import { CampaignSchema, type Campaign, type CreatorTrack } from "@ss/contracts";
import { getDb } from "../client.js";
import { Collections } from "../collections.js";

/**
 * Campaign repository. v2-owned collection. The Inngest workflow is the only
 * writer of `status`/`stage`/`tracks` transitions; the web API only creates
 * drafts and reads.
 */
function toCampaign(doc: Record<string, unknown>): Campaign {
  return CampaignSchema.parse({ ...doc, id: String((doc as { _id: ObjectId })._id) });
}

export const campaignRepo = {
  async create(input: Omit<Campaign, "id" | "createdAt" | "updatedAt">): Promise<Campaign> {
    const db = await getDb();
    const now = new Date();
    const res = await db
      .collection(Collections.V2_CAMPAIGNS)
      .insertOne({ ...input, createdAt: now, updatedAt: now });
    return { ...input, id: String(res.insertedId), createdAt: now, updatedAt: now };
  },

  async get(id: string): Promise<Campaign | null> {
    const db = await getDb();
    const doc = await db.collection(Collections.V2_CAMPAIGNS).findOne({ _id: new ObjectId(id) });
    return doc ? toCampaign(doc) : null;
  },

  async listByWorkspace(workspaceId: string): Promise<Campaign[]> {
    const db = await getDb();
    const docs = await db
      .collection(Collections.V2_CAMPAIGNS)
      .find({ "brief.workspaceId": workspaceId })
      .sort({ updatedAt: -1 })
      .toArray();
    return docs.map(toCampaign);
  },

  async patchStage(id: string, stage: Campaign["stage"], status?: Campaign["status"]): Promise<void> {
    const db = await getDb();
    await db
      .collection(Collections.V2_CAMPAIGNS)
      .updateOne({ _id: new ObjectId(id) }, { $set: { stage, ...(status ? { status } : {}), updatedAt: new Date() } });
  },

  async upsertTrack(id: string, track: CreatorTrack): Promise<void> {
    const db = await getDb();
    // pull-then-push keeps the array a set keyed by creatorId
    await db
      .collection(Collections.V2_CAMPAIGNS)
      .updateOne({ _id: new ObjectId(id) }, { $pull: { tracks: { creatorId: track.creatorId } } });
    await db
      .collection(Collections.V2_CAMPAIGNS)
      .updateOne({ _id: new ObjectId(id) }, { $push: { tracks: track }, $set: { updatedAt: new Date() } });
  },
};
