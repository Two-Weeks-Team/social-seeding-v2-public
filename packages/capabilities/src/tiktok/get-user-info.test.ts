import { afterEach, describe, expect, it, vi } from "vitest";
import { mapRapidApiCreator, resetBackendKeyCache, setTikTokFetcher, getTikTokFetcher } from "./get-creator";

/**
 * Carry-over completion — defaultFetcher.getUserInfo wired against
 * RapidAPI. Tests cover the response mapper (provider shape drift)
 * + env-key guard + happy-path HTTP. The injected-fake path used by
 * tiktok.getCreator.test.ts is unchanged.
 */

afterEach(() => {
  setTikTokFetcher(undefined);
  resetBackendKeyCache();
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

  it("backend.socialseed.ing real shape: { userInfo: { user, stats } } (verified live 2026-06-01)", () => {
    const out = mapRapidApiCreator({
      lastUpdated: "2026-06-01T05:00:00Z",
      source: "rapidapi",
      userInfo: {
        user: { uniqueId: "lizethhv2", id: "6524791681676481551", nickname: "Lizeth HV", secUid: "MS4wLjABAA", verified: false },
        stats: { followerCount: 1_300_000, followingCount: 200, videoCount: 2_230, heartCount: 47_600_000 },
      },
    });
    expect(out).toMatchObject({
      id: "MS4wLjABAA", // secUid wins for id
      uniqueId: "lizethhv2",
      nickname: "Lizeth HV",
      followerCount: 1_300_000,
      videoCount: 2_230,
      heartCount: 47_600_000,
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

describe("defaultFetcher.getUserInfo — backend.socialseed.ing proxy path", () => {
  it("throws clearly when no static key AND no /auth/login credentials", async () => {
    vi.stubEnv("SS_BACKEND_API_KEY", "");
    vi.stubEnv("BACKEND_DASHBOARD_EMAIL", "");
    vi.stubEnv("BACKEND_DASHBOARD_PASSWORD", "");
    resetBackendKeyCache();
    setTikTokFetcher(undefined);
    await expect(getTikTokFetcher().getUserInfo("@freshly"))
      .rejects.toThrow(/SS_BACKEND_API_KEY unset and BACKEND_DASHBOARD_EMAIL/);
  });

  it("X-API-Key rotation: no static key → mints via POST /auth/login, then calls user/info", async () => {
    vi.stubEnv("SS_BACKEND_API_KEY", "");
    vi.stubEnv("SS_BACKEND_URL", "https://backend.socialseed.ing");
    vi.stubEnv("BACKEND_DASHBOARD_EMAIL", "ops@2weeks.co");
    vi.stubEnv("BACKEND_DASHBOARD_PASSWORD", "pw");
    resetBackendKeyCache();
    setTikTokFetcher(undefined);
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/login")) {
        return new Response(JSON.stringify({ success: true, api_key: "rotated_key_abc", api_key_expires_at: new Date(Date.now() + 30 * 60_000).toISOString() }), { status: 200 });
      }
      return new Response(JSON.stringify({ user: { uniqueId: "freshly", nickname: "F" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
    await getTikTokFetcher().getUserInfo("@freshly");
    const calls = fetchSpy.mock.calls as unknown as Array<[string, RequestInit]>;
    // first call = login (POST), second = user/info with the minted key
    expect(calls[0]?.[0]).toBe("https://backend.socialseed.ing/auth/login");
    expect(calls[0]?.[1]?.method).toBe("POST");
    const infoCall = calls.find(([u]) => u.includes("/api/v1/user/info"));
    expect((infoCall?.[1].headers as Record<string, string>)["X-API-Key"]).toBe("rotated_key_abc");
  });

  it("happy path: hits {BASE}/api/v1/user/info?uniqueId= with X-API-Key + maps the response", async () => {
    vi.stubEnv("SS_BACKEND_API_KEY", "test_key_xxx");
    vi.stubEnv("SS_BACKEND_URL", "https://backend.socialseed.ing");
    setTikTokFetcher(undefined);
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({
        // backend.socialseed.ing normalizes to camelCase { user, stats }
        user: { uniqueId: "freshly", nickname: "Freshly", secUid: "u_fresh", verified: true },
        stats: { followerCount: 42_000, videoCount: 80, heartCount: 1_500_000 },
      }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchSpy);
    const out = await getTikTokFetcher().getUserInfo("@freshly");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [calledUrl, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toMatch(/^https:\/\/backend\.socialseed\.ing\/api\/v1\/user\/info\?/);
    expect(calledUrl).toContain("uniqueId=freshly"); // @-stripped
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("test_key_xxx");
    expect(out).toMatchObject({
      id: "u_fresh", uniqueId: "freshly", followerCount: 42_000, verified: true,
    });
  });

  it("SS_BACKEND_URL override honored (trailing slash trimmed)", async () => {
    vi.stubEnv("SS_BACKEND_API_KEY", "k");
    vi.stubEnv("SS_BACKEND_URL", "http://127.0.0.1:8080/");
    setTikTokFetcher(undefined);
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ user: { uniqueId: "x", nickname: "X" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await getTikTokFetcher().getUserInfo("@x");
    const [calledUrl] = fetchSpy.mock.calls[0] as unknown as [string];
    expect(calledUrl).toMatch(/^http:\/\/127\.0\.0\.1:8080\/api\/v1\/user\/info\?/);
  });

  it("backend returns non-2xx → throws with the status code", async () => {
    vi.stubEnv("SS_BACKEND_API_KEY", "test_key_xxx");
    setTikTokFetcher(undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    await expect(getTikTokFetcher().getUserInfo("@ghost"))
      .rejects.toThrow(/backend\.socialseed\.ing returned 404/);
  });

  it("response with no user object → throws clearly (mapper returned null)", async () => {
    vi.stubEnv("SS_BACKEND_API_KEY", "test_key_xxx");
    setTikTokFetcher(undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 })));
    await expect(getTikTokFetcher().getUserInfo("@empty"))
      .rejects.toThrow(/no usable user object/);
  });
});
