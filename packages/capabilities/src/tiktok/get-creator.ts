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

function defaultFetcher(): TikTokFetcher {
  const requireKey = (): string => {
    const k = process.env.RAPIDAPI_KEY_TIKTOK;
    if (!k) {
      throw new Error(
        "RAPIDAPI_KEY_TIKTOK is not set — tiktok.getCreator needs it at runtime (tests should inject a fake via setTikTokFetcher)",
      );
    }
    return k;
  };
  return {
    async getUserInfo(_uniqueId) {
      requireKey();
      // TODO(phase-1+): port v1 src/app/api/tiktok/userinfo + lib/api-key-rotation.ts (key pool, 3-tier fallback).
      throw new Error("defaultFetcher.getUserInfo not yet wired to RapidAPI (Phase-1 follow-up)");
    },
    async getUserPosts(_uniqueId, _limit) {
      requireKey();
      throw new Error("defaultFetcher.getUserPosts not yet wired to RapidAPI (Phase-1 follow-up)");
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
      recentPosts = await fetcher.getUserPosts(input.uniqueId);
    }

    return { creator, recentPosts };
  },
});
