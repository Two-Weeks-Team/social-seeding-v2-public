import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapRapidApiPosts, setTikTokFetcher, getTikTokFetcher } from "./get-creator";

/**
 * Phase 6 carry-over — defaultFetcher.getUserPosts now lives wired against
 * RapidAPI. These tests cover the response mapper (pure, no fetch) +
 * the env-key guard (no key → clear throw) + a stubbed live-fetch path
 * (vi.stubGlobal on fetch). The injected-fake path the rest of the
 * suite uses is unchanged — only the production default factory is new.
 */

afterEach(() => {
  setTikTokFetcher(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("mapRapidApiPosts — defensive shape normalization", () => {
  it("tiktok-scraper7 shape: { data: { videos: [...] } }", () => {
    const raw = {
      data: {
        videos: [
          {
            video_id: "v1",
            title: "수분 세럼 후기 #스킨케어",
            play_count: 22_000,
            digg_count: 1_800,
            comment_count: 120,
            share_count: 60,
            create_time: 1717000000, // unix seconds
            hashtags: [{ hashtagName: "스킨케어" }, { hashtagName: "수분세럼" }],
          },
        ],
      },
    };
    const out = mapRapidApiPosts(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "v1",
      desc: "수분 세럼 후기 #스킨케어",
      views: 22_000, likes: 1_800, comments: 120, shares: 60,
      hashtags: ["스킨케어", "수분세럼"],
    });
    expect(out[0]?.createdAt).toBeInstanceOf(Date);
    // seconds → 2024-05-29 -ish
    expect(out[0]?.createdAt.getUTCFullYear()).toBe(2024);
  });

  it("flat array shape: [post, post, …]", () => {
    const out = mapRapidApiPosts([
      { id: "f1", desc: "hello", play_count: 100, digg_count: 5, comment_count: 1, share_count: 0, create_time: 1700000000 },
      { id: "f2", desc: "world", play_count: 200, digg_count: 10, comment_count: 2, share_count: 1, create_time: 1700001000 },
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((p) => p.id)).toEqual(["f1", "f2"]);
  });

  it("alternate shape: { items: [...] } at top level", () => {
    const out = mapRapidApiPosts({
      items: [
        { aweme_id: "a1", desc: "x", playCount: 50, diggCount: 0, commentCount: 0, shareCount: 0, createTime: 1700000000 },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("a1");
    expect(out[0]?.views).toBe(50);
  });

  it("nested stats object: { stats: { playCount, diggCount, ... } }", () => {
    const out = mapRapidApiPosts({
      data: {
        videos: [
          { video_id: "n1", desc: "x", stats: { playCount: 999, diggCount: 50, commentCount: 5, shareCount: 2 }, create_time: 1700000000 },
        ],
      },
    });
    expect(out[0]).toMatchObject({ id: "n1", views: 999, likes: 50, comments: 5, shares: 2 });
  });

  it("ms-precision timestamps (13 digits) — uses as-is", () => {
    const out = mapRapidApiPosts({
      videos: [{ video_id: "ms1", desc: "x", play_count: 1, create_time: 1717000000000 }],
    });
    expect(out[0]?.createdAt.getTime()).toBe(1717000000000);
  });

  it("missing fields default to 0 / [] — never throws", () => {
    const out = mapRapidApiPosts({ videos: [{ video_id: "min1" }] });
    expect(out[0]).toMatchObject({ id: "min1", desc: "", views: 0, likes: 0, comments: 0, shares: 0, hashtags: [] });
    expect(out[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("hashtags strings vs objects vs mixed — normalized + #-prefix stripped + deduped", () => {
    const out = mapRapidApiPosts({
      videos: [{
        video_id: "h1", desc: "x", create_time: 1700000000,
        hashtags: [
          "스킨케어",
          { hashtagName: "수분세럼" },
          { name: "kbeauty" },
          "#스킨케어", // duplicate after #-strip
          { title: "" }, // dropped
        ],
      }],
    });
    expect(out[0]?.hashtags).toEqual(["스킨케어", "수분세럼", "kbeauty"]);
  });

  it("garbage in → empty array (no throw)", () => {
    expect(mapRapidApiPosts(null)).toEqual([]);
    expect(mapRapidApiPosts("string")).toEqual([]);
    expect(mapRapidApiPosts({})).toEqual([]);
    expect(mapRapidApiPosts({ data: "wrong" })).toEqual([]);
    // posts with no id are dropped
    expect(mapRapidApiPosts({ videos: [{ desc: "no_id" }] })).toEqual([]);
  });

  it("string-number views (some providers stringify) → coerced to int", () => {
    const out = mapRapidApiPosts({
      videos: [{ video_id: "s1", desc: "x", play_count: "22000", digg_count: "1800", create_time: 1700000000 }],
    });
    expect(out[0]).toMatchObject({ id: "s1", views: 22000, likes: 1800 });
  });
});

describe("defaultFetcher.getUserPosts — env + HTTP path", () => {
  it("throws clearly when RAPIDAPI_KEY_TIKTOK is unset", async () => {
    vi.stubEnv("RAPIDAPI_KEY_TIKTOK", "");
    setTikTokFetcher(undefined);
    const fetcher = getTikTokFetcher();
    await expect(fetcher.getUserPosts("@freshly")).rejects.toThrow(/RAPIDAPI_KEY_TIKTOK is not set/);
  });

  it("happy path: builds the right URL + headers + maps the response", async () => {
    vi.stubEnv("RAPIDAPI_KEY_TIKTOK", "test_key_xxx");
    vi.stubEnv("RAPIDAPI_TIKTOK_HOST", "tiktok-scraper7.p.rapidapi.com");
    vi.stubEnv("RAPIDAPI_TIKTOK_USERPOSTS_PATH", "/user/posts");
    setTikTokFetcher(undefined);
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ data: { videos: [{ video_id: "v1", desc: "x", play_count: 100, digg_count: 5, create_time: 1700000000 }] } }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchSpy);
    const out = await getTikTokFetcher().getUserPosts("@freshly", 10);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [calledUrl, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toMatch(/^https:\/\/tiktok-scraper7\.p\.rapidapi\.com\/user\/posts\?/);
    expect(calledUrl).toContain("unique_id=freshly"); // @-stripped
    expect(calledUrl).toContain("count=10");
    expect((init.headers as Record<string, string>)["x-rapidapi-key"]).toBe("test_key_xxx");
    expect((init.headers as Record<string, string>)["x-rapidapi-host"]).toBe("tiktok-scraper7.p.rapidapi.com");
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("v1");
  });

  it("caps limit at 50 (provider max; defensive against caller mistake)", async () => {
    vi.stubEnv("RAPIDAPI_KEY_TIKTOK", "test_key_xxx");
    setTikTokFetcher(undefined);
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: { videos: [] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await getTikTokFetcher().getUserPosts("@freshly", 9999);
    const [calledUrl] = fetchSpy.mock.calls[0] as unknown as [string];
    expect(calledUrl).toContain("count=50");
    expect(calledUrl).not.toContain("count=9999");
  });

  it("RapidAPI returns non-2xx → throws with the status code visible", async () => {
    vi.stubEnv("RAPIDAPI_KEY_TIKTOK", "test_key_xxx");
    setTikTokFetcher(undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));
    await expect(getTikTokFetcher().getUserPosts("@freshly"))
      .rejects.toThrow(/RapidAPI returned 429/);
  });

  it("RAPIDAPI_TIKTOK_HOST + USERPOSTS_PATH env overrides honored", async () => {
    vi.stubEnv("RAPIDAPI_KEY_TIKTOK", "test_key_xxx");
    vi.stubEnv("RAPIDAPI_TIKTOK_HOST", "custom-tiktok.example.com");
    vi.stubEnv("RAPIDAPI_TIKTOK_USERPOSTS_PATH", "/v2/posts");
    setTikTokFetcher(undefined);
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: { videos: [] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await getTikTokFetcher().getUserPosts("@x");
    const [calledUrl, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toMatch(/^https:\/\/custom-tiktok\.example\.com\/v2\/posts\?/);
    expect((init.headers as Record<string, string>)["x-rapidapi-host"]).toBe("custom-tiktok.example.com");
  });
});

// Reset the singleton at the end of the file so other suites in the same
// process (that may inject their own fakes earlier) aren't affected.
beforeEach(() => setTikTokFetcher(undefined));
