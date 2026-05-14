import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMongo, Collections, getDb,
  ObjectId, workspaceRepo,
} from "@ss/db";

/**
 * P6-C2 — workspaceRepo v2-rollout flag helpers. Reads/writes the
 * `v2Enabled` (additive) field on the shared `workspaces` doc.
 */

beforeAll(async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set");
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.SHARED_WORKSPACES).deleteMany({});
});

afterEach(() => {/* no global state */});

afterAll(async () => { await closeMongo(); });

async function seedWorkspace(): Promise<string> {
  const db = await getDb();
  const _id = new ObjectId();
  await db.collection(Collections.SHARED_WORKSPACES).insertOne({
    _id, name: "T", slug: "t", ownerId: "u".repeat(21),
    plan: "FREE", seatLimit: 5,
    createdAt: new Date(), updatedAt: new Date(), canceledAt: null,
  });
  return String(_id);
}

describe("workspaceRepo v2 rollout flag (P6-C2)", () => {
  it("isV2Enabled defaults to false when the field is unset", async () => {
    const id = await seedWorkspace();
    expect(await workspaceRepo.isV2Enabled(id)).toBe(false);
  });

  it("isV2Enabled returns false for a missing workspace id", async () => {
    expect(await workspaceRepo.isV2Enabled("6a000000000000000000dead")).toBe(false);
  });

  it("isV2Enabled returns false for a malformed id (no throw, no leak)", async () => {
    expect(await workspaceRepo.isV2Enabled("not-an-objectid")).toBe(false);
  });

  it("setV2Enabled(true) writes the flag + v2EnabledAt timestamp; isV2Enabled flips to true", async () => {
    const id = await seedWorkspace();
    const ok = await workspaceRepo.setV2Enabled(id, true);
    expect(ok).toBe(true);
    expect(await workspaceRepo.isV2Enabled(id)).toBe(true);
    const db = await getDb();
    const doc = await db.collection(Collections.SHARED_WORKSPACES).findOne({ _id: new ObjectId(id) });
    expect(doc?.v2Enabled).toBe(true);
    expect(doc?.v2EnabledAt).toBeInstanceOf(Date);
    expect(doc?.v2DisabledAt).toBeUndefined();
  });

  it("setV2Enabled(false) flips the flag back + writes v2DisabledAt (audit trail kept)", async () => {
    const id = await seedWorkspace();
    await workspaceRepo.setV2Enabled(id, true);
    await workspaceRepo.setV2Enabled(id, false);
    expect(await workspaceRepo.isV2Enabled(id)).toBe(false);
    const db = await getDb();
    const doc = await db.collection(Collections.SHARED_WORKSPACES).findOne({ _id: new ObjectId(id) });
    expect(doc?.v2Enabled).toBe(false);
    // History fields BOTH stay around — the rollback trail is visible.
    expect(doc?.v2EnabledAt).toBeInstanceOf(Date);
    expect(doc?.v2DisabledAt).toBeInstanceOf(Date);
  });

  it("setV2Enabled is additive — name + ownerId + plan + other v1 fields untouched", async () => {
    const id = await seedWorkspace();
    const db = await getDb();
    const before = await db.collection(Collections.SHARED_WORKSPACES).findOne({ _id: new ObjectId(id) });
    await workspaceRepo.setV2Enabled(id, true);
    const after = await db.collection(Collections.SHARED_WORKSPACES).findOne({ _id: new ObjectId(id) });
    expect(after?.name).toBe(before?.name);
    expect(after?.ownerId).toBe(before?.ownerId);
    expect(after?.plan).toBe(before?.plan);
    expect(after?.seatLimit).toBe(before?.seatLimit);
    expect(after?.createdAt).toEqual(before?.createdAt);
    expect(after?.canceledAt).toBe(before?.canceledAt);
  });

  it("setV2Enabled on a missing workspace id returns false (no insert; no upsert behavior)", async () => {
    const ok = await workspaceRepo.setV2Enabled("6a000000000000000000dead", true);
    expect(ok).toBe(false);
    const db = await getDb();
    const count = await db.collection(Collections.SHARED_WORKSPACES).countDocuments();
    expect(count).toBe(0);
  });

  it("setV2Enabled on a malformed id returns false cleanly", async () => {
    expect(await workspaceRepo.setV2Enabled("not-an-objectid", true)).toBe(false);
  });

  // ─ codex review P1#1 — owner/admin gate on the rollout flag ─

  it("isOwnerOrAdmin: workspace ownerId match → true", async () => {
    const id = await seedWorkspace();
    expect(await workspaceRepo.isOwnerOrAdmin(id, "u".repeat(21))).toBe(true);
  });

  it("isOwnerOrAdmin: non-owner with no member row → false", async () => {
    const id = await seedWorkspace();
    expect(await workspaceRepo.isOwnerOrAdmin(id, "different-user-id-21-chars")).toBe(false);
  });

  it("isOwnerOrAdmin: workspace_members admin row → true (member, not owner)", async () => {
    const id = await seedWorkspace();
    const db = await getDb();
    await db.collection(Collections.SHARED_WORKSPACE_MEMBERS).insertOne({
      _id: new ObjectId(),
      workspaceId: id, userId: "admin-user-id-21-chars-x",
      role: "admin", email: "admin@example.com",
      joinedAt: new Date(), invitedBy: "u".repeat(21),
    });
    expect(await workspaceRepo.isOwnerOrAdmin(id, "admin-user-id-21-chars-x")).toBe(true);
  });

  it("isOwnerOrAdmin: workspace_members non-admin row (role='member') → false", async () => {
    const id = await seedWorkspace();
    const db = await getDb();
    await db.collection(Collections.SHARED_WORKSPACE_MEMBERS).insertOne({
      _id: new ObjectId(),
      workspaceId: id, userId: "regular-user-id-21-chars",
      role: "member", email: "member@example.com",
      joinedAt: new Date(), invitedBy: "u".repeat(21),
    });
    expect(await workspaceRepo.isOwnerOrAdmin(id, "regular-user-id-21-chars")).toBe(false);
  });

  it("isOwnerOrAdmin: missing workspace → false (no leak)", async () => {
    expect(await workspaceRepo.isOwnerOrAdmin("6a000000000000000000dead", "any-user-21-chars-xxxxx")).toBe(false);
  });

  it("isOwnerOrAdmin: malformed workspace id → false (no throw)", async () => {
    expect(await workspaceRepo.isOwnerOrAdmin("not-an-id", "user-21-chars-xxxxxxxxxx")).toBe(false);
  });
});
