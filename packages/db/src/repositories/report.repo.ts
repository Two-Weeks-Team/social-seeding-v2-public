import { ObjectId, type WithId } from "mongodb";
import { ReportSchema, type Report } from "@ss/contracts";
import { getDb } from "../client";
import { Collections } from "../collections";

/**
 * Report repository (v2-owned `v2_reports`). Phase 4 P4-C3 —
 * `report-deliver` workflow appends; MC `/campaigns/[id]/report` reads via
 * `latestForCampaign`; the share page (P4-C5) reads via `get`.
 *
 * Reports are append-only: a campaign can have many over its lifetime
 * (weekly cron + manual exports). We never mutate a delivered row; if the
 * narrative needs to change, generate a fresh one (the cost is the
 * analyst-agent call, which we want as an explicit audit-log event).
 */

type ReportDoc = Omit<Report, "id">;

async function reportsCol() {
  return (await getDb()).collection<ReportDoc>(Collections.V2_REPORTS);
}

function toReport(doc: WithId<ReportDoc>): Report {
  const { _id, ...rest } = doc;
  return ReportSchema.parse({ ...rest, id: String(_id) });
}

export const reportRepo = {
  async create(input: Omit<Report, "id">): Promise<Report> {
    const col = await reportsCol();
    const res = await col.insertOne({ ...input });
    return { ...input, id: String(res.insertedId) };
  },

  async get(id: string): Promise<Report | null> {
    const col = await reportsCol();
    let oid: ObjectId;
    try { oid = new ObjectId(id); } catch { return null; }
    const doc = await col.findOne({ _id: oid });
    return doc ? toReport(doc) : null;
  },

  /** Newest first — MC's "latest report" tile + the report timeline. */
  async listByCampaign(campaignId: string, limit = 20): Promise<Report[]> {
    const col = await reportsCol();
    const docs = await col.find({ campaignId }).sort({ generatedAt: -1 }).limit(limit).toArray();
    return docs.map(toReport);
  },

  /** Most recent delivery for a campaign, `null` if none yet. */
  async latestForCampaign(campaignId: string): Promise<Report | null> {
    const col = await reportsCol();
    const doc = await col.find({ campaignId }).sort({ generatedAt: -1 }).limit(1).next();
    return doc ? toReport(doc) : null;
  },
};
