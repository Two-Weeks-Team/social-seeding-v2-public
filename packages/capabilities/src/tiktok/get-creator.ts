import { z } from "zod";
import { TikTokCreatorSchema } from "@ss/contracts";
import { Collections, getDb } from "@ss/db";
import { defineCapability } from "../registry";

/**
 * tiktok.getCreator — port of v1 `~/social-seeding/src/app/api/tiktok/userinfo`
 * + `userposts` + `lib/tiktok-mappers.ts`. Reads SHARED `accounts_tiktok`
 * first; if absent / stale (>24h, v1's policy) / forceRefresh, calls the
 * injectable `TikTokFetcher` (RapidAPI in prod, fake in tests) and additively
 * upserts the refresh. `withRecentPosts: true` adds a one-shot posts fetch
 * (no posts cache yet — that's Phase 2/3 work).
 *
 * The default fetcher is a stub that *throws* unless RAPIDAPI_KEY_TIKTOK is
 * set AND the actual RapidAPI client is wired in (Phase 1+ follow-up — see
 * docs/SCOPE-DECISIONS.md). For tests, inject a fake via
 * `setTikTokFetcher(fake)` — same pattern as `@ss/agents`' ModelClient seam.
 */

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const TikTokPostSchema = z.object({
  id: z.string(),
  desc: z.string(),
  hashtags: z.array(z.string()),
  views: z.number().int().nonnegative(),
  likes: z.number().int().nonnegative(),
  comments: z.number().int().nonnegative(),
  shares: z.number().int().nonnegative(),
  createdAt: z.coerce.date(),
});
export type TikTokPost = z.infer<typeof TikTokPostSchema>;

/** What we expect from a creator fetch (RapidAPI-shaped, but provider-agnostic). */
export interface RawCreator {
  id: string;
  uniqueId: string;
  nickname: string;
  signature?: string;
  followerCount: number;
  followingCount: number;
  videoCount: number;
  heartCount?: number;
  verified?: boolean;
  privateAccount?: boolean;
  avatarThumb?: string;
  avatarLarger?: string;
  hashtags?: string[];
  textLanguage?: string;
}

export interface TikTokFetcher {
  getUserInfo(uniqueId: string): Promise<RawCreator>;
  getUserPosts(uniqueId: string, limit?: number): Promise<TikTokPost[]>;
}

// ── RapidAPI defaults ──────────────────────────────────────────────────────
//
// Configurable via env so operators can swap providers without a code
// change. Defaults target tiktok-scraper7 which is one of the
// commonly-used RapidAPI TikTok scraping providers — covers user info
// + posts on a single host. v1 used its own Go-backend proxy + a key
// rotation pool; v2 uses the direct RapidAPI call (one provider, one
// key) for simplicity. Operators with a key pool can layer rotation
// at the network level (Cloudflare worker / etc) without touching
// this code.
const DEFAULT_RAPIDAPI_HOST = "tiktok-scraper7.p.rapidapi.com";
const DEFAULT_USERINFO_PATH = "/user/info";
const DEFAULT_USERPOSTS_PATH = "/user/posts";

interface RapidApiConfig {
  host: string;
  userInfoPath: string;
  userPostsPath: string;
  apiKey: string;
}

function rapidApiConfig(): RapidApiConfig | null {
  const apiKey = process.env.RAPIDAPI_KEY_TIKTOK;
  if (!apiKey) return null;
  return {
    apiKey,
    host: process.env.RAPIDAPI_TIKTOK_HOST ?? DEFAULT_RAPIDAPI_HOST,
    userInfoPath: process.env.RAPIDAPI_TIKTOK_USERINFO_PATH ?? DEFAULT_USERINFO_PATH,
    userPostsPath: process.env.RAPIDAPI_TIKTOK_USERPOSTS_PATH ?? DEFAULT_USERPOSTS_PATH,
  };
}

/**
 * RapidAPI provider response → TikTokPost normalization. Defensive
 * against shape drift across providers — tiktok-scraper7 nests under
 * `data.videos`; tiktok-scraper has `items`; some return a flat array.
 * Field-by-field defaulting so a missing count never throws Zod.
 *
 * Exported for unit testing the mapper without an HTTP round-trip.
 */
