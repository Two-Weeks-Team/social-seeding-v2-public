import { z } from "zod";

/**
 * Campaign brief — the *intent* the human gives. Replaces v1's 6-tab form.
 * Produced by a structured intake conversation (Phase 1), not hand-filled.
 */
export const CampaignBriefSchema = z.object({
  workspaceId: z.string(),
  createdBy: z.string(), // 21-char Google OAuth id (v1 parity)
  brandProduct: z.object({
    name: z.string(),
    category: z.string(), // e.g. "skincare/serum"
    description: z.string(),
    landingUrl: z.string().url().optional(),
    keyClaims: z.array(z.string()).default([]),
  }),
  targeting: z.object({
    creatorCount: z.number().int().positive(), // desired number of confirmed creators
    followerRange: z.tuple([z.number().int(), z.number().int()]).optional(),
    minEngagementRate: z.number().min(0).max(1).default(0.02),
    languages: z.array(z.string().length(2)).default(["ko"]),
    hashtags: z.array(z.string()).default([]),
    excludeBlacklist: z.boolean().default(true),
  }),
  logistics: z.object({
    shipsSamples: z.boolean().default(true),
    sampleSku: z.string().optional(),
  }),
  goals: z.object({
    targetLivePosts: z.number().int().positive(),
    deadline: z.coerce.date(),
    budgetUsd: z.number().nonnegative().optional(),
  }),
});
export type CampaignBrief = z.infer<typeof CampaignBriefSchema>;

/** The 6 stages, carried verbatim from v1's workflow (now driven by the orchestrator). */
export const CampaignStage = z.enum([
  "overview", // 1. brief accepted, plan generated
  "sourcing", // 2. find + vet creators
  "outreach", // 3. write + send + handle replies
  "shipping", // 4. ship samples
  "content_review", // 5. verify posts went live
  "performance", // 6. compile report
]);
export type CampaignStage = z.infer<typeof CampaignStage>;

export const CampaignStatusSchema = z.enum(["draft", "running", "paused", "completed", "cancelled"]);

/**
 * Phase 3 content-review snapshot persisted on the track terminal. Drives
 * the /campaigns/[id]/posts MC view + future analyst reporting (Phase 4).
 */
export const CreatorTrackContentSchema = z.object({
  postId: z.string(),
  matches: z.boolean(),
  mentionsBrand: z.boolean(),
  performanceScore: z.number().min(0).max(100),
  flags: z.array(z.string()).default([]),
  /** Newest engagement snapshot at verify time. */
  views: z.number().int().nonnegative().default(0),
  likes: z.number().int().nonnegative().default(0),
  comments: z.number().int().nonnegative().default(0),
  shares: z.number().int().nonnegative().default(0),
  detectedAt: z.coerce.date(),
  /** Post media for the content-verification grid (optional; populated when known). */
  coverImage: z.string().optional(), // cached cover path (/demo-covers/<postId>.jpg) or URL
  postUrl: z.string().optional(), // TikTok permalink (https://www.tiktok.com/@h/video/<postId>)
  caption: z.string().optional(), // post title/description
  hashtags: z.array(z.string()).optional(), // without leading '#'
});
export type CreatorTrackContent = z.infer<typeof CreatorTrackContentSchema>;

/** Per-creator track inside a campaign (its own durable child workflow). */
export const CreatorTrackSchema = z.object({
  creatorId: z.string(),
  stage: CampaignStage,
  state: z.enum([
    "candidate", "shortlisted", "outreach_sent", "in_conversation", "agreed",
    "address_collected", "shipped", "delivered", "posted", "verified",
    "declined", "no_response", "flaked",
  ]),
  threadId: z.string().optional(), // Gmail thread
  lastActivityAt: z.coerce.date(),
  emailsSent: z.number().int().nonnegative().default(0),
  pendingApprovalId: z.string().optional(), // points at an open checkpoint
  /** Phase 3 — populated by creator-track once contentVerifyAgent runs. */
  content: CreatorTrackContentSchema.optional(),
});
export type CreatorTrack = z.infer<typeof CreatorTrackSchema>;

export const CampaignSchema = z.object({
  id: z.string(),
  brief: CampaignBriefSchema,
  status: CampaignStatusSchema,
  stage: CampaignStage,
  tracks: z.array(CreatorTrackSchema).default([]),
  inngestRunId: z.string().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Campaign = z.infer<typeof CampaignSchema>;
