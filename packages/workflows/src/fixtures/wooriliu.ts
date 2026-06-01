/**
 * wooriliu-2nd fixture adapter — maps the read-only prod `instarsearch`
 * extract (campaign + 34 influencers + 16 contents + 154 emails, EJSON) into
 * v2's Campaign / CreatorTrack shapes so the autonomous pipeline can run the
 * back-half stages (shipping → content_review → performance) on REAL data
 * without ever touching prod.
 *
 * Honest-scope notes (goal brief §2 + §5):
 *  · The fixture carries PII (recipient emails, names). This adapter only
 *    surfaces TikTok handles (`uniqueId`) as creatorIds + aggregate
 *    engagement. The public report (`ComBba/ss-reports`) gets aggregates only.
 *  · The source campaign's `performanceAnalysis` step is `pending` — that is
 *    exactly the step v2 auto-completes via analytics.compile (P4-C).
 *  · Mapping model: one verified CreatorTrack per verified CONTENT (16 — keeps
 *    the engagement aggregate exact, since 2 creators posted twice), plus one
 *    status-mapped track per remaining influencer (those without a verified
 *    post). targetLivePosts is a fixture assumption (source has no target).
 */
import { readFileSync } from "node:fs";
import {
  CampaignBriefSchema,
  type Campaign,
  type CampaignBrief,
  type CreatorTrack,
} from "@ss/contracts";

/** Raw EJSON shapes — only the fields the adapter reads. */
interface EjsonDate {
  $date: string;
}
interface RawInfluencer {
  uniqueId?: string;
  influencerName?: string;
  status?: string;
  updatedAt?: EjsonDate;
}
interface RawContentStats {
  playCount?: number;
  diggCount?: number;
  commentCount?: number;
  shareCount?: number;
  engagementRate?: number;
}
interface RawContent {
  tiktok?: { postId?: string };
  influencer?: { uniqueId?: string };
  stats?: RawContentStats;
  verification?: { status?: string; hasRequiredHashtags?: boolean; verifiedAt?: EjsonDate };
}
export interface WooriliuRaw {
  campaign: { name?: string };
  campaign_influencers: RawInfluencer[];
  campaign_contents: RawContent[];
  email_queue: unknown[];
}

const FIXTURE_URL = new URL("../../../../fixtures/wooriliu-2nd/raw.json", import.meta.url);

/** Stable fallback date so the fixture is deterministic (campaign ran 2025-09 → 2025-11). */
const FALLBACK_AT = new Date("2025-11-20T00:00:00Z");

function dateOf(d: EjsonDate | undefined): Date {
  return d?.$date ? new Date(d.$date) : FALLBACK_AT;
}

/** TikTok engagement-rate (%) → a 0-100 performance score (deterministic). */
function perfScore(engagementRate: number): number {
  return Math.max(0, Math.min(100, Math.round(engagementRate * 5)));
}

export function loadWooriliuRaw(path?: string): WooriliuRaw {
  const file = path ?? FIXTURE_URL;
  return JSON.parse(readFileSync(file, "utf8")) as WooriliuRaw;
}

function stateForStatus(status: string | undefined): CreatorTrack["state"] {
  switch (status) {
    case "product_shipped":
      return "shipped";
    case "product_received":
      return "delivered";
    case "content_approved":
      return "posted"; // approved a post but no verified content row in our set
    case "identified":
    default:
      return "outreach_sent"; // all 154 emails were sent — everyone was contacted
  }
}

function stageForState(state: CreatorTrack["state"]): Campaign["stage"] {
  if (state === "shipped" || state === "delivered") return "shipping";
  if (state === "posted" || state === "verified") return "content_review";
  return "outreach";
}

