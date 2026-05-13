import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CampaignBrief, CreatorTrack, TikTokCreator } from "@ss/contracts";
import { campaignRepo, closeMongo, Collections, getDb, shipmentRepo } from "@ss/db";
import type { RawCreator, TikTokFetcher, TikTokPost } from "@ss/capabilities";
import { NO_POST_TTL_DAYS, tiktokPostPollerHandler, type SendFn } from "./tiktok-post-poller";

/** Recording send-fn for tests — captures every emit; never reaches Inngest. */
function recordingSend(): SendFn & { calls: Array<{ name: string; data: Record<string, unknown> }> } {
  const calls: Array<{ name: string; data: Record<string, unknown> }> = [];
  const fn = (async (payload) => {
    const list = Array.isArray(payload) ? payload : [payload];
    for (const p of list) calls.push(p);
    return { ids: list.map((_, i) => `evt_${calls.length - list.length + i}`) };
  }) as SendFn;
  (fn as SendFn & { calls: typeof calls }).calls = calls;
  return fn as SendFn & { calls: typeof calls };
}

/**
 * P3-C4 — tiktok-post-poller. Drives the handler against dev-mongo with a
 * fake TikTokFetcher; verifies:
 *   · matched post → emits tiktok/post.detected (we count via the result),
 *   · age past NO_POST_TTL_DAYS with no match → track flipped to 'flaked',
 *   · post older than deliveredAt is NOT matched (no false positives from
 *     pre-delivery videos),
 *   · only the brief's hashtags drive the match (post without overlap is
 *     skipped).
 */

const brief: CampaignBrief = {
  workspaceId: "ws_poller",
  createdBy: "u".repeat(21),
  brandProduct: {
    name: "Hydra Serum",
    category: "skincare/serum",
    description: "수분 세럼",
    keyClaims: [],
  },
  targeting: {
    creatorCount: 1,
    minEngagementRate: 0.001,
    languages: ["ko"],
    hashtags: ["스킨케어", "kbeauty"],
    excludeBlacklist: true,
  },
  logistics: { shipsSamples: true },
  goals: { targetLivePosts: 1, deadline: new Date("2026-08-01") },
};

const creator: TikTokCreator = {
  id: "cr_freshly",
  uniqueId: "@freshly",
  nickname: "freshly",
  signature: "",
  verified: false,
  privateAccount: false,
  followerCount: 30_000,
  followingCount: 100,
  videoCount: 80,
  hashtags: [],
};

function trackOf(state: CreatorTrack["state"], lastActivityAt = new Date("2026-06-01")): CreatorTrack {
  return {
    creatorId: creator.id,
    stage: "content_review",
    state,
    lastActivityAt,
    emailsSent: 1,
  };
}

/**
 * Fake fetcher keyed by the TikTok @handle/uniqueId (which is what
 * `getUserPosts` actually receives — codex review P1#1). The keys MUST
 * match the uniqueId the poller resolves from accounts_tiktok.
 */
function fakeFetcher(byUniqueId: Record<string, TikTokPost[]>): TikTokFetcher & {
  uniqueIdCalls: string[];
} {
  const uniqueIdCalls: string[] = [];
  return {
    uniqueIdCalls,
    async getUserInfo(uniqueId: string) {
      return { id: "x", uniqueId, nickname: "x", followerCount: 0, followingCount: 0, videoCount: 0 } as RawCreator;
    },
    async getUserPosts(uniqueId: string) {
      uniqueIdCalls.push(uniqueId);
      return byUniqueId[uniqueId] ?? [];
    },
  };
}

function postOf(
  id: string,
  hashtags: string[],
  createdAt: Date,
  over: Partial<TikTokPost> = {},
): TikTokPost {
  return {
    id,
    desc: "Sample post description",
    hashtags,
    views: 1000,
    likes: 50,
    comments: 5,
    shares: 1,
    createdAt,
    ...over,
  };
}

beforeAll(() => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set — start scripts/dev-mongo first");
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.V2_CAMPAIGNS).deleteMany({});
  await db.collection(Collections.V2_SHIPMENTS).deleteMany({});
  await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).deleteMany({});
  // Seed the accounts_tiktok doc the poller looks up to resolve uniqueId
  // from creator.id (codex review P1#1).
  await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).insertOne({
    id: creator.id,
    uniqueId: creator.uniqueId,
    nickname: creator.nickname,
    signature: "",
    followerCount: creator.followerCount,
    followingCount: creator.followingCount,
    videoCount: creator.videoCount,
    hashtags: [],
    verified: false,
    privateAccount: false,
  });
});

afterAll(async () => { await closeMongo(); });

async function seedDeliveredTrack(opts: {
  deliveredAt: Date;
  trackLastActivityAt?: Date;
}): Promise<{ campaignId: string }> {
  const c = await campaignRepo.create({
    brief,
    status: "running",
    stage: "content_review",
    tracks: [trackOf("delivered", opts.trackLastActivityAt ?? opts.deliveredAt)],
  });
  // Seed the matching shipment row so the poller can read deliveredAt.
  await shipmentRepo.create({
    campaignId: c.id,
    creatorTrackId: `${c.id}:${creator.id}`,
    creatorId: creator.id,
    status: "delivered",
    carrier: "yuntrack",
    trackingNumber: "YT0001",
    shippingAddress: {
      recipientName: "x", phone: "", line1: "x", line2: "", city: "", region: "", postalCode: "", countryCode: "KR",
    },
    products: [{ sku: "x", name: "x", valueUsdCents: 0, weightGrams: 0 }],
    trackingEvents: [],
    notes: "",
    deliveredAt: opts.deliveredAt,
  });
  return { campaignId: c.id };
}

