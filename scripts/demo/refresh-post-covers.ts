/**
 * DEMO-ONLY (local): populate real TikTok post covers for the 콘텐츠 검증 grid.
 *
 * The content-verification page shows the actual posted videos as a grid, so each
 * verified track needs a cover image. The fixtures' covers are TikTok-CDN URLs
 * whose signed `x-expires` lapsed (2025-10 → 403), and the backend's recent-posts
 * feed no longer carries these months-old videos. So we fetch covers from TikTok's
 * PUBLIC oEmbed endpoint (per-post, no auth) and cache them locally so they never
 * expire:
 *
 *   GET https://www.tiktok.com/oembed?url=https://www.tiktok.com/@<handle>/video/<postId>
 *     → { thumbnail_url }  →  download → apps/web/public/demo-covers/<postId>.jpg
 *
 * Then patches each 우리리우 campaign's track.content (all workspace copies) with
 * coverImage (local path) + postUrl + caption + hashtags (caption/hashtags from
 * the fixture campaign_contents). Idempotent: skips a cover already on disk.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27027/instarsearch \
 *   pnpm exec tsx scripts/demo/refresh-post-covers.ts
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { MongoClient, ObjectId } from "mongodb";

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27027/instarsearch";
const COVER_DIR = resolve(process.cwd(), "apps/web/public/demo-covers");
const FIXTURE = resolve(process.cwd(), "fixtures/wooriliu-2nd/raw.json");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** postId → { caption, hashtags } from the fixture campaign_contents. */
function loadFixtureMeta(): Map<string, { caption: string; hashtags: string[] }> {
  const out = new Map<string, { caption: string; hashtags: string[] }>();
  try {
    const j = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
      campaign_contents?: Array<{
        tiktok?: { postId?: string };
        content?: { title?: string; description?: string; hashtags?: string[] };
      }>;
    };
    for (const c of j.campaign_contents ?? []) {
      const pid = c.tiktok?.postId;
      if (!pid) continue;
      const caption = (c.content?.title || c.content?.description || "").trim();
      const hashtags = (c.content?.hashtags ?? []).map((h) => h.replace(/^#/, "")).filter(Boolean);
      out.set(pid, { caption, hashtags });
    }
  } catch {
    /* fixture optional */
  }
  return out;
}

/** Fetch a post's cover via TikTok public oEmbed and cache it; returns the local path or null. */
async function ensureCover(handle: string, postId: string): Promise<string | null> {
  const file = resolve(COVER_DIR, `${postId}.jpg`);
  const publicPath = `/demo-covers/${postId}.jpg`;
  if (existsSync(file)) return publicPath; // idempotent
  const postUrl = `https://www.tiktok.com/@${handle}/video/${postId}`;
  try {
    const o = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(postUrl)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!o.ok) return null;
    const thumb = ((await o.json()) as { thumbnail_url?: string }).thumbnail_url;
    if (!thumb) return null;
    const img = await fetch(thumb, { signal: AbortSignal.timeout(15_000) });
    if (!img.ok) return null;
    writeFileSync(file, Buffer.from(await img.arrayBuffer()));
    return publicPath;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  mkdirSync(COVER_DIR, { recursive: true });
  const fixtureMeta = loadFixtureMeta();
  const client = new MongoClient(URI);
  await client.connect();
  const campaigns = client.db().collection("v2_campaigns");

  const camps = await campaigns.find({ "brief.brandProduct.name": "우리리우" }).toArray();
  console.log(`[covers] ${camps.length} 우리리우 campaigns`);

  // Cache covers once per postId (shared across the workspace copies).
  const coverCache = new Map<string, string | null>();
  let patched = 0;
  let coversOk = 0;

  for (const camp of camps) {
    const tracks = (camp.tracks ?? []) as Array<{ creatorId: string; content?: { postId?: string } }>;
    for (const t of tracks) {
      const postId = t.content?.postId;
      if (!postId) continue;
      if (!coverCache.has(postId)) {
        const p = await ensureCover(t.creatorId, postId);
        coverCache.set(postId, p);
        if (p) coversOk++;
        await sleep(400); // be polite to oEmbed
      }
      const coverImage = coverCache.get(postId) ?? undefined;
      const meta = fixtureMeta.get(postId);
      const set: Record<string, unknown> = {
        "tracks.$[t].content.postUrl": `https://www.tiktok.com/@${t.creatorId}/video/${postId}`,
      };
      if (coverImage) set["tracks.$[t].content.coverImage"] = coverImage;
      if (meta?.caption) set["tracks.$[t].content.caption"] = meta.caption;
      if (meta?.hashtags?.length) set["tracks.$[t].content.hashtags"] = meta.hashtags;
      await campaigns.updateOne({ _id: camp._id as ObjectId }, { $set: set }, { arrayFilters: [{ "t.creatorId": t.creatorId }] });
      patched++;
    }
  }

  console.log(`[covers] covers cached ${coversOk}/${coverCache.size} unique posts · patched ${patched} track.content across ${camps.length} campaigns`);
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
