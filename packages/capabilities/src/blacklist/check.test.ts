import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeMongo, Collections, getDb } from "@ss/db";
import { blacklistCheck } from "./check";

/**
 * V3 — blacklist.check. Seeds the SHARED influencer_blacklist collection in
 * dev-mongo and verifies the active+non-expired filter + the per-id mapping
 * matches v1 parity.
 */

const ctx = { workspaceId: "ws", userId: "u".repeat(21), rateLimitClass: "default" as const };

beforeAll(async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI not set — start scripts/dev-mongo + source .mongo-dev/dev-env first");
  }
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.SHARED_BLACKLIST).deleteMany({});
});

afterAll(async () => {
  await closeMongo();
});

describe("blacklist.check", () => {
  it("returns blacklisted=true with reason+severity for active hits; false otherwise", async () => {
    const db = await getDb();
    await db.collection(Collections.SHARED_BLACKLIST).insertMany([
      { uniqueId: "@flaky_creator", isActive: true, reason: "no_content_delivery", severity: "permanent" },
      { uniqueId: "@fraudster", isActive: true, reason: "fraud", severity: "permanent" },
      { uniqueId: "@warning_only", isActive: true, reason: "repeated_rejection", severity: "warning" },
    ]);
    const out = await blacklistCheck.handler(
      { uniqueIds: ["@flaky_creator", "@fraudster", "@warning_only", "@clean_user"] },
      ctx,
    );
    const byId = new Map(out.results.map((r) => [r.uniqueId, r]));
    expect(byId.get("@flaky_creator")).toEqual({
      uniqueId: "@flaky_creator", blacklisted: true, reason: "no_content_delivery", severity: "permanent",
    });
    expect(byId.get("@fraudster")?.severity).toBe("permanent");
    expect(byId.get("@warning_only")?.severity).toBe("warning");
    expect(byId.get("@clean_user")).toEqual({ uniqueId: "@clean_user", blacklisted: false });
    expect(out.results).toHaveLength(4);
  });

  it("ignores inactive and expired rows (v1 parity)", async () => {
    const db = await getDb();
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.collection(Collections.SHARED_BLACKLIST).insertMany([
      { uniqueId: "@expired", isActive: true, reason: "manual", severity: "temporary", expiryDate: past },
      { uniqueId: "@inactive", isActive: false, reason: "manual", severity: "permanent" },
      { uniqueId: "@still_temp", isActive: true, reason: "manual", severity: "temporary", expiryDate: future },
    ]);
    const out = await blacklistCheck.handler(
      { uniqueIds: ["@expired", "@inactive", "@still_temp"] },
      ctx,
    );
    const byId = new Map(out.results.map((r) => [r.uniqueId, r]));
    expect(byId.get("@expired")?.blacklisted).toBe(false);
    expect(byId.get("@inactive")?.blacklisted).toBe(false);
    expect(byId.get("@still_temp")?.blacklisted).toBe(true);
  });

  it("drops unexpected legacy reason/severity values instead of failing schema validation", async () => {
    const db = await getDb();
    await db.collection(Collections.SHARED_BLACKLIST).insertOne({
      uniqueId: "@legacy", isActive: true, reason: "LEGACY_UPPER", severity: "weird",
    });
    const out = await blacklistCheck.handler({ uniqueIds: ["@legacy"] }, ctx);
    expect(out.results[0]).toEqual({ uniqueId: "@legacy", blacklisted: true });
  });

  it("error path: empty uniqueIds is rejected by input schema", () => {
    expect(blacklistCheck.input.safeParse({ uniqueIds: [] }).success).toBe(false);
  });
});
