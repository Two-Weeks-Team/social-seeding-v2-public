import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeMongo, Collections, getDb } from "@ss/db";
import { tiktokSearch } from "./search";

/**
 * S2 — tiktok.search. Seeds a small accounts_tiktok fixture into dev-mongo and
 * pins the v1-parity weighted ranking (10x / 5x / 2x / 1x) across the 4 modes,
 * plus the optional follower / engagement / language filters.
 */

const ctx = { workspaceId: "ws", userId: "u".repeat(21), rateLimitClass: "tiktok_read" as const };

function fixture(uniqueId: string, over: Record<string, unknown> = {}) {
  return {
    id: uniqueId.replace("@", "id_"),
    uniqueId,
    nickname: "Default",
    signature: "",
    hashtags: [],
    followerCount: 1_000,
    followingCount: 50,
    videoCount: 50,
    heartCount: 0,
    verified: false,
    privateAccount: false,
    textLanguage: "ko",
    ...over,
  };
}

beforeAll(async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI not set — start scripts/dev-mongo + source .mongo-dev/dev-env first");
  }
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).deleteMany({});
});

afterAll(async () => {
  await closeMongo();
});

describe("tiktok.search", () => {
  it("ranks hashtag hit 10x > signature 5x > nickname 2x > uniqueId 1x (single token)", async () => {
    const db = await getDb();
    await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).insertMany([
      fixture("@hashtag_winner", { hashtags: ["serum"], nickname: "x", signature: "x" }),
      fixture("@bio_winner", {     hashtags: [],        nickname: "x", signature: "i love serum and skincare" }),
      fixture("@nickname_winner", { hashtags: [],        nickname: "serum girl", signature: "x" }),
      fixture("@serum_handle", {    hashtags: [],        nickname: "x", signature: "x" }),
    ]);
    const out = await tiktokSearch.handler({ query: "serum", mode: "text", limit: 200 }, ctx);
    const order = out.creators.map((c) => c.uniqueId);
    // expected weights — hashtag(10) > signature(5) > nickname(2) > uniqueId(1)
    expect(order).toEqual(["@hashtag_winner", "@bio_winner", "@nickname_winner", "@serum_handle"]);
    expect(out.total).toBe(4);
    expect(out.continuation).toBeNull();
  });

  it("hashtag mode searches only the hashtags[] array (signature hits are ignored)", async () => {
    const db = await getDb();
    await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).insertMany([
      fixture("@a", { hashtags: ["스킨케어"], signature: "x" }),
      fixture("@b", { hashtags: [],            signature: "스킨케어 enthusiast" }),
    ]);
    const out = await tiktokSearch.handler({ query: "스킨케어", mode: "hashtag", limit: 200 }, ctx);
    expect(out.creators.map((c) => c.uniqueId)).toEqual(["@a"]);
  });

  it("and-mode (comma) requires every token to land somewhere", async () => {
    const db = await getDb();
    await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).insertMany([
      fixture("@both", {   hashtags: ["serum", "kbeauty"] }),
      fixture("@onlyA", {  hashtags: ["serum"] }),
      fixture("@onlyB", {  hashtags: ["kbeauty"] }),
    ]);
    const out = await tiktokSearch.handler({ query: "serum,kbeauty", mode: "and", limit: 200 }, ctx);
    expect(out.creators.map((c) => c.uniqueId)).toEqual(["@both"]);
  });

  it("or-mode (space) accepts any token across any field", async () => {
    const db = await getDb();
    await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).insertMany([
      fixture("@only_serum", {   hashtags: ["serum"] }),
      fixture("@only_kbeauty", { hashtags: ["kbeauty"] }),
      fixture("@neither", {      hashtags: ["other"] }),
    ]);
    const out = await tiktokSearch.handler({ query: "serum kbeauty", mode: "or", limit: 200 }, ctx);
    const ids = new Set(out.creators.map((c) => c.uniqueId));
    expect(ids).toEqual(new Set(["@only_serum", "@only_kbeauty"]));
    expect(out.total).toBe(2);
  });

  it("applies follower-range, language, and engagement-rate filters", async () => {
    const db = await getDb();
    await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).insertMany([
      // ER = heartCount / (followerCount * videoCount) — tune so only @target passes ER ≥ 0.005
      fixture("@target", {   hashtags: ["serum"], followerCount: 30_000, videoCount: 100, heartCount: 30_000, textLanguage: "ko" }), // ER = 0.01
      fixture("@too_small", { hashtags: ["serum"], followerCount: 500,    videoCount: 50,  heartCount: 500,    textLanguage: "ko" }),
      fixture("@too_big", {  hashtags: ["serum"], followerCount: 500_000,videoCount: 100, heartCount: 600_000,textLanguage: "ko" }),
      fixture("@wrong_lang", { hashtags: ["serum"], followerCount: 30_000, videoCount: 100, heartCount: 30_000, textLanguage: "en" }),
      fixture("@low_er", {   hashtags: ["serum"], followerCount: 30_000, videoCount: 100, heartCount: 100,    textLanguage: "ko" }), // ER ≈ 3e-5
    ]);
    const out = await tiktokSearch.handler(
      {
        query: "serum",
        mode: "text",
        minFollowers: 1_000,
        maxFollowers: 100_000,
        languages: ["ko"],
        minEngagementRate: 0.005,
        limit: 200,
      },
      ctx,
    );
    expect(out.creators.map((c) => c.uniqueId)).toEqual(["@target"]);
  });

  it("error path: empty query is rejected by the input schema", () => {
    expect(tiktokSearch.input.safeParse({ query: "" }).success).toBe(false);
  });
});
