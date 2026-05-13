import { describe, expect, it } from "vitest";
import type { TikTokCreator, CampaignBrief } from "@ss/contracts";
import { outreachExtractFacts } from "./extract-facts";

/**
 * P2-C3a — outreach.extractFacts. Pure capability, no Mongo. Verifies the
 * closed fact-set contract the Outreach Writer agent depends on.
 */

const ctx = { workspaceId: "ws", userId: "u".repeat(21), rateLimitClass: "default" as const };

const brief: CampaignBrief = {
  workspaceId: "ws",
  createdBy: "u".repeat(21),
  brandProduct: {
    name: "Hydra Serum",
    category: "skincare/serum",
    description: "수분 세럼",
    keyClaims: ["7-day hydration", "fragrance-free"],
  },
  targeting: {
    creatorCount: 3,
    minEngagementRate: 0.02,
    languages: ["ko"],
    hashtags: ["스킨케어"],
    excludeBlacklist: true,
  },
  logistics: { shipsSamples: true },
  goals: { targetLivePosts: 3, deadline: new Date("2026-08-01") },
};

function makeCreator(over: Partial<TikTokCreator> = {}): TikTokCreator {
  return {
    id: "id_freshly",
    uniqueId: "@freshly",
    nickname: "freshly",
    signature: "k-beauty / 수분",
    verified: false,
    privateAccount: false,
    followerCount: 42_000,
    followingCount: 110,
    videoCount: 80,
    heartCount: 1_500_000,
    hashtags: ["스킨케어"],
    ...over,
  };
}

describe("outreach.extractFacts", () => {
  it("happy path: creator + brief → grounded facts with topHashtags + post themes", async () => {
    const out = await outreachExtractFacts.handler(
      {
        brief,
        creator: makeCreator(),
        recentPosts: [
          { desc: "수분 한 방울로 톡톡. 진짜 흡수 빠름.", hashtags: ["스킨케어", "수분"] },
          { desc: "겨울 보습 루틴 공유합니다! #스킨케어 #건성피부", hashtags: ["건성피부"] },
        ],
        avgViews: 18_400,
        engagementRate: 0.034,
      },
      ctx,
    );
    expect(out.creator.uniqueId).toBe("@freshly");
    expect(out.creator.signature).toBe("k-beauty / 수분");
    expect(out.creator.followerCount).toBe(42_000);
    expect(out.creator.avgViews).toBe(18_400);
    expect(out.creator.engagementRate).toBe(0.034);
    expect(out.creator.topHashtags).toEqual(["스킨케어", "수분", "건성피부"]);
    expect(out.creator.recentPostThemes).toEqual([
      "수분 한 방울로 톡톡",
      "겨울 보습 루틴 공유합니다",
    ]);
    expect(out.brand.name).toBe("Hydra Serum");
    expect(out.brand.keyClaims).toEqual(["7-day hydration", "fragrance-free"]);
    expect(out.logistics.shipsSamples).toBe(true);
    expect(out.hasMinimumContext).toBe(true);
  });

  it("topHashtags: dedupes profile ∪ recent posts, strips leading '#', caps at 5", async () => {
    const out = await outreachExtractFacts.handler(
      {
        brief,
        creator: makeCreator({ hashtags: ["스킨케어", "kbeauty"] }),
        recentPosts: [
          { desc: "x", hashtags: ["#kbeauty", "수분", "글로우", "리뷰", "할인", "추천"] },
        ],
      },
      ctx,
    );
    expect(out.creator.topHashtags).toHaveLength(5);
    // profile order first, then new ones from posts (deduped)
    expect(out.creator.topHashtags[0]).toBe("스킨케어");
    expect(out.creator.topHashtags).not.toContain("#kbeauty"); // hash stripped
    expect(out.creator.topHashtags).toContain("kbeauty");
  });

  it("recentPostThemes: first clause per post, hashtag strip, dedupe, capped at 3", async () => {
    const out = await outreachExtractFacts.handler(
      {
        brief,
        creator: makeCreator(),
        recentPosts: [
          { desc: "겨울철 보습 루틴! #스킨케어 / 한 번 발라보세요.", hashtags: [] },
          { desc: "겨울철 보습 루틴! 또 올림.", hashtags: [] }, // dup first clause
          { desc: "신상 세럼 후기. 발림성 만족.", hashtags: [] },
          { desc: "비밀의 토너 #스킨케어 추천!", hashtags: [] },
          { desc: "이건 캡 때문에 안 보일 거임.", hashtags: [] }, // capped out by max 3
        ],
      },
      ctx,
    );
    expect(out.creator.recentPostThemes).toEqual([
      "겨울철 보습 루틴",
      "신상 세럼 후기",
      "비밀의 토너 추천", // hashtag stripped + whitespace normalized
    ]);
  });

  it("themes longer than 60 chars are truncated with an ellipsis", async () => {
    // ~80 ASCII characters with no clause break → must get truncated.
    const long =
      "this is a single very long sentence without any internal punctuation that should easily exceed the sixty-character cap";
    const out = await outreachExtractFacts.handler(
      { brief, creator: makeCreator(), recentPosts: [{ desc: long, hashtags: [] }] },
      ctx,
    );
    const theme = out.creator.recentPostThemes[0]!;
    expect(theme.length).toBeLessThanOrEqual(60);
    expect(theme.endsWith("…")).toBe(true);
  });

  it("hasMinimumContext=false when signature is empty AND no post themes (escalation signal)", async () => {
    const out = await outreachExtractFacts.handler(
      {
        brief,
        creator: makeCreator({ signature: "", hashtags: [] }),
        recentPosts: [],
      },
      ctx,
    );
    expect(out.hasMinimumContext).toBe(false);
    expect(out.creator.topHashtags).toEqual([]);
    expect(out.creator.recentPostThemes).toEqual([]);
  });

  it("hasMinimumContext=true with empty signature but at least one recent post theme", async () => {
    const out = await outreachExtractFacts.handler(
      {
        brief,
        creator: makeCreator({ signature: "" }),
        recentPosts: [{ desc: "오늘은 글로우 메이크업.", hashtags: [] }],
      },
      ctx,
    );
    expect(out.hasMinimumContext).toBe(true);
  });

  it("omits avgViews / engagementRate from facts when caller didn't pass them", async () => {
    const out = await outreachExtractFacts.handler(
      { brief, creator: makeCreator(), recentPosts: [] },
      ctx,
    );
    expect(out.creator.avgViews).toBeUndefined();
    expect(out.creator.engagementRate).toBeUndefined();
  });
});