export function mapRapidApiPosts(raw: unknown): TikTokPost[] {
  const list = pickPostList(raw);
  const out: TikTokPost[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const id = pickFirstString(r, ["video_id", "aweme_id", "id", "videoId"]);
    if (!id) continue;
    const desc = pickFirstString(r, ["title", "desc", "description"]) ?? "";
    const views = pickFirstNumber(r, ["play_count", "playCount", "stats.playCount", "viewCount"]);
    const likes = pickFirstNumber(r, ["digg_count", "diggCount", "stats.diggCount", "likeCount"]);
    const comments = pickFirstNumber(r, ["comment_count", "commentCount", "stats.commentCount"]);
    const shares = pickFirstNumber(r, ["share_count", "shareCount", "stats.shareCount"]);
    const createTime = pickFirstNumber(r, ["create_time", "createTime", "createdAt", "publishTime"]);
    const createdAt = createTime > 1_000_000_000 // accept seconds (10-digit) or ms (13-digit)
      ? new Date(createTime > 1e12 ? createTime : createTime * 1000)
      : new Date();
    const hashtags = pickHashtags(r);
    out.push({ id, desc, hashtags, views, likes, comments, shares, createdAt });
  }
  return out;
}

function pickPostList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  const r = raw as Record<string, unknown>;
  const data = (r.data ?? r.result ?? r.response) as Record<string, unknown> | undefined;
  // Common shapes in priority order
  for (const key of ["videos", "items", "posts", "aweme_list", "list"]) {
    const top = r[key];
    if (Array.isArray(top)) return top;
    const nested = data?.[key];
    if (Array.isArray(nested)) return nested;
  }
  // Fallback: data is already the list (some providers return that).
  if (Array.isArray(data)) return data as unknown[];
  return [];
}

function pickFirstString(r: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = readPath(r, k);
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

function pickFirstNumber(r: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const v = readPath(r, k);
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) return Math.floor(n);
    }
  }
  return 0;
}

function pickHashtags(r: Record<string, unknown>): string[] {
  const raw = r.hashtags ?? r.textExtra ?? r.text_extra ?? r.challenges ?? [];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      if (item.length > 0) out.push(item.replace(/^#/, ""));
    } else if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const name = typeof obj.hashtagName === "string" ? obj.hashtagName
        : typeof obj.name === "string" ? obj.name
        : typeof obj.title === "string" ? obj.title : undefined;
      if (name) out.push(name.replace(/^#/, ""));
    }
  }
  // De-dupe + drop empties
  return [...new Set(out.filter(Boolean))];
}

function readPath(r: Record<string, unknown>, path: string): unknown {
  if (!path.includes(".")) return r[path];
  let cur: unknown = r;
  for (const seg of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * RapidAPI provider response → RawCreator normalization. Defensive
 * across provider shape drift; mirrors mapRapidApiPosts's posture.
 * Exported for unit testing.
 */
export function mapRapidApiCreator(raw: unknown): RawCreator | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  // Two common provider shapes for stats placement:
  //   (a) tiktok-scraper7: { data: { user: {...}, stats: {...} } }
  //                        — stats is SIBLING of user, both under data
  //   (b) tiktok-scraper:  { user: {..., stats: {...}} }
  //                        — stats is NESTED inside user
  //   (c) top-level:       { unique_id, follower_count, ... }
  //                        — everything flat
  // Walk candidate (user, parent) pairs so stats lookup checks both
  // the user object AND the doc one level up.
  const candidates: Array<{ user: Record<string, unknown>; parent: Record<string, unknown> }> = [];
  for (const path of ["data.user", "user", "result.user"]) {
    const u = pickObject(r, [path]);
    if (u) {
      const parentPath = path.split(".").slice(0, -1).join(".");
      const parent = parentPath ? pickObject(r, [parentPath]) ?? r : r;
      candidates.push({ user: u, parent });
    }
  }
  const flatData = pickObject(r, ["data", "result"]);
  if (flatData) candidates.push({ user: flatData, parent: r });
  candidates.push({ user: r, parent: r });

  for (const { user: o, parent } of candidates) {
    const uniqueId = pickString(o, ["unique_id", "uniqueId", "username", "handle"]);
    if (!uniqueId) continue;
    const stats =
      pickObject(o, ["stats", "statistics"]) ??
      pickObject(parent, ["stats", "statistics"]) ??
      o;
    const id = pickString(o, ["sec_uid", "secUid", "id", "user_id", "userId"]) ?? uniqueId;
    return {
      id,
      uniqueId,
      nickname: pickString(o, ["nickname", "display_name", "name"]) ?? uniqueId,
      signature: pickString(o, ["signature", "bio", "description"]) ?? "",
      followerCount: pickInt(stats, ["follower_count", "followerCount", "followers"]),
      followingCount: pickInt(stats, ["following_count", "followingCount", "following"]),
      videoCount: pickInt(stats, ["video_count", "videoCount", "videos"]),
      heartCount: pickInt(stats, ["heart_count", "heartCount", "hearts", "likes_count"]),
      verified: pickBool(o, ["verified", "is_verified"]),
      privateAccount: pickBool(o, ["private_account", "privateAccount", "secret"]),
      avatarThumb: pickString(o, ["avatar_thumb", "avatarThumb", "avatar"]),
      avatarLarger: pickString(o, ["avatar_larger", "avatarLarger", "avatar_full"]),
      hashtags: pickHashtagArray(o, ["hashtags", "tags"]),
      textLanguage: pickString(o, ["language", "lang", "text_language"]),
    };
  }
  return null;
}

function pickObject(r: Record<string, unknown>, paths: string[]): Record<string, unknown> | undefined {
  for (const p of paths) {
    const v = readPath(r, p);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  }
  return undefined;
}

function pickString(r: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = readPath(r, k);
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function pickInt(r: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const v = readPath(r, k);
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) return Math.floor(n);
    }
  }
  return 0;
}

