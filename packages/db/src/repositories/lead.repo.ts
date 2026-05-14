import { ObjectId, type WithId } from "mongodb";
import { LeadSchema, LeadCampaignSchema, type Lead, type LeadCampaign } from "@ss/contracts";
import { getDb } from "../client";
import { Collections } from "../collections";

/**
 * Lead repositories — Phase 5 P5-C1. Two v2-owned collections:
 *
 *   · v2_leads          — one row per lead. Authoritative for v2's
 *                          enrichment + research + stage. Reads merge
 *                          with v1's shared `crm_accounts` via
 *                          `sharedAccountId` (additive only — we never
 *                          write back to the shared collection).
 *   · v2_lead_campaigns — one row per lead-campaign brief. Parallel to
 *                          v2_campaigns but with the lead-flavored
 *                          schema (LeadCampaignBriefSchema).
 *
 * The lead-campaign workflow (P5-C3) writes lead.stage transitions; the
 * MC `/leads` view reads via `listByWorkspace` + `listByCampaign`.
 */

// ─── v2_leads ────────────────────────────────────────────────────────────

type LeadDoc = Omit<Lead, "id">;
async function leadsCol() {
  return (await getDb()).collection<LeadDoc>(Collections.V2_LEADS);
}
function toLead(doc: WithId<LeadDoc>): Lead {
  const { _id, ...rest } = doc;
  return LeadSchema.parse({ ...rest, id: String(_id) });
}

export const leadRepo = {
  async create(input: Omit<Lead, "id" | "createdAt" | "updatedAt">): Promise<Lead> {
    const col = await leadsCol();
    const now = new Date();
    const doc: LeadDoc = { ...input, createdAt: now, updatedAt: now };
    const res = await col.insertOne(doc);
    return { ...input, id: String(res.insertedId), createdAt: now, updatedAt: now };
  },

  async get(id: string): Promise<Lead | null> {
    const col = await leadsCol();
    let oid: ObjectId;
    try { oid = new ObjectId(id); } catch { return null; }
    const doc = await col.findOne({ _id: oid });
    return doc ? toLead(doc) : null;
  },

  /**
   * Find by the v1 shared-account id (sharedAccountId field) — when the
   * lead-campaign import path resolves leads from the shared collection,
   * this lets it skip ones we already own.
   */
  async findBySharedAccountId(workspaceId: string, sharedAccountId: string): Promise<Lead | null> {
    const col = await leadsCol();
    const doc = await col.findOne({ workspaceId, sharedAccountId });
    return doc ? toLead(doc) : null;
  },

  async listByWorkspace(workspaceId: string, limit = 100): Promise<Lead[]> {
    const col = await leadsCol();
    const docs = await col.find({ workspaceId }).sort({ updatedAt: -1 }).limit(limit).toArray();
    return docs.map(toLead);
  },

  async patchEnrichment(id: string, enrichment: Lead["enrichment"]): Promise<void> {
    const col = await leadsCol();
    await col.updateOne(
      { _id: new ObjectId(id) },
      { $set: { enrichment, stage: "enriched", updatedAt: new Date() } },
    );
  },

  async patchResearch(id: string, research: Lead["research"]): Promise<void> {
    const col = await leadsCol();
    await col.updateOne(
      { _id: new ObjectId(id) },
      { $set: { research, stage: "researched", updatedAt: new Date() } },
    );
  },

  async patchStage(id: string, stage: Lead["stage"], extra: Partial<Lead> = {}): Promise<void> {
    const col = await leadsCol();
    await col.updateOne(
      { _id: new ObjectId(id) },
      { $set: { stage, ...extra, lastActivityAt: new Date(), updatedAt: new Date() } },
    );
  },
};

// ─── v2_lead_campaigns ───────────────────────────────────────────────────

type LeadCampaignDoc = Omit<LeadCampaign, "id">;
async function leadCampaignsCol() {
  return (await getDb()).collection<LeadCampaignDoc>(Collections.V2_LEAD_CAMPAIGNS);
}
function toLeadCampaign(doc: WithId<LeadCampaignDoc>): LeadCampaign {
  const { _id, ...rest } = doc;
  return LeadCampaignSchema.parse({ ...rest, id: String(_id) });
}

export const leadCampaignRepo = {
  async create(input: Omit<LeadCampaign, "id" | "createdAt" | "updatedAt">): Promise<LeadCampaign> {
    const col = await leadCampaignsCol();
    const now = new Date();
    const doc: LeadCampaignDoc = { ...input, createdAt: now, updatedAt: now };
    const res = await col.insertOne(doc);
    return { ...input, id: String(res.insertedId), createdAt: now, updatedAt: now };
  },

  async get(id: string): Promise<LeadCampaign | null> {
    const col = await leadCampaignsCol();
    let oid: ObjectId;
    try { oid = new ObjectId(id); } catch { return null; }
    const doc = await col.findOne({ _id: oid });
    return doc ? toLeadCampaign(doc) : null;
  },

  async listByWorkspace(workspaceId: string): Promise<LeadCampaign[]> {
    const col = await leadCampaignsCol();
    const docs = await col.find({ "brief.workspaceId": workspaceId }).sort({ updatedAt: -1 }).toArray();
    return docs.map(toLeadCampaign);
  },

  async patchStage(id: string, stage: LeadCampaign["stage"], status?: LeadCampaign["status"]): Promise<void> {
    const col = await leadCampaignsCol();
    await col.updateOne(
      { _id: new ObjectId(id) },
      { $set: { stage, ...(status ? { status } : {}), updatedAt: new Date() } },
    );
  },

  async pushLeadIds(id: string, leadIds: string[]): Promise<void> {
    const col = await leadCampaignsCol();
    await col.updateOne(
      { _id: new ObjectId(id) },
      { $addToSet: { leadIds: { $each: leadIds } }, $set: { updatedAt: new Date() } },
    );
  },
};
