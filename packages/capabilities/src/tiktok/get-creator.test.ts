import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeMongo, Collections, getDb } from "@ss/db";
import { setTikTokFetcher, tiktokGetCreator, type TikTokFetcher, type RawCreator, type TikTokPost } from "./get-creator";

/**
 * V1 — tiktok.getCreator. Verifies cache-hit / stale-refresh / cache-miss
 * branches through an injectable TikTokFetcher (no RAPIDAPI_KEY_TIKTOK
 * needed), and the additive upsert on refresh.
 */

const ctx = { workspaceId: "ws", userId: "u".repeat(21), rateLimitClass: "tiktok_read" as const };

interface FakeFetcherSpy extends TikTokFetcher {
  userInfoCalls: string[];
  userPostsCalls: string[];
}
function fakeFetcher(creator: RawCreator, posts: TikTokPost[] = []): FakeFetcherSpy {
  const userInfoCalls: string[] = [];
  const userPostsCalls: string[] = [];
  return {
    userInfoCalls,
    userPostsCalls,
    async getUserInfo(uniqueId) {
      userInfoCalls.push(uniqueId);
      return creator;
    },
    async getUserPosts(uniqueId) {
      userPostsCalls.push(uniqueId);
      return posts;
    },
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

afterEach(() => {
  setTikTokFetcher(undefined);
});

afterAll(async () => {
  await closeMongo();
});

const post1: TikTokPost = {
  id: "post_1", desc: "수분 한 방울로 톡톡", hashtags: ["스킨케어", "serum"],
  views: 18_400, likes: 920, comments: 31, shares: 8, createdAt: new Date("2026-05-10"),
};

const sample = (over: Partial<RawCreator> = {}): RawCreator => ({
  id: "id_freshly",
  uniqueId: "@freshly",
  nickname: "freshly",
  signature: "k-beauty / 수분",
  followerCount: 42_000,
  followingCount: 110,
  videoCount: 84,
  heartCount: 1_800_000,
  verified: false,
  privateAccount: false,
  hashtags: ["스킨케어"],
  textLanguage: "ko",
  ...over,
});

describe("tiktok.getCreator", () => {
  it("cache hit: serves from accounts_tiktok without calling the fetcher when fresh", async () => {
    const db = await getDb();
    await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).insertOne({
      ...sample(),
      updatedAt: new Date(), // fresh
    });
    const fetcher = fakeFetcher(sample({ nickname: "should_not_be_used" }), [post1]);
    setTikTokFetcher(fetcher);
    const out = await tiktokGetCreator.handler({ uniqueId: "@freshly", withRecentPosts: false, forceRefresh: false }, ctx);
    expect(out.creator.nickname).toBe("freshly"); // cached value, not the fake's "should_not_be_used"
    expect(fetcher.userInfoCalls).toEqual([]);
  });

  it("cache miss: calls fetcher.getUserInfo, upserts into accounts_tiktok, returns the fresh data", async () => {
    const fetcher = fakeFetcher(sample({ nickname: "new_handle" }));
    setTikTokFetcher(fetcher);
    const out = await tiktokGetCreator.handler({ uniqueId: "@freshly", withRecentPosts: false, forceRefresh: false }, ctx);
    expect(fetcher.userInfoCalls).toEqual(["@freshly"]);
    expect(out.creator.nickname).toBe("new_handle");
    // verify the upsert
    const db = await getDb();
    const persisted = await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).findOne({ uniqueId: "@freshly" });
    expect(persisted?.nickname).toBe("new_handle");
    expect(persisted?.updatedAt).toBeInstanceOf(Date);
  });

  it("stale-by-24h cache: refreshes via fetcher, preserves any extra v1-only fields not in the refresh", async () => {
    const db = await getDb();
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000); // 2 days old
    await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).insertOne({
      ...sample({ nickname: "old_handle" }),
      updatedAt: longAgo,
      extraV1Field: "do_not_drop_me", // simulate a v1-owned field v2 doesn't know about
    });
    const fetcher = fakeFetcher(sample({ nickname: "renamed", followerCount: 50_000 }));
    setTikTokFetcher(fetcher);
    const out = await tiktokGetCreator.handler({ uniqueId: "@freshly", withRecentPosts: false, forceRefresh: false }, ctx);
    expect(fetcher.userInfoCalls).toEqual(["@freshly"]);
    expect(out.creator.followerCount).toBe(50_000);
    // additive upsert: extra v1 field should still be there
    const persisted = await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).findOne({ uniqueId: "@freshly" });
    expect(persisted?.extraV1Field).toBe("do_not_drop_me");
    expect(persisted?.nickname).toBe("renamed");
  });

  it("withRecentPosts: true → calls fetcher.getUserPosts and surfaces them", async () => {
    const db = await getDb();
    await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).insertOne({ ...sample(), updatedAt: new Date() });
    const fetcher = fakeFetcher(sample(), [post1]);
    setTikTokFetcher(fetcher);
    const out = await tiktokGetCreator.handler({ uniqueId: "@freshly", withRecentPosts: true, forceRefresh: false }, ctx);
    expect(fetcher.userPostsCalls).toEqual(["@freshly"]);
    expect(out.recentPosts).toHaveLength(1);
    expect(out.recentPosts[0]?.id).toBe("post_1");
  });

  it("error path: empty uniqueId is rejected by input schema", () => {
    expect(tiktokGetCreator.input.safeParse({ uniqueId: "" }).success).toBe(false);
  });
});