/** Build the v2 CreatorTrack[] from the raw extract. */
export function wooriliuTracks(raw: WooriliuRaw = loadWooriliuRaw()): CreatorTrack[] {
  const tracks: CreatorTrack[] = [];
  const verifiedCreators = new Set<string>();
  const seen: Record<string, number> = {};

  // 1 verified track per verified content (preserves the 16-post aggregate).
  for (const c of raw.campaign_contents) {
    if (c.verification?.status !== "verified") continue;
    const handle = c.influencer?.uniqueId ?? `creator_${tracks.length}`;
    verifiedCreators.add(handle);
    const n = (seen[handle] = (seen[handle] ?? 0) + 1);
    const creatorId = n > 1 ? `${handle}#${n}` : handle;
    const st = c.stats ?? {};
    const at = dateOf(c.verification?.verifiedAt);
    tracks.push({
      creatorId,
      stage: "content_review",
      state: "verified",
      lastActivityAt: at,
      emailsSent: 1,
      content: {
        postId: c.tiktok?.postId ?? creatorId,
        matches: c.verification?.hasRequiredHashtags === true,
        mentionsBrand: true,
        performanceScore: perfScore(st.engagementRate ?? 0),
        flags: [],
        views: st.playCount ?? 0,
        likes: st.diggCount ?? 0,
        comments: st.commentCount ?? 0,
        shares: st.shareCount ?? 0,
        detectedAt: at,
      },
    });
  }

  // remaining influencers (no verified post) mapped to their funnel stage.
  for (const inf of raw.campaign_influencers) {
    if (!inf.uniqueId || verifiedCreators.has(inf.uniqueId)) continue;
    const state = stateForStatus(inf.status);
    tracks.push({
      creatorId: inf.uniqueId,
      stage: stageForState(state),
      state,
      lastActivityAt: dateOf(inf.updatedAt),
      emailsSent: 1,
    });
  }

  return tracks;
}

/** Synthesize a CampaignBrief for the fixture (workspace id is fixture-only). */
export function wooriliuBrief(raw: WooriliuRaw = loadWooriliuRaw()): CampaignBrief {
  return CampaignBriefSchema.parse({
    workspaceId: "ws_wooriliu_2nd",
    createdBy: "f".repeat(21),
    brandProduct: {
      name: "우리리우",
      category: "beauty/cosmetics",
      description: "우리리우 2차 시딩 — TikTok 뷰티 크리에이터 대상 샘플 발송 + 성과측정 캠페인 (픽스처).",
      keyClaims: [],
    },
    targeting: {
      creatorCount: raw.campaign_influencers.length, // 34
      minEngagementRate: 0.02,
      languages: ["ko"],
      hashtags: [],
      excludeBlacklist: true,
    },
    logistics: { shipsSamples: true },
    goals: {
      targetLivePosts: 10, // fixture assumption — source has no stored target; 16 verified ⇒ over-delivery
      deadline: new Date("2025-11-30T00:00:00Z"),
      budgetUsd: 1500,
    },
  });
}

/** The campaign-create input (stage='outreach' — ready for the autopilot back-half). */
export function wooriliuCampaignInput(
  raw: WooriliuRaw = loadWooriliuRaw(),
): Omit<Campaign, "id" | "createdAt" | "updatedAt"> {
  return {
    brief: wooriliuBrief(raw),
    status: "running",
    stage: "outreach",
    tracks: wooriliuTracks(raw),
  };
}

/** Expected aggregates, computed straight from the raw extract — the test asserts the pipeline reproduces these. */
export function wooriliuExpected(raw: WooriliuRaw = loadWooriliuRaw()): {
  verifiedCount: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
} {
  let views = 0, likes = 0, comments = 0, shares = 0, verifiedCount = 0;
  for (const c of raw.campaign_contents) {
    if (c.verification?.status !== "verified") continue;
    verifiedCount++;
    const st = c.stats ?? {};
    views += st.playCount ?? 0;
    likes += st.diggCount ?? 0;
    comments += st.commentCount ?? 0;
    shares += st.shareCount ?? 0;
  }
  return { verifiedCount, views, likes, comments, shares };
}
