import { ObjectId } from "mongodb";
import { WorkspacePolicySchema, type WorkspacePolicy } from "@ss/contracts";
import { getDb } from "../client";
import { Collections } from "../collections";

/** v1's billing plans (lib/feature-flags.ts). */
export type PlanName = "FREE" | "BEAUTY_VERIFIED" | "STARTER" | "PRO" | "BUSINESS";

/** A conservative default: every gate asks the human. Owners relax over time. */
export function defaultPolicy(workspaceId: string): WorkspacePolicy {
  const askGate = { mode: "always_ask" as const };
  return WorkspacePolicySchema.parse({
    workspaceId,
    level: "checkpointed",
    gates: {
      approveShortlist: askGate,
      approveOutreachSend: askGate,
      approveReplyResponse: askGate,
      approveShipment: askGate,
      approveStageAdvance: askGate,
    },
    budgets: { maxUsdPerCampaign: 25, maxUsdPerWorkspaceMonthly: 200 },
    voice: { toneNotes: "", signatureBlock: "", bannedPhrases: [] },
    updatedAt: new Date(),
  });
}

export const workspaceRepo = {
  async getPolicy(workspaceId: string): Promise<WorkspacePolicy> {
    const db = await getDb();
    const doc = await db.collection(Collections.V2_WORKSPACE_POLICIES).findOne({ workspaceId });
    return doc ? WorkspacePolicySchema.parse(doc) : defaultPolicy(workspaceId);
  },

  async savePolicy(policy: WorkspacePolicy): Promise<void> {
    const db = await getDb();
    await db
      .collection(Collections.V2_WORKSPACE_POLICIES)
      .updateOne({ workspaceId: policy.workspaceId }, { $set: { ...policy, updatedAt: new Date() } }, { upsert: true });
  },

  /** Reads v1's shared `workspaces` collection for plan/membership (carried over). */
  async getV1Workspace(workspaceId: string): Promise<Record<string, unknown> | null> {
    const db = await getDb();
    return db.collection(Collections.SHARED_WORKSPACES).findOne({ _id: new ObjectId(workspaceId) });
  },

  /**
   * Phase 6 P6-C2 — read the `v2Enabled` flag on the shared workspaces
   * doc. When true, v1's frontend should redirect users into v2 (v1
   * checks this same field). Returns `false` for missing rows /
   * unset fields — opt-in posture.
   */
  async isV2Enabled(workspaceId: string): Promise<boolean> {
    const db = await getDb();
    let oid: ObjectId;
    try { oid = new ObjectId(workspaceId); } catch { return false; }
    const doc = await db
      .collection<{ v2Enabled?: boolean }>(Collections.SHARED_WORKSPACES)
      .findOne({ _id: oid }, { projection: { v2Enabled: 1 } });
    return doc?.v2Enabled === true;
  },

  /**
   * Phase 6 P6-C2 — flip the `v2Enabled` flag on the shared workspaces
   * doc. ADDITIVE WRITE — `v2Enabled` is a new field v2 owns; v1 reads
   * it but never writes it. FREEZE.md §3 carve-out (additive fields
   * permitted).
   *
   * On enable: also sets `v2EnabledAt` (audit). On disable: sets
   * `v2DisabledAt`. We don't `$unset` either history field — keeping
   * the rollback trail visible.
   *
   * Caller must verify the operator owns / admins this workspace
   * BEFORE calling — the repo doesn't enforce ACL (that's MC's job).
   */
  async setV2Enabled(workspaceId: string, enabled: boolean): Promise<boolean> {
    const db = await getDb();
    let oid: ObjectId;
    try { oid = new ObjectId(workspaceId); } catch { return false; }
    const now = new Date();
    const res = await db
      .collection(Collections.SHARED_WORKSPACES)
      .updateOne(
        { _id: oid },
        {
          $set: {
            v2Enabled: enabled,
            ...(enabled ? { v2EnabledAt: now } : { v2DisabledAt: now }),
          },
        },
      );
    return res.matchedCount === 1;
  },

  /**
   * Resolve a workspace's billing plan. TODO(phase-0/1): port v1's real
   * resolution (subscriptions / workspace_subscriptions / beauty_verified) +
   * the 10-min plan cache — see docs/CAPABILITIES.md Domain H. Until then every
   * workspace is treated as FREE (rate limits are still enforced, at the FREE tier).
   */
  async getPlan(_workspaceId: string): Promise<PlanName> {
    return "FREE";
  },
};