describe("tiktok-post-poller", () => {
  it("no delivered tracks → scanned=0; no events; no errors", async () => {
    const send = recordingSend();
    const out = await tiktokPostPollerHandler(fakeFetcher({}), send);
    expect(out).toEqual({ scanned: 0, detected: 0, flaked: 0, failures: [] });
    expect(send.calls).toHaveLength(0);
  });

  it("matched post (overlapping hashtag + after deliveredAt) → detected + tiktok/post.detected emitted", async () => {
    const delivered = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days ago
    await seedDeliveredTrack({ deliveredAt: delivered });
    const posts = [
      postOf("p1", ["스킨케어", "리뷰"], new Date(Date.now() - 1 * 24 * 60 * 60 * 1000)),
    ];
    const send = recordingSend();
    const out = await tiktokPostPollerHandler(fakeFetcher({ [creator.uniqueId]: posts }), send);
    expect(out.failures).toEqual([]);
    expect(out.scanned).toBe(1);
    expect(out.detected).toBe(1);
    expect(out.flaked).toBe(0);
    expect(send.calls).toHaveLength(1);
    expect(send.calls[0]?.name).toBe("tiktok/post.detected");
    expect(send.calls[0]?.data.postId).toBe("p1");
    expect((send.calls[0]?.data.matchedHashtags as string[])).toEqual(["스킨케어"]);
  });

  it("poller resolves uniqueId from accounts_tiktok before fetching (codex review P1#1)", async () => {
    const delivered = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await seedDeliveredTrack({ deliveredAt: delivered });
    const fetcher = fakeFetcher({
      [creator.uniqueId]: [
        postOf("p_ok", ["스킨케어"], new Date(Date.now() - 1 * 24 * 60 * 60 * 1000)),
      ],
    });
    const out = await tiktokPostPollerHandler(fetcher, recordingSend());
    expect(out.failures).toEqual([]);
    expect(out.detected).toBe(1);
    // CRITICAL: fetcher must have been called with the @handle/uniqueId,
    // NOT the internal creator.id. If the poller regresses to passing
    // creator.id, this assertion catches it.
    expect(fetcher.uniqueIdCalls).toEqual([creator.uniqueId]);
    expect(fetcher.uniqueIdCalls).not.toContain(creator.id);
  });

  it("creator missing from accounts_tiktok ⇒ recorded as failure (creator_not_found), no fetch, no flake", async () => {
    const delivered = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await seedDeliveredTrack({ deliveredAt: delivered });
    const db = await getDb();
    await db.collection(Collections.SHARED_TIKTOK_ACCOUNTS).deleteMany({});
    const fetcher = fakeFetcher({});
    const out = await tiktokPostPollerHandler(fetcher, recordingSend());
    expect(out.scanned).toBe(1);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]?.reason).toBe("creator_not_found_in_accounts_tiktok");
    expect(fetcher.uniqueIdCalls).toEqual([]);
  });

  it("post older than deliveredAt is NOT matched (defends against pre-delivery videos)", async () => {
    const delivered = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await seedDeliveredTrack({ deliveredAt: delivered });
    const posts = [
      // posted BEFORE we shipped → not from our seed
      postOf("p_old", ["스킨케어"], new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)),
    ];
    const send = recordingSend();
    const out = await tiktokPostPollerHandler(fakeFetcher({ [creator.uniqueId]: posts }), send);
    expect(out.detected).toBe(0);
  });

  it("post without overlapping hashtag is skipped (no false positive)", async () => {
    const delivered = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await seedDeliveredTrack({ deliveredAt: delivered });
    const posts = [
      postOf("p_unrelated", ["요리", "여행"], new Date(Date.now() - 1 * 24 * 60 * 60 * 1000)),
    ];
    const send = recordingSend();
    const out = await tiktokPostPollerHandler(fakeFetcher({ [creator.uniqueId]: posts }), send);
    expect(out.detected).toBe(0);
  });

  it("delivered > NO_POST_TTL_DAYS + no match ⇒ track flipped to 'flaked'", async () => {
    const delivered = new Date(Date.now() - (NO_POST_TTL_DAYS + 1) * 24 * 60 * 60 * 1000);
    const { campaignId } = await seedDeliveredTrack({ deliveredAt: delivered });
    const out = await tiktokPostPollerHandler(fakeFetcher({ [creator.id]: [] }));
    expect(out.flaked).toBe(1);
    const persisted = await campaignRepo.get(campaignId);
    expect(persisted?.tracks[0]?.state).toBe("flaked");
  });

  it("fetcher throw on one track ⇒ recorded in failures but doesn't kill the run", async () => {
    const delivered = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const { campaignId } = await seedDeliveredTrack({ deliveredAt: delivered });
    const fetcher: TikTokFetcher = {
      async getUserInfo() { throw new Error("not used"); },
      async getUserPosts() { throw new Error("rate_limit_hit"); },
    };
    const out = await tiktokPostPollerHandler(fetcher, recordingSend());
    expect(out.scanned).toBe(1);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toEqual({
      campaignId,
      creatorId: creator.id,
      reason: "rate_limit_hit",
    });
  });
});
