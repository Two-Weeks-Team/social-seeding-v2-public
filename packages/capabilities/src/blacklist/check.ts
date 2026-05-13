import { z } from "zod";
import { Collections, getDb } from "@ss/db";
import { defineCapability } from "../registry";

/**
 * blacklist.check — port of v1 `~/social-seeding/src/app/api/blacklist/check`.
 * Reads the SHARED `influencer_blacklist` collection (v1-owned) for a batch of
 * uniqueIds and returns per-id `{ blacklisted, reason?, severity? }`. The
 * Vetting agent calls this on every candidate; PERMANENT ⇒ hard-drop,
 * TEMPORARY / WARNING ⇒ a flag for the human to decide.
 *
 * Filter mirrors v1: isActive=true AND (no expiryDate OR expiryDate > now).
 * Reason / severity values are v1's lowercase enum (BlacklistReason /
 * BlacklistSeverity from ~/social-seeding/src/types/blacklist.ts) — kept as-is
 * for parity. Unexpected legacy values are dropped from the output rather
 * than crashing schema validation.
 *
 * Workspace scoping: v1's blacklist isn't workspace-scoped, so this returns
 * the *global* blacklist. When v2 needs per-workspace blacklists, add a
 * workspaceId filter here + populate it in v1 ingestion (additive).
 */
export const ReasonSchema = z.enum(["repeated_rejection", "no_content_delivery", "manual", "fraud", "other"]);
export const SeveritySchema = z.enum(["warning", "temporary", "permanent"]);

interface BlacklistDoc {
  uniqueId?: string;
  secUid?: string;
  reason?: unknown;
  severity?: unknown;
}

export const blacklistCheck = defineCapability({
  name: "blacklist.check",
  description:
    "Check whether each given TikTok uniqueId is on the active, non-expired blacklist; returns reason + severity for hits (v1's BlacklistReason / BlacklistSeverity enums, lowercase).",
  scope: "read",
  idempotent: true,
  rateLimitClass: "default",
  input: z.object({ uniqueIds: z.array(z.string().min(1)).min(1).max(500) }),
  output: z.object({
    results: z.array(
      z.object({
        uniqueId: z.string(),
        blacklisted: z.boolean(),
        reason: ReasonSchema.optional(),
        severity: SeveritySchema.optional(),
      }),
    ),
  }),
  async handler({ uniqueIds }, _ctx) {
    const db = await getDb();
    const now = new Date();
    const docs = (await db
      .collection(Collections.SHARED_BLACKLIST)
      .find({
        uniqueId: { $in: uniqueIds },
        isActive: true,
        $or: [
          { expiryDate: { $exists: false } },
          { expiryDate: null },
          { expiryDate: { $gt: now } },
        ],
      })
      .project({ uniqueId: 1, reason: 1, severity: 1 })
      .toArray()) as BlacklistDoc[];

    const byId = new Map<string, { reason?: string; severity?: string }>();
    for (const d of docs) {
      if (typeof d.uniqueId === "string") {
        byId.set(d.uniqueId, {
          reason: typeof d.reason === "string" ? d.reason : undefined,
          severity: typeof d.severity === "string" ? d.severity : undefined,
        });
      }
    }

    const results = uniqueIds.map((uniqueId) => {
      const hit = byId.get(uniqueId);
      if (!hit) return { uniqueId, blacklisted: false };
      const reason = ReasonSchema.safeParse(hit.reason);
      const severity = SeveritySchema.safeParse(hit.severity);
      return {
        uniqueId,
        blacklisted: true,
        ...(reason.success ? { reason: reason.data } : {}),
        ...(severity.success ? { severity: severity.data } : {}),
      };
    });

    return { results };
  },
});
