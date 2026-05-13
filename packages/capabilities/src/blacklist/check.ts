import { z } from "zod";
import { defineCapability } from "../registry";

/**
 * blacklist.check — is this creator blacklisted (workspace-scoped)? Ports v1
 * `blacklist` collection + `api/blacklist/auto-detect` rules
 * (REPEATED_REJECTION / NO_CONTENT_DELIVERY / FRAUD / MANUAL; severity
 * WARNING / TEMPORARY / PERMANENT). The Vetting agent calls this on every
 * candidate; PERMANENT ⇒ hard-drop, WARNING ⇒ flag for human.
 */
export const blacklistCheck = defineCapability({
  name: "blacklist.check",
  description: "Check whether a TikTok creator is blacklisted for this workspace; returns reason and severity.",
  scope: "read",
  idempotent: true,
  rateLimitClass: "default",
  input: z.object({ uniqueIds: z.array(z.string()).min(1).max(500) }),
  output: z.object({
    results: z.array(
      z.object({
        uniqueId: z.string(),
        blacklisted: z.boolean(),
        reason: z.enum(["REPEATED_REJECTION", "NO_CONTENT_DELIVERY", "FRAUD", "MANUAL", "OTHER"]).optional(),
        severity: z.enum(["WARNING", "TEMPORARY", "PERMANENT"]).optional(),
      }),
    ),
  }),
  async handler(_input, _ctx) {
    // TODO(phase-1, task V3): read SHARED `blacklist` collection.
    throw new Error("blacklist.check not implemented — see docs/PHASE-1-PLAN.md task V3");
  },
});