function pickBool(r: Record<string, unknown>, keys: string[]): boolean {
  for (const k of keys) {
    const v = readPath(r, k);
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return v === "true" || v === "1" || v === "yes";
  }
  return false;
}

function pickHashtagArray(r: Record<string, unknown>, keys: string[]): string[] {
  for (const k of keys) {
    const v = readPath(r, k);
    if (Array.isArray(v)) {
      const out: string[] = [];
      for (const item of v) {
        if (typeof item === "string" && item.length > 0) out.push(item.replace(/^#/, ""));
        else if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          const name = typeof obj.name === "string" ? obj.name
            : typeof obj.hashtagName === "string" ? obj.hashtagName : undefined;
          if (name) out.push(name.replace(/^#/, ""));
        }
      }
      return [...new Set(out)];
    }
  }
  return [];
}

function defaultFetcher(): TikTokFetcher {
  return {
    async getUserInfo(uniqueId) {
      const cfg = rapidApiConfig();
      if (!cfg) {
        throw new Error(
          "RAPIDAPI_KEY_TIKTOK is not set — tiktok.getCreator needs it at runtime (tests should inject a fake via setTikTokFetcher)",
        );
      }
      const handle = uniqueId.replace(/^@/, "");
      const params = new URLSearchParams({ unique_id: handle });
      const url = `https://${cfg.host}${cfg.userInfoPath}?${params.toString()}`;
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "x-rapidapi-key": cfg.apiKey,
          "x-rapidapi-host": cfg.host,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        throw new Error(`tiktok.getUserInfo: RapidAPI returned ${res.status} for @${handle}`);
      }
      const body = (await res.json()) as unknown;
      const creator = mapRapidApiCreator(body);
      if (!creator) {
        throw new Error(`tiktok.getUserInfo: response for @${handle} had no usable user object`);
      }
      return creator;
    },
    async getUserPosts(uniqueId, limit) {
      const cfg = rapidApiConfig();
      if (!cfg) {
        throw new Error(
          "RAPIDAPI_KEY_TIKTOK is not set — tiktok.getCreator needs it at runtime (tests should inject a fake via setTikTokFetcher)",
        );
      }
      // Build the URL — `unique_id` is the standard query param across
      // tiktok-scraper7 + similar providers. `count` caps the result;
      // most providers default to 20-30 and max at 50.
      const handle = uniqueId.replace(/^@/, "");
      const params = new URLSearchParams({ unique_id: handle });
      if (typeof limit === "number" && limit > 0) {
        params.set("count", String(Math.min(limit, 50)));
      }
      const url = `https://${cfg.host}${cfg.userPostsPath}?${params.toString()}`;
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "x-rapidapi-key": cfg.apiKey,
          "x-rapidapi-host": cfg.host,
          accept: "application/json",
        },
        // RapidAPI is consistently slow under load — 15s is the v1 cap.
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        throw new Error(`tiktok.getUserPosts: RapidAPI returned ${res.status} for @${handle}`);
      }
      const body = (await res.json()) as unknown;
      return mapRapidApiPosts(body);
    },
  };
}

