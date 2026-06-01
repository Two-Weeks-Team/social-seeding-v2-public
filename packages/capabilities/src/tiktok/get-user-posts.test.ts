import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapRapidApiPosts, resetBackendKeyCache, setTikTokFetcher, getTikTokFetcher } from "./get-creator";

/**
 * Phase 6 carry-over — defaultFetcher.getUserPosts now lives wired against
 * RapidAPI. These tests cover the response mapper (pure, no fetch) +
 * the env-key guard (no key → clear throw) + a stubbed live-fetch path
 * (vi.stubGlobal on fetch). The injected-fake path the rest of the
 * suite uses is unchanged — only the production default factory is new.
 */

afterEach(() => {
  setTikTokFetcher(undefined);
  resetBackendKeyCache();
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

describe("defaultFetcher.getUserPosts — backend.socialseed.ing proxy path", () => {
  it("throws clearly when no static key AND no /auth/login credentials", async () => {
    vi.stubEnv("SS_BACKEND_API_KEY", "");
    vi.stubEnv("BACKEND_DASHBOARD_EMAIL", "");
    vi.stubEnv("BACKEND_DASHBOARD_PASSWORD", "");
    resetBackendKeyCache();
    setTikTokFetcher(undefined);
    const fetcher = getTikTokFetcher();
    await expect(fetcher.getUserPosts("@freshly")).rejects.toThrow(/SS_BACKEND_API_KEY unset and BACKEND_DASHBOARD_EMAIL/);
  });

  it("X-API-Key rotation: caches the minted key (one /auth/login for two calls)", async () => {
    vi.stubEnv("SS_BACKEND_API_KEY", "");
    vi.stubEnv("BACKEND_DASHBOARD_EMAIL", "ops@2weeks.co");
    vi.stubEnv("BACKEND_DASHBOARD_PASSWORD", "pw");
    resetBackendKeyCache();
    setTikTokFetcher(undefined);
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/login")) {
        return new Response(JSON.stringify({ success: true, api_key: "rk", api_key_expires_at: new Date(Date.now() + 30 * 60_000).toISOString() }), { status: 200 });
      }
      return new Response(JSON.stringify({ posts: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
    await getTikTokFetcher().getUserPosts("@a");
    await getTikTokFetcher().getUserPosts("@b");
    const loginCalls = (fetchSpy.mock.calls as unknown as Array<[string]>).filter(([u]) => u.endsWith("/auth/login"));
    expect(loginCalls).toHaveLength(1); // key cached across the two fetches
  });

  it("happy path: hits {BASE}/api/v1/user/posts?uniqueId=&preferRapidAPI=true with X-API-Key + maps", async () => {
    vi.stubEnv("SS_BACKEND_API_KEY", "test_key_xxx");
    vi.stubEnv("SS_BACKEND_URL", "https://backend.socialseed.ing");
    setTikTokFetcher(undefined);
    const fetchSpy = vi.fn(async () => new Response(
      // backend.socialseed.ing normalized shape: { posts: [{ id, desc, stats:{...}, createTime }] }
      JSON.stringify({ posts: [{ id: "v1", desc: "x", stats: { playCount: 100, diggCount: 5 }, createTime: 1700000000 }], postsCount: 1 }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchSpy);
    const out = await getTikTokFetcher().getUserPosts("@freshly", 10);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [calledUrl, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toMatch(/^https:\/\/backend\.socialseed\.ing\/api\/v1\/user\/posts\?/);
    expect(calledUrl).toContain("uniqueId=freshly"); // @-stripped
    expect(calledUrl).toContain("preferRapidAPI=true");
    expect(calledUrl).toContain("count=10");
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("test_key_xxx");
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("v1");
    expect(out[0]?.views).toBe(100);
  });

  it("caps limit at 50 (provider max; defensive against caller mistake)", async () => {
    vi.stubEnv("SS_BACKEND_API_KEY", "test_key_xxx");
    setTikTokFetcher(undefined);
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ posts: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await getTikTokFetcher().getUserPosts("@freshly", 9999);
    const [calledUrl] = fetchSpy.mock.calls[0] as unknown as [string];
    expect(calledUrl).toContain("count=50");
    expect(calledUrl).not.toContain("count=9999");
  });

  it("backend returns non-2xx → throws with the status code visible", async () => {
    vi.stubEnv("SS_BACKEND_API_KEY", "test_key_xxx");
    setTikTokFetcher(undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));
    await expect(getTikTokFetcher().getUserPosts("@freshly"))
      .rejects.toThrow(/backend proxy returned 429/);
  });

  it("SS_BACKEND_URL override honored (e.g. internal :8080)", async () => {
    vi.stubEnv("SS_BACKEND_API_KEY", "test_key_xxx");
    vi.stubEnv("SS_BACKEND_URL", "http://127.0.0.1:8080");
    setTikTokFetcher(undefined);
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ posts: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await getTikTokFetcher().getUserPosts("@x");
    const [calledUrl, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toMatch(/^http:\/\/127\.0\.0\.1:8080\/api\/v1\/user\/posts\?/);
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("test_key_xxx");
  });
});

// Reset the singleton at the end of the file so other suites in the same
// process (that may inject their own fakes earlier) aren't affected.
beforeEach(() => setTikTokFetcher(undefined));
