import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setUsageStore, type UsageStore } from "@ss/capabilities";
import { closeMongo, Collections, getDb, leadRepo, ObjectId } from "@ss/db";
import { crmSearch } from "./search";

/**
 * P5-C1 — crm.search. Reads v2_leads (our overlay) + the shared
 * crm_accounts collection (v1 data, read freely; never write). Tests
 * cover the union behavior, dedupe on sharedAccountId, and the
 * country/query filters.
 */

const memUsageStore: UsageStore = {
  async increment() { return 1; },
  async decrement() {},
  async getOverride() { return null; },
};

beforeAll(async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set");
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.V2_LEADS).deleteMany({});
  await db.collection(Collections.SHARED_CRM_ACCOUNTS).deleteMany({});
  setUsageStore(memUsageStore);
});

afterEach(() => {
  setUsageStore(undefined);
});

afterAll(async () => { await closeMongo(); });

async function seedSharedAccount(opts: Partial<{
  companyName: string; companyNameEn: string; country: string; homepageUrl: string; deletedAt: Date | null;
}>): Promise<string> {
  const db = await getDb();
  const _id = new ObjectId();
  await db.collection(Collections.SHARED_CRM_ACCOUNTS).insertOne({
    _id,
    companyName: opts.companyName ?? "Acme Cosmetics",
    companyNameEn: opts.companyNameEn ?? "Acme Cosmetics",
    country: opts.country ?? "KR",
    homepageUrl: opts.homepageUrl ?? "https://acme.kr",
    deletedAt: opts.deletedAt ?? null,
  });
  return String(_id);
}

