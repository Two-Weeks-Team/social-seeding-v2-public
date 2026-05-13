import { ObjectId, type WithId } from "mongodb";
import { ApprovalSchema, type Approval } from "@ss/contracts";
import { getDb } from "../client";
import { Collections } from "../collections";

/**
 * Approval repository (v2-owned `v2_approvals`). The workflow's gate() helper
 * creates these on always_ask / auto_unless-and-predicate-hit paths;
 * apps/web's `POST /api/approvals/[id]/resolve` (Chunk 4) calls `resolve()`
 * which then unblocks the workflow's step.waitForEvent.
 */

type ApprovalDoc = Omit<Approval, "id">;

async function approvalsCol() {
  return (await getDb()).collection<ApprovalDoc>(Collections.V2_APPROVALS);
}

function toApproval(doc: WithId<ApprovalDoc>): Approval {
  const { _id, ...rest } = doc;
  return ApprovalSchema.parse({ ...rest, id: String(_id) });
}

export const approvalRepo = {
  async create(input: Omit<Approval, "id" | "createdAt" | "status">): Promise<Approval> {
    const col = await approvalsCol();
    const now = new Date();
    const doc: ApprovalDoc = { ...input, status: "pending", createdAt: now };
    const res = await col.insertOne(doc);
    return { ...input, id: String(res.insertedId), status: "pending", createdAt: now };
  },

  async get(id: string): Promise<Approval | null> {
    const col = await approvalsCol();
    const doc = await col.findOne({ _id: new ObjectId(id) });
    return doc ? toApproval(doc) : null;
  },

  async resolve(
    id: string,
    decision: "approved" | "edited" | "rejected",
    resolvedBy: string,
    editedPayload?: unknown,
  ): Promise<void> {
    const col = await approvalsCol();
    const update: Record<string, unknown> = {
      status: decision,
      resolvedBy,
      resolvedAt: new Date(),
    };
    if (editedPayload !== undefined) update.recommendation = editedPayload;
    await col.updateOne({ _id: new ObjectId(id) }, { $set: update });
  },

  async listPendingByWorkspace(workspaceId: string): Promise<Approval[]> {
    const col = await approvalsCol();
    const docs = await col.find({ workspaceId, status: "pending" }).sort({ createdAt: -1 }).toArray();
    return docs.map(toApproval);
  },
};
