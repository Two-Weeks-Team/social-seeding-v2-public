import { z } from "zod";
import { TikTokCreatorSchema } from "@ss/contracts";
import { Collections, getDb } from "@ss/db";
import { defineCapability } from "../registry";

/**
 * tiktok.search — port of v1 `~/social-seeding/src/app/api/search/tiktok`, but
 * Phase-0 only (synchronous Mongo). Phase 1 (RapidAPI live) and Phase 2
 * (Mongo remainder) ride on separate flows; the Sourcing agent typically only
 * needs Phase 0.
 *
 * Ranking mirrors v1's weighted-field model (hashtags 10x / signature 5x /
 * nickname 2x / uniqueId 1x). The 4 modes — text / hashtag / and / or — match
 * v1's comma vs space tokenization:
 *   · text     : free text, whitespace-tokenize, OR-match across all 4 fields
 *   · hashtag  : comma-tokenize, ONLY check the hashtags[] array
 *   · and      : comma-tokenize, every token must hit ≥1 field
 *   · or       : whitespace-tokenize, any token in any field
 *
 * Implementation note: uses MongoDB aggregation with case-insensitive `$regex`
 * matches + a computed `_score` field. Works on both memory-server (tests)
 * and Atlas (prod). Atlas Search index integration with proper BM25 ranking
 * lands as a follow-up — see docs/SCOPE-DECISIONS.md.
 */

const REGEX_META = /[.*+?^${}()|[\]\\]/g;
function escapeRegex(s: string): string {
  return s.replace(REGEX_META, "\\$&");
}