let _fetcher: TikTokFetcher | undefined;
export function getTikTokFetcher(): TikTokFetcher {
  return (_fetcher ??= defaultFetcher());
}
/** Pass `undefined` to reset to the default (RapidAPI-backed) fetcher. */
export function setTikTokFetcher(f: TikTokFetcher | undefined): void {
  _fetcher = f;
}

export const tiktokGetCreator = defineCapability({
  name: "tiktok.getCreator",
  description:
    "Get a TikTok creator profile and (optionally) their recent posts. Reads accounts_tiktok first; if stale (>24h) or absent, refreshes via the injected fetcher and upserts the refresh additively.",
  scope: "read",
  idempotent: true,
  rateLimitClass: "tiktok_read",
  input: z.object({
    uniqueId: z.string().min(1),
    withRecentPosts: z.boolean().default(true),
    forceRefresh: z.boolean().default(false),
  }),
  output: z.object({
    creator: TikTokCreatorSchema,
    recentPosts: z.array(TikTokPostSchema).default([]),
  }),
  async handler(input, _ctx) {
    const db = await getDb();
    const col = db.collection(Collections.SHARED_TIKTOK_ACCOUNTS);
    const cached = (await col.findOne({ uniqueId: input.uniqueId })) as
      | (RawCreator & { _id?: unknown; id?: string; updatedAt?: Date | string | number })
      | null;

    const updatedAtMs = cached?.updatedAt ? new Date(cached.updatedAt).getTime() : 0;
    const stale = !cached || input.forceRefresh || Date.now() - updatedAtMs > STALE_AFTER_MS;

    let creatorRaw: RawCreator;
    if (stale) {
      const fetcher = getTikTokFetcher();
      const fresh = await fetcher.getUserInfo(input.uniqueId);
      const now = new Date();
      // additive upsert: $set the fresh fields + updatedAt, keep any existing extras
      await col.updateOne({ uniqueId: input.uniqueId }, { $set: { ...fresh, updatedAt: now } }, { upsert: true });
      creatorRaw = { ...(cached as RawCreator | null ?? {}), ...fresh };
    } else {
      creatorRaw = cached;
    }

    const creator = TikTokCreatorSchema.parse({
      ...creatorRaw,
      id: typeof creatorRaw.id === "string" ? creatorRaw.id : (cached?._id?.toString?.() ?? creatorRaw.uniqueId),
    });

    let recentPosts: TikTokPost[] = [];
    if (input.withRecentPosts) {
      const fetcher = getTikTokFetcher();
      try {
        recentPosts = await fetcher.getUserPosts(input.uniqueId);
      } catch (err) {
        // Live-demo lesson 2026-05-14: vetting + post-poller both want
        // recent posts, but a missing RAPIDAPI_KEY_TIKTOK (or a 401 / 5xx
        // from the provider) shouldn't fail the entire vetting call.
        // The cached creator profile is enough for a coarse fitScore;
        // posts inform the engagement-rate refinement but vetting has
        // sensible defaults when posts are empty. Log + degrade.
        console.warn(
          `[tiktok.getCreator] getUserPosts failed for @${input.uniqueId} — proceeding without recent posts. ` +
          `(error: ${err instanceof Error ? err.message : String(err)})`,
        );
        recentPosts = [];
      }
    }

    return { creator, recentPosts };
  },
});