describe("crm.search", () => {
  it("empty everything → empty result, no throw", async () => {
    const out = await crmSearch.handler(
      { workspaceId: "ws_s", excludeIds: [], limit: 50 },
      { workspaceId: "ws_s", userId: "u".repeat(21), rateLimitClass: "default" },
    );
    expect(out.leads).toEqual([]);
    expect(out.sharedCandidates).toEqual([]);
  });

  it("returns v2_leads matching the workspace, ignores other workspaces", async () => {
    await leadRepo.create({
      workspaceId: "ws_s", companyName: "Mine", country: "KR",
      tags: [], snsLinks: {}, stage: "imported", lastActivityAt: new Date(), notes: "",
    });
    await leadRepo.create({
      workspaceId: "ws_other", companyName: "Theirs", country: "KR",
      tags: [], snsLinks: {}, stage: "imported", lastActivityAt: new Date(), notes: "",
    });
    const out = await crmSearch.handler(
      { workspaceId: "ws_s", excludeIds: [], limit: 50 },
      { workspaceId: "ws_s", userId: "u".repeat(21), rateLimitClass: "default" },
    );
    expect(out.leads.map((l) => l.companyName)).toEqual(["Mine"]);
  });

  it("returns shared crm_accounts as `sharedCandidates`, deduped against already-imported v2 rows", async () => {
    const sharedAlreadyImported = await seedSharedAccount({ companyName: "Already" });
    const sharedFresh = await seedSharedAccount({ companyName: "Fresh" });
    // v2_leads row that already references the first shared row
    await leadRepo.create({
      workspaceId: "ws_s",
      sharedAccountId: sharedAlreadyImported,
      companyName: "Already", country: "KR",
      tags: [], snsLinks: {}, stage: "enriched", lastActivityAt: new Date(), notes: "",
    });
    const out = await crmSearch.handler(
      { workspaceId: "ws_s", excludeIds: [], limit: 50 },
      { workspaceId: "ws_s", userId: "u".repeat(21), rateLimitClass: "default" },
    );
    // sharedCandidates includes ONLY the not-yet-imported one
    expect(out.sharedCandidates.map((s) => s.sharedAccountId)).toEqual([sharedFresh]);
    // v2 result includes the imported one
    expect(out.leads.map((l) => l.sharedAccountId)).toEqual([sharedAlreadyImported]);
  });

  it("query filter: substring match on companyName + companyNameEn (case-insensitive)", async () => {
    await leadRepo.create({
      workspaceId: "ws_s", companyName: "Hydra Serum 코스메틱", companyNameEn: "Hydra Cosmetics",
      country: "KR", tags: [], snsLinks: {}, stage: "imported", lastActivityAt: new Date(), notes: "",
    });
    await leadRepo.create({
      workspaceId: "ws_s", companyName: "Toner Brand", companyNameEn: "Toner",
      country: "KR", tags: [], snsLinks: {}, stage: "imported", lastActivityAt: new Date(), notes: "",
    });
    await seedSharedAccount({ companyName: "Hydra Skincare Co", companyNameEn: "HYDRA SKINCARE" });
    await seedSharedAccount({ companyName: "Unrelated", companyNameEn: "Unrelated" });
    const out = await crmSearch.handler(
      { workspaceId: "ws_s", query: "hydra", excludeIds: [], limit: 50 },
      { workspaceId: "ws_s", userId: "u".repeat(21), rateLimitClass: "default" },
    );
    expect(out.leads.map((l) => l.companyName)).toContain("Hydra Serum 코스메틱");
    expect(out.leads.map((l) => l.companyName)).not.toContain("Toner Brand");
    expect(out.sharedCandidates.map((s) => s.companyName)).toContain("Hydra Skincare Co");
    expect(out.sharedCandidates.map((s) => s.companyName)).not.toContain("Unrelated");
  });

  it("countries filter: restricts both v2 + shared to listed ISO codes", async () => {
    await leadRepo.create({
      workspaceId: "ws_s", companyName: "KR Brand", country: "KR",
      tags: [], snsLinks: {}, stage: "imported", lastActivityAt: new Date(), notes: "",
    });
    await leadRepo.create({
      workspaceId: "ws_s", companyName: "US Brand", country: "US",
      tags: [], snsLinks: {}, stage: "imported", lastActivityAt: new Date(), notes: "",
    });
    await seedSharedAccount({ companyName: "JP Shared", country: "JP" });
    await seedSharedAccount({ companyName: "KR Shared", country: "KR" });
    const out = await crmSearch.handler(
      { workspaceId: "ws_s", countries: ["KR"], excludeIds: [], limit: 50 },
      { workspaceId: "ws_s", userId: "u".repeat(21), rateLimitClass: "default" },
    );
    expect(out.leads.map((l) => l.companyName)).toEqual(["KR Brand"]);
    expect(out.sharedCandidates.map((s) => s.companyName)).toEqual(["KR Shared"]);
  });

  it("excludeIds filter on v2 results", async () => {
    const keep = await leadRepo.create({
      workspaceId: "ws_s", companyName: "Keep", country: "KR",
      tags: [], snsLinks: {}, stage: "imported", lastActivityAt: new Date(), notes: "",
    });
    const drop = await leadRepo.create({
      workspaceId: "ws_s", companyName: "Drop", country: "KR",
      tags: [], snsLinks: {}, stage: "imported", lastActivityAt: new Date(), notes: "",
    });
    const out = await crmSearch.handler(
      { workspaceId: "ws_s", excludeIds: [drop.id], limit: 50 },
      { workspaceId: "ws_s", userId: "u".repeat(21), rateLimitClass: "default" },
    );
    expect(out.leads.map((l) => l.id)).toEqual([keep.id]);
  });

  it("P5 codex P2#4: regex special chars in query are escaped (no Mongo error, no .* false match)", async () => {
    await seedSharedAccount({ companyName: "Curry House (Seoul)" });
    await seedSharedAccount({ companyName: "Unrelated Brand" });
    // A query containing `(` would, unescaped, be invalid regex syntax
    // and throw at query time; the escape lets it match literally.
    const out = await crmSearch.handler(
      { workspaceId: "ws_s", query: "(Seoul)", excludeIds: [], limit: 50 },
      { workspaceId: "ws_s", userId: "u".repeat(21), rateLimitClass: "default" },
    );
    expect(out.sharedCandidates.map((s) => s.companyName)).toEqual(["Curry House (Seoul)"]);
    // ".*" must NOT match all rows — it should match the literal string.
    const out2 = await crmSearch.handler(
      { workspaceId: "ws_s", query: ".*", excludeIds: [], limit: 50 },
      { workspaceId: "ws_s", userId: "u".repeat(21), rateLimitClass: "default" },
    );
    expect(out2.sharedCandidates).toHaveLength(0);
  });

  it("skips soft-deleted shared rows (deletedAt set)", async () => {
    await seedSharedAccount({ companyName: "Active", deletedAt: null });
    await seedSharedAccount({ companyName: "Gone", deletedAt: new Date() });
    const out = await crmSearch.handler(
      { workspaceId: "ws_s", excludeIds: [], limit: 50 },
      { workspaceId: "ws_s", userId: "u".repeat(21), rateLimitClass: "default" },
    );
    expect(out.sharedCandidates.map((s) => s.companyName)).toEqual(["Active"]);
  });
});
