import { z } from "zod";
import { Collections, getDb } from "@ss/db";
import { defineCapability } from "../registry";

/**
 * suppression.check / .add — port of the v1 "do-not-mail" list, adapted as
 * a v2-owned capability so the orchestrator can wire it through invokeCapability.
 *
 * Why a list at all (CAN-SPAM §5):
 *   · users who hit /unsubscribe (P2-C7c) get added with reason="unsubscribed".
 *   · bounce webhook (Phase 2.5 Resend integration) adds reason="bounced".
 *   · operators can manually add reason="manual" from MC (Phase 2.5).
 *
 * gmail.send checks this list pre-send and refuses to mail anyone on it
 * (wired in the next commit). The list is workspace-scoped because two
 * workspaces sharing a Gmail box still maintain separate trust contracts
 * with their recipients — a creator who unsubscribed from Brand A's seeding
 * has not necessarily unsubscribed from Brand B's.
 */

const SUPPRESSION_REASONS = ["unsubscribed", "bounced", "complaint", "manual"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

interface SuppressionDoc {
  email: string;
  workspaceId: string;
  reason: SuppressionReason;
  source: string;
  addedAt: Date;
  /** For traceability — which campaign / track triggered the addition. */
  campaignId?: string;
  creatorId?: string;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const suppressionCheck = defineCapability({
  name: "suppression.check",
  description:
    "Return whether a recipient email is on the workspace's suppression list. gmail.send calls this pre-send to honor unsubscribes + bounces (CAN-SPAM §5).",
  scope: "read",
  idempotent: true,
  rateLimitClass: "default",
  input: z.object({ email: z.string().email() }),
  output: z.object({
    suppressed: z.boolean(),
    reason: z.enum(SUPPRESSION_REASONS).optional(),
    addedAt: z.coerce.date().optional(),
  }),
  async handler({ email }, ctx) {
    const db = await getDb();
    const doc = await db
      .collection<SuppressionDoc>(Collections.V2_SUPPRESSION_LIST)
      .findOne({ workspaceId: ctx.workspaceId, email: normalizeEmail(email) });
    if (!doc) return { suppressed: false };
    return { suppressed: true, reason: doc.reason, addedAt: doc.addedAt };
  },
});

export const suppressionAdd = defineCapability({
  name: "suppression.add",
  description:
    "Add an email to the workspace's suppression list. Idempotent — repeat calls update the source/reason but never duplicate.",
  scope: "write",
  idempotent: true,
  rateLimitClass: "default",
  input: z.object({
    email: z.string().email(),
    reason: z.enum(SUPPRESSION_REASONS),
    source: z.string().min(1).max(200),
    campaignId: z.string().optional(),
    creatorId: z.string().optional(),
  }),
  output: z.object({ added: z.boolean(), email: z.string() }),
  async handler({ email, reason, source, campaignId, creatorId }, ctx) {
    const db = await getDb();
    const normalized = normalizeEmail(email);
    const res = await db.collection<SuppressionDoc>(Collections.V2_SUPPRESSION_LIST).updateOne(
      { workspaceId: ctx.workspaceId, email: normalized },
      {
        $set: { reason, source, ...(campaignId ? { campaignId } : {}), ...(creatorId ? { creatorId } : {}) },
        $setOnInsert: { workspaceId: ctx.workspaceId, email: normalized, addedAt: new Date() },
      },
      { upsert: true },
    );
    return { added: res.upsertedCount > 0, email: normalized };
  },
});

/**
 * Direct helper for gmail.send pre-send (avoids a recursive
 * invokeCapability call through the registry from inside another capability).
 */
export async function isSuppressed(workspaceId: string, email: string): Promise<{ suppressed: boolean; reason?: SuppressionReason }> {
  const db = await getDb();
  const doc = await db
    .collection<SuppressionDoc>(Collections.V2_SUPPRESSION_LIST)
    .findOne({ workspaceId, email: normalizeEmail(email) });
  return doc ? { suppressed: true, reason: doc.reason } : { suppressed: false };
}
