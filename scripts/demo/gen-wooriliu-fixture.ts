/**
 * gen-wooriliu-fixture.ts — deterministic, PII-FREE generator for the
 * wooriliu-2nd test/demo fixture.
 *
 * WHY: the former `fixtures/wooriliu-2nd/raw.json` was a verbatim export from
 * the production Mongo DB (`instarsearch`) and carried real third-party PII
 * (recipient emails, names, Gmail message ids, email bodies). It is purged from
 * the repo + history. This generator regenerates a STRUCTURALLY-IDENTICAL,
 * fully ANONYMOUS replacement that:
 *   · contains ONLY the fields the adapter (packages/workflows/src/fixtures/
 *     wooriliu.ts) actually reads — no emails/names/bodies/ids by construction,
 *   · reproduces the SAME aggregate totals the demo/business-case/screenshots
 *     cite (16 verified posts · 59,498 views · 4,554 likes · 114 comments ·
 *     50 shares) so the campaign-autopilot test + demo stay green & consistent,
 *   · uses synthetic identifiers (creator_NN / post_NN) and an empty 154-entry
 *     email_queue (the adapter only reads its `.length`).
 *
 * Run: pnpm exec tsx scripts/demo/gen-wooriliu-fixture.ts
 * Output: fixtures/wooriliu-2nd/{raw,summary}.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/wooriliu-2nd");

// The 16 verified-post stat tuples [playCount, diggCount, commentCount, shareCount, engagementRate].
// Public engagement metrics only — NOT personal data. Totals: 59498 / 4554 / 114 / 50.
const VERIFIED_STATS: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [38200, 3927, 32, 13, 10.4], [660, 42, 9, 3, 8.18], [2349, 106, 9, 0, 4.9], [1788, 77, 2, 0, 4.42],
  [164, 20, 4, 5, 17.68], [379, 40, 10, 1, 13.46], [361, 9, 0, 0, 2.49], [310, 22, 2, 0, 7.74],
  [1095, 23, 8, 1, 2.92], [12400, 175, 2, 2, 1.44], [294, 16, 8, 1, 8.5], [244, 21, 6, 1, 11.48],
  [174, 15, 5, 2, 12.64], [462, 30, 7, 4, 8.87], [201, 18, 0, 8, 12.94], [417, 13, 10, 9, 7.67],
];

// Funnel status distribution across the 34 influencers (reproduces the real shape):
//   creators 01-16 = verified (10 content_approved · 4 product_received · 2 product_shipped)
//   creators 17-34 = 18 × identified (not-yet-posted)
const VERIFIED_STATUSES = [
  ...Array(10).fill("content_approved"),
  ...Array(4).fill("product_received"),
  ...Array(2).fill("product_shipped"),
];

const pad = (n: number) => String(n).padStart(2, "0");
// Deterministic dates inside the real campaign window (2025-10), no real timestamps.
const verifiedAt = (i: number) => ({ $date: `2025-10-${pad(10 + (i % 18))}T00:00:00.000Z` });
const updatedAt = (i: number) => ({ $date: `2025-10-${pad(10 + (i % 18))}T09:00:00.000Z` });

const TOTAL_INFLUENCERS = 34;
const VERIFIED = VERIFIED_STATS.length; // 16
const EMAIL_QUEUE_LEN = 154;

const campaign_contents = VERIFIED_STATS.map(([playCount, diggCount, commentCount, shareCount, engagementRate], i) => ({
  tiktok: { postId: `post_${pad(i + 1)}` },
  influencer: { uniqueId: `creator_${pad(i + 1)}` },
  stats: { playCount, diggCount, commentCount, shareCount, engagementRate },
  verification: { status: "verified", hasRequiredHashtags: true, verifiedAt: verifiedAt(i) },
}));

const campaign_influencers = Array.from({ length: TOTAL_INFLUENCERS }, (_, i) => {
  const n = i + 1;
  const status = i < VERIFIED ? VERIFIED_STATUSES[i] : "identified";
  return {
    uniqueId: `creator_${pad(n)}`,
    influencerName: `Creator ${pad(n)}`,
    status,
    updatedAt: updatedAt(i),
  };
});

// Adapter reads only `.length`; keep zero PII — 154 empty records.
const email_queue = Array.from({ length: EMAIL_QUEUE_LEN }, () => ({}));

const raw = {
  _meta: { synthetic: true, db: "synthetic", note: "PII-free anonymized fixture; replaces the former prod export. See scripts/demo/gen-wooriliu-fixture.ts" },
  campaign: { name: "우리리우 2차 (합성 픽스처)" },
  campaign_influencers,
  campaign_contents,
  email_queue,
};

const totals = VERIFIED_STATS.reduce(
  (a, [v, l, c, s]) => ({ views: a.views + v, likes: a.likes + l, comments: a.comments + c, shares: a.shares + s }),
  { views: 0, likes: 0, comments: 0, shares: 0 },
);

const summary = {
  _note: "synthetic anonymized summary — no PII (replaces the former prod export)",
  campaign: "우리리우 2차 (합성)",
  counts: { influencers: TOTAL_INFLUENCERS, contents: VERIFIED, verified: VERIFIED, emails: EMAIL_QUEUE_LEN },
  aggregates: totals,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(resolve(OUT_DIR, "raw.json"), JSON.stringify(raw, null, 2) + "\n");
writeFileSync(resolve(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(`wrote ${OUT_DIR}/{raw,summary}.json`);
console.log(`influencers=${TOTAL_INFLUENCERS} verified=${VERIFIED} email_queue=${EMAIL_QUEUE_LEN} totals=`, totals);
