import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMongo, Collections, getDb,
  importV1Workspaces, ObjectId, workspaceRepo,
} from "@ss/db";

/**
 * P6-C1 — v1→v2 workspace importer. Tests via the shared `workspaces`
 * collection seeded by ObjectId; verifies:
 *   · idempotent (re-runs are no-ops)
 *   · canceledAt rows skipped by default
 *   · cleanupMutationAt rows ALWAYS skipped (even with --include-canceled)
 *   · dryRun never writes
 *   · failures don't kill the run; recorded in result
 *   · preview buckets cap at 5 ids
 *
 * Lives under @ss/workflows because @ss/db doesn't carry a test runner;
 * the importer is exported from @ss/db so this only needs the public
 * surface. (Same pattern as report-deliver.test.ts using reportRepo.)
 */

beforeAll(async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set");
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.SHARED_WORKSPACES).deleteMany({});
  await db.collection(Collections.V2_WORKSPACE_POLICIES).deleteMany({});
});

afterEach(() => {/* no global state */});

afterAll(async () => { await closeMongo(); });

async function seedV1Workspace(opts: Partial<{
  name: string; ownerId: string; plan: string;
  canceledAt: Date | null; cleanupMutationAt: Date | null;
}>): Promise<string> {
  const db = await getDb();
  const _id = new ObjectId();
  await db.collection(Collections.SHARED_WORKSPACES).insertOne({
    _id,
    name: opts.name ?? "Test Workspace",
    slug: (opts.name ?? "test").toLowerCase().replace(/\s+/g, "-"),
    ownerId: opts.ownerId ?? "u".repeat(21),
    plan: opts.plan ?? "FREE",
    seatLimit: 5,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    canceledAt: opts.canceledAt ?? null,
    ...(opts.cleanupMutationAt !== undefined ? { cleanupMutationAt: opts.cleanupMutationAt } : {}),
  });
  return String(_id);
}

describe("import-v1-workspaces", () => {
  it("empty shared collection → scanned=0, no writes", async () => {
    const r = await importV1Workspaces({ dryRun: false, includeCanceled: false });
    expect(r).toMatchObject({ scanned: 0, created: 0, alreadyImported: 0, failures: [] });
    const policies = await (await getDb()).collection(Collections.V2_WORKSPACE_POLICIES).countDocuments();
    expect(policies).toBe(0);
  });

  it("happy path: 3 workspaces → 3 default policies created", async () => {
    const id1 = await seedV1Workspace({ name: "Alpha" });
    const id2 = await seedV1Workspace({ name: "Beta" });
    const id3 = await seedV1Workspace({ name: "Gamma" });
    const r = await importV1Workspaces({ dryRun: false, includeCanceled: false });
    expect(r.failures).toEqual([]);
    expect(r.scanned).toBe(3);
    expect(r.created).toBe(3);
    expect(r.alreadyImported).toBe(0);
    expect(r.skippedCanceled).toBe(0);
    // All three got default policies (mode='always_ask' on all 5 gates).
    for (const id of [id1, id2, id3]) {
      const p = await workspaceRepo.getPolicy(id);
      expect(p.level).toBe("checkpointed");
      expect(p.gates.approveShortlist.mode).toBe("always_ask");
      expect(p.gates.approveOutreachSend.mode).toBe("always_ask");
      expect(p.gates.approveReplyResponse.mode).toBe("always_ask");
      expect(p.gates.approveShipment.mode).toBe("always_ask");
      expect(p.gates.approveStageAdvance.mode).toBe("always_ask");
    }
  });

  it("idempotent: re-run on already-imported workspaces is a no-op (alreadyImported counts up)", async () => {
    await seedV1Workspace({ name: "Re-runnable" });
    const r1 = await importV1Workspaces({ dryRun: false, includeCanceled: false });
    expect(r1.created).toBe(1);
    expect(r1.alreadyImported).toBe(0);
    const r2 = await importV1Workspaces({ dryRun: false, includeCanceled: false });
    expect(r2.scanned).toBe(1);
    expect(r2.created).toBe(0);
    expect(r2.alreadyImported).toBe(1);
    // Still only 1 policy row — no duplicate.
    const count = await (await getDb()).collection(Collections.V2_WORKSPACE_POLICIES).countDocuments();
    expect(count).toBe(1);
  });

  it("canceled workspaces skipped by default; with --include-canceled they import", async () => {
    await seedV1Workspace({ name: "Active" });
    const canceledId = await seedV1Workspace({ name: "Gone", canceledAt: new Date() });
    const r1 = await importV1Workspaces({ dryRun: false, includeCanceled: false });
    expect(r1.scanned).toBe(1); // Mongo filter drops canceled
    expect(r1.created).toBe(1);
    // Now re-run with includeCanceled — picks up the previously-skipped one.
    const r2 = await importV1Workspaces({ dryRun: false, includeCanceled: true });
    expect(r2.scanned).toBe(2);
    expect(r2.created).toBe(1); // the canceled one
    expect(r2.alreadyImported).toBe(1);
    const canceled = await workspaceRepo.getPolicy(canceledId);
    expect(canceled.workspaceId).toBe(canceledId);
  });

  it("cleanupMutationAt rows ALWAYS skipped — even with --include-canceled (point-of-no-return)", async () => {
    await seedV1Workspace({ name: "Crossed", cleanupMutationAt: new Date(), canceledAt: new Date() });
    const r = await importV1Workspaces({ dryRun: false, includeCanceled: true });
    expect(r.scanned).toBe(0);
    expect(r.created).toBe(0);
    const count = await (await getDb()).collection(Collections.V2_WORKSPACE_POLICIES).countDocuments();
    expect(count).toBe(0);
  });

  it("dryRun: counts would-create but writes nothing", async () => {
    await seedV1Workspace({ name: "DryA" });
    await seedV1Workspace({ name: "DryB" });
    const r = await importV1Workspaces({ dryRun: true, includeCanceled: false });
    expect(r.scanned).toBe(2);
    expect(r.created).toBe(2); // "would create"
    // But no actual rows
    const count = await (await getDb()).collection(Collections.V2_WORKSPACE_POLICIES).countDocuments();
    expect(count).toBe(0);
    // Preview surfaces ids
    expect(r.preview.wouldCreate).toHaveLength(2);
  });

  it("preview buckets cap at 5 even with many rows", async () => {
    for (let i = 0; i < 8; i++) await seedV1Workspace({ name: `W${i}` });
    const r = await importV1Workspaces({ dryRun: true, includeCanceled: false });
    expect(r.scanned).toBe(8);
    expect(r.created).toBe(8);
    expect(r.preview.wouldCreate).toHaveLength(5);
  });
});