function tokenize(query: string, mode: "text" | "hashtag" | "and" | "or"): string[] {
  const splitter = mode === "and" || mode === "hashtag" ? "," : /\s+/;
  return query
    .split(splitter)
    .map((t) => t.trim().replace(/^#/, ""))
    .filter((t) => t.length > 0);
}

interface ScoredCreatorDoc {
  _id?: unknown;
  id?: string;
  uniqueId?: string;
  nickname?: string;
  signature?: string;
  followerCount?: number;
  followingCount?: number;
  videoCount?: number;
  hashtags?: string[];
  textLanguage?: string;
  verified?: boolean;
  privateAccount?: boolean;
  heartCount?: number;
  avatarThumb?: string;
  avatarLarger?: string;
  _score?: number;
}

export const tiktokSearch = defineCapability({
  name: "tiktok.search",
  description:
    "Search TikTok creators by free text / hashtags / handle against the shared accounts_tiktok collection. 4 modes (text / hashtag / and / or) with weighted-field ranking (hashtags 10x / signature 5x / nickname 2x / uniqueId 1x). Optional follower / engagement / language filters.",
  scope: "read",
  idempotent: true,
  rateLimitClass: "tiktok_read",
  input: z.object({
    query: z.string().min(1),
    mode: z.enum(["text", "hashtag", "and", "or"]).default("text"),
    minFollowers: z.number().int().optional(),
    maxFollowers: z.number().int().optional(),
    minEngagementRate: z.number().min(0).max(1).optional(),
    languages: z.array(z.string().length(2)).optional(),
    limit: z.number().int().min(1).max(1000).default(200),
  }),
  output: z.object({
    creators: z.array(TikTokCreatorSchema),
    total: z.number().int().nonnegative(),
    continuation: z.string().nullable(),
  }),
  async handler(input, _ctx) {
    const tokens = tokenize(input.query, input.mode);
    if (tokens.length === 0) return { creators: [], total: 0, continuation: null };

    const escaped = tokens.map(escapeRegex);

    // ── filter ──────────────────────────────────────────────────────────────
    const baseFilter: Record<string, unknown> = {};
    if (input.minFollowers !== undefined || input.maxFollowers !== undefined) {
      const f: Record<string, number> = {};
      if (input.minFollowers !== undefined) f.$gte = input.minFollowers;
      if (input.maxFollowers !== undefined) f.$lte = input.maxFollowers;
      baseFilter.followerCount = f;
    }
    if (input.languages?.length) baseFilter.textLanguage = { $in: input.languages };

    // mode-specific match: every token in `and`, any token in `or`/`text`, only hashtags in `hashtag`
    const tokenOrFields = (t: string): Record<string, unknown>[] => {
      const rx = { $regex: t, $options: "i" };
      if (input.mode === "hashtag") return [{ hashtags: rx }];
      return [{ hashtags: rx }, { signature: rx }, { nickname: rx }, { uniqueId: rx }];
    };
    const tokenMatches = escaped.map((t) => ({ $or: tokenOrFields(t) }));
    if (input.mode === "and") {
      Object.assign(baseFilter, { $and: tokenMatches });
    } else {
      // text / or / hashtag — any token, any field (hashtag mode already restricts fields)
      baseFilter.$or = tokenMatches.flatMap((m) => m.$or as Record<string, unknown>[]);
    }

    // ── score: weighted sum (hashtags 10x / signature 5x / nickname 2x / uniqueId 1x) ──
    const scoreAddends = escaped.flatMap((t) => [
      // hashtag matches count by element (so 2 matching tags ⇒ +20)
      {
        $multiply: [
          {
            $size: {
              $filter: {
                input: { $ifNull: ["$hashtags", []] },
                as: "h",
                cond: { $regexMatch: { input: "$$h", regex: t, options: "i" } },
              },
            },
          },
          10,
        ],
      },
      // signature / nickname / uniqueId — boolean hit (only contribute when not restricted to hashtag-only mode)
      ...(input.mode === "hashtag"
        ? []
        : [
            { $cond: [{ $regexMatch: { input: { $ifNull: ["$signature", ""] }, regex: t, options: "i" } }, 5, 0] },
            { $cond: [{ $regexMatch: { input: { $ifNull: ["$nickname", ""] }, regex: t, options: "i" } }, 2, 0] },
            { $cond: [{ $regexMatch: { input: { $ifNull: ["$uniqueId", ""] }, regex: t, options: "i" } }, 1, 0] },
          ]),
    ]);

    // engagement-rate floor is computed post-filter (uses heartCount/followerCount/videoCount that not every doc has).
    const erFilter =
      input.minEngagementRate !== undefined
        ? [
            {
              $match: {
                $expr: {
                  $gte: [
                    {
                      $cond: [
                        { $or: [{ $lte: ["$followerCount", 0] }, { $lte: ["$videoCount", 0] }] },
                        0,
                        { $divide: ["$heartCount", { $multiply: ["$followerCount", "$videoCount"] }] },
                      ],
                    },
                    input.minEngagementRate,
                  ],
                },
              },
            },
          ]
        : [];

    const db = await getDb();
    const col = db.collection(Collections.SHARED_TIKTOK_ACCOUNTS);

    const pipeline = [
      { $match: baseFilter },
      ...erFilter,
      { $addFields: { _score: { $add: scoreAddends } } },
      { $sort: { _score: -1 as const, followerCount: -1 as const } },
      { $limit: input.limit },
    ];
    const docs = (await col.aggregate<ScoredCreatorDoc>(pipeline).toArray()) as ScoredCreatorDoc[];

    // total: re-run with the same filter (+ ER check) but count only — cheap parallel query (skipped if results < limit)
    const total =
      docs.length < input.limit
        ? docs.length
        : await col
            .aggregate([{ $match: baseFilter }, ...erFilter, { $count: "n" }])
            .toArray()
            .then((rows) => (rows[0] as { n?: number } | undefined)?.n ?? 0);

    // map mongo docs → TikTokCreatorSchema; drop docs that don't fit the schema (legacy / partial)
    const creators: z.infer<typeof TikTokCreatorSchema>[] = [];
    for (const d of docs) {
      const id = typeof d.id === "string" ? d.id : (d._id?.toString?.() ?? "");
      const parsed = TikTokCreatorSchema.safeParse({ ...d, id });
      if (parsed.success) creators.push(parsed.data);
    }

    return { creators, total, continuation: null };
  },
});
