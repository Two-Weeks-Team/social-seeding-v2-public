import { afterEach, describe, expect, it, vi } from "vitest";
import { mapRapidApiCreator, setTikTokFetcher, getTikTokFetcher } from "./get-creator";

/**
 * Carry-over completion — defaultFetcher.getUserInfo wired against
 * RapidAPI. Tests cover the response mapper (provider shape drift)
 * + env-key guard + happy-path HTTP. The injected-fake path used by
 * tiktok.getCreator.test.ts is unchanged.
 */

afterEach(() => {
  setTikTokFetcher(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("mapRapidApiCreator — defensive shape normalization", () => {
  it("tiktok-scraper7 shape: { data: { user: {...}, stats: {...} } }", () => {
    const raw = {
      data: {
        user: {
          sec_uid: "MS4wLjABAAAAFakeSec",
          unique_id: "freshly",
          nickname: "Freshly",
          signature: "k-beauty / 수분",
          verified: false,
          private_account: false,
          avatar_thumb: "https://x.com/a-thumb.jpg",
          avatar_larger: "https://x.com/a-large.jpg",
          language: "ko",
        },
        stats: {
          follower_count: 42_000,
          following_count: 110,
          video_count: 80,
          heart_count: 1_500_000,
        },
      },
    };
    const out = mapRapidApiCreator(raw);
    expect(out).toMatchObject({
      id: "MS4wLjABAAAAFakeSec",
      uniqueId: "freshly",
      nickname: "Freshly",
      signature: "k-beauty / 수분",
      followerCount: 42_000,
      followingCount: 110,
      videoCount: 80,
      heartCount: 1_500_000,
      verified: false,
      privateAccount: false,
      textLanguage: "ko",
    });
  });

  it("top-level shape (no data nesting): {unique_id, follower_count, …}", () => {
    const out = mapRapidApiCreator({
      unique_id: "@dewy",
      nickname: "Dewy",
      follower_count: 5_000,
      video_count: 20,
    });
    expect(out).toMatchObject({ uniqueId: "@dewy", followerCount: 5_000, videoCount: 20 });
  });

  it("camelCase shape (tiktok-scraper variant): {uniqueId, followerCount, …}", () => {
    const out = mapRapidApiCreator({
      data: { user: { uniqueId: "glow", nickname: "Glow", id: "u_glow", verified: true } },
    });
    expect(out).toMatchObject({ id: "u_glow", uniqueId: "glow", verified: true });
  });

  it("hashtags array: strings + objects + mixed, deduped + #-stripped", () => {
    const out = mapRapidApiCreator({
      data: { user: {
        unique_id: "h", nickname: "H",
        hashtags: ["스킨케어", { name: "kbeauty" }, "#스킨케어", { hashtagName: "수분세럼" }],
      }, stats: {} },
    });
    expect(out?.hashtags).toEqual(["스킨케어", "kbeauty", "수분세럼"]);
  });

  it("missing required uniqueId → null (no usable user)", () => {
    expect(mapRapidApiCreator({ data: { user: { nickname: "ghost" } } })).toBeNull();
    expect(mapRapidApiCreator({})).toBeNull();
    expect(mapRapidApiCreator(null)).toBeNull();
    expect(mapRapidApiCreator("string")).toBeNull();
  });

  it("string-number stats (some providers stringify) coerced to int", () => {
    const out = mapRapidApiCreator({
      data: { user: { unique_id: "x", nickname: "X" }, stats: { follower_count: "12345", heart_count: "999999" } },
    });
    expect(out?.followerCount).toBe(12_345);
    expect(out?.heartCount).toBe(999_999);
  });

  it("verified as 1/0 number, 'true' string → coerced", () => {
    expect(mapRapidApiCreator({ data: { user: { unique_id: "a", nickname: "A", verified: 1 } } })?.verified).toBe(true);
    expect(mapRapidApiCreator({ data: { user: { unique_id: "a", nickname: "A", verified: "true" } } })?.verified).toBe(true);
    expect(mapRapidApiCreator({ data: { user: { unique_id: "a", nickname: "A", verified: 0 } } })?.verified).toBe(false);
  });

  it("fields default sanely when absent", () => {
    const out = mapRapidApiCreator({ data: { user: { unique_id: "min", nickname: "" } } });
    expect(out).toMatchObject({
      id: "min", // falls back to uniqueId when no sec_uid
      uniqueId: "min",
      nickname: "min", // empty string falls through to fallback
      signature: "",
      followerCount: 0,
      followingCount: 0,
      videoCount: 0,
      heartCount: 0,
      verified: false,
      privateAccount: false,
      hashtags: [],
    });
  });
});

describe("defaultFetcher.getUserInfo — env + HTTP path", () => {
  it("throws clearly when RAPIDAPI_KEY_TIKTOK is unset", async () => {
    vi.stubEnv("RAPIDAPI_KEY_TIKTOK", "");
    setTikTokFetcher(undefined);
    await expect(getTikTokFetcher().getUserInfo("@freshly")).rejects.toThrow(/RAPIDAPI_KEY_TIKTOK is not set/);
  });

  it("happy path: builds the right URL + headers + maps the response", async () => {
    vi.stubEnv("RAPIDAPI_KEY_TIKTOK", "test_key_xxx");
    vi.stubEnv("RAPIDAPI_TIKTOK_HOST", "tiktok-scraper7.p.rapidapi.com");
    vi.stubEnv("RAPIDAPI_TIKTOK_USERINFO_PATH", "/user/info");
    setTikTokFetcher(undefined);
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({
        data: {
          user: { unique_id: "freshly", nickname: "Freshly", sec_uid: "u_fresh", verified: true },
          stats: { follower_count: 42_000, video_count: 80, heart_count: 1_500_000 },
        },
      }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchSpy);
    const out = await getTikTokFetcher().getUserInfo("@freshly");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [calledUrl, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toMatch(/^https:\/\/tiktok-scraper7\.p\.rapidapi\.com\/user\/info\?/);
    expect(calledUrl).toContain("unique_id=freshly"); // @-stripped
    expect((init.headers as Record<string, string>)["x-rapidapi-key"]).toBe("test_key_xxx");
    expect(out).toMatchObject({
      id: "u_fresh", uniqueId: "freshly", followerCount: 42_000, verified: true,
    });
  });

  it("RapidAPI returns non-2xx → throws with the status code", async () => {
    vi.stubEnv("RAPIDAPI_KEY_TIKTOK", "test_key_xxx");
    setTikTokFetcher(undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    await expect(getTikTokFetcher().getUserInfo("@ghost"))
      .rejects.toThrow(/RapidAPI returned 404/);
  });

  it("response with no user object → throws clearly (mapper returned null)", async () => {
    vi.stubEnv("RAPIDAPI_KEY_TIKTOK", "test_key_xxx");
    setTikTokFetcher(undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 })));
    await expect(getTikTokFetcher().getUserInfo("@empty"))
      .rejects.toThrow(/no usable user object/);
  });
});
