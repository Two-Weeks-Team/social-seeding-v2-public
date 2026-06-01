import { ObjectId } from "mongodb";
import { WorkspacePolicySchema, type WorkspacePolicy } from "@ss/contracts";
import { getDb } from "../client";
import { Collections } from "../collections";

/** v1's billing plans (lib/feature-flags.ts). */
export type PlanName = "FREE" | "BEAUTY_VERIFIED" | "STARTER" | "PRO" | "BUSINESS";

/**
 * Default autonomy posture (operator instruction 2026-06-01, B1 "over-HITL"
 * fix). The agent fleet runs the loop; the human is in the loop at exactly
 * **three** gates — the irreversible / money / brand-risk ones:
 *
 *   · approveShipment   — always_ask (physical sample goes out)
 *   · approveContent    — always_ask (final sign-off on a live post)
 *   · approveBudget     — always_ask (spend release / contract)
 *
 * Everything else runs autonomously, escalating to the human ONLY when a
 * risk predicate matches (`auto_unless`):
 *
 *   · approveShortlist  — auto unless a candidate is low-fit (fitScore < 0.4)
 *   · approveOutreachSend — auto unless the draft scores spammy (spamScore ≥ 5)
 *   · approveReplyResponse — auto unless the reply is negative/exiting/sensitive
 *   · approveStageAdvance — auto (pure state transition, no external effect)
 *
 * Each required gate carries a non-blocking `timeout`: after 24 weekday-hours
 * with no human decision it falls back deterministically rather than parking
 * the loop forever — shipment/budget `abandon` (safe: no spend, no send),
 * content `auto_proceed` (trust the verify agent's score; stalling a live post
 * costs more than the residual judgment risk). See GateTimeoutSchema.
 *
 * Owners can still tighten any gate back to always_ask (or relax the required
 * ones) per workspace via savePolicy.
 */
export function defaultPolicy(workspaceId: string): WorkspacePolicy {
  const autoStage = { mode: "auto" as const };
  return WorkspacePolicySchema.parse({
    workspaceId,
    level: "autonomous",
    gates: {
      approveShortlist: { mode: "auto_unless", escalateIf: { fitScoreLt: 0.4 } },
      approveOutreachSend: { mode: "auto_unless", escalateIf: { spamScoreGte: 5 } },
      approveReplyResponse: {
        mode: "auto_unless",
        escalateIf: { replyClassIn: ["negotiating", "negative", "unsubscribe", "sensitive"] },
      },
      approveStageAdvance: autoStage,
      approveShipment: { mode: "always_ask", timeout: { businessHours: 24, onTimeout: "abandon" } },
      approveContent: { mode: "always_ask", timeout: { businessHours: 24, onTimeout: "auto_proceed" } },
      approveBudget: { mode: "always_ask", timeout: { businessHours: 24, onTimeout: "abandon" } },
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

  /**
   * Phase 6 P6-C1 — insert-only upsert. Used by the v1 → v2 workspace
   * importer to satisfy the additive-only / no-overwrite guarantee
   * (codex review P6 P2#3): a `savePolicy` between the importer's
   * existing-rows snapshot and its write would otherwise be stomped
   * by `$set`. `$setOnInsert` only applies on insert — if a row is
   * created concurrently (operator saving /policies, or another
   * importer run), this is a no-op.
   *
   * Returns true when an insert actually happened; false when a row
   * already existed (and was therefore preserved).
   */
  async createPolicyIfMissing(policy: WorkspacePolicy): Promise<boolean> {
    const db = await getDb();
    const res = await db
      .collection(Collections.V2_WORKSPACE_POLICIES)
      .updateOne(
        { workspaceId: policy.workspaceId },
        { $setOnInsert: { ...policy, updatedAt: new Date() } },
        { upsert: true },
      );
    return res.upsertedCount === 1;
  },

  /** Reads v1's shared `workspaces` collection for plan/membership (carried over). */
  async getV1Workspace(workspaceId: string): Promise<Record<string, unknown> | null> {
    const db = await getDb();
    return db.collection(Collections.SHARED_WORKSPACES).findOne({ _id: new ObjectId(workspaceId) });
  },

  /**
   * Phase 6 P6-C2 (codex review P1#1) — is `userId` an owner or admin
   * of `workspaceId`?
   *
   *   · `owner`  : `workspaces.ownerId === userId`. Direct read on the
   *                shared collection (FREEZE.md §3 read freely).
   *   · `admin`  : `workspace_members` row exists with `role === "admin"`
   *                for (workspaceId, userId).
   *
   * Anything else returns false. Used by the policies-page server
   * action that flips the v2 rollout flag (P1: a non-owner member
   * shouldn't be able to redirect or roll back the whole workspace).
   * Membership lookup is one Mongo query; the workspace owner read is
   * cached by Mongo's WiredTiger cache for typical traffic.
   */
  async isOwnerOrAdmin(workspaceId: string, userId: string): Promise<boolean> {
    const db = await getDb();
    let oid: ObjectId;
    try { oid = new ObjectId(workspaceId); } catch { return false; }
    const ws = await db
      .collection<{ ownerId?: string }>(Collections.SHARED_WORKSPACES)
      .findOne({ _id: oid }, { projection: { ownerId: 1 } });
    if (!ws) return false;
    if (ws.ownerId === userId) return true;
    const member = await db
      .collection<{ role?: string }>(Collections.SHARED_WORKSPACE_MEMBERS)
      .findOne(
        { workspaceId, userId },
        { projection: { role: 1 } },
      );
    return member?.role === "admin";
  },

  /**
   * Phase 6 P6-C2 — read the `v2Enabled` flag on the shared workspaces
   * doc. When true, v1's frontend should redirect users into v2 (v1
   * checks this same field). Returns `false` for missing rows /
   * unset fields — opt-in posture.
   *
   * NAMING CONTRACT (v1 ↔ v2): the field name on the shared
   * `workspaces` collection is **`v2Enabled` (camelCase)**, matching
   * v1's existing camelCase convention for new fields
   * (`canceledAt`, `cleanupStartedAt`, `cleanupMutationAt`). The
   * Phase-6 HANDOFF + every v1 reader must use the same casing —
   * codex review P6 P1#2 flagged an earlier doc-vs-code mismatch.
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
