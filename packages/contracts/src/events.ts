import { z } from "zod";
import { CampaignBriefSchema, CampaignStage } from "./campaign";
import { TikTokCreatorSchema } from "./creator";
import { ReplyClassSchema } from "./outreach";

/**
 * Inngest event catalog. Every async boundary in the system is one of these.
 * `name` strings are the contract between web/api emitters and the workflows
 * package consumers. Keep them stable.
 */
export const Events = {
  CampaignSubmitted: "campaign/submitted",
  CampaignPaused: "campaign/paused",
  CampaignResumed: "campaign/resumed",
  CampaignCancelled: "campaign/cancelled",
  CreatorTrackStart: "campaign/creator-track.start", // brand-campaign → creator-track (also used with step.invoke)
  ApprovalResolved: "approval/resolved", // human acted in Mission Control
  GmailReplyReceived: "gmail/reply.received", // from the Gmail pubsub webhook
  ShipmentTrackingUpdated: "shipment/tracking.updated",
  TikTokPostDetected: "tiktok/post.detected", // content-verify poller found a matching post
} as const;
export type EventName = (typeof Events)[keyof typeof Events];

export const CampaignSubmittedEvent = z.object({
  name: z.literal(Events.CampaignSubmitted),
  data: z.object({ campaignId: z.string(), brief: CampaignBriefSchema }),
});

export const ApprovalResolvedEvent = z.object({
  name: z.literal(Events.ApprovalResolved),
  data: z.object({
    approvalId: z.string(),
    campaignId: z.string(),
    decision: z.enum(["approved", "edited", "rejected"]),
    editedPayload: z.unknown().optional(),
  }),
});

/**
 * Fired by the Gmail Pub/Sub webhook (P2-C7) when a creator replies. Carries
 * enough of the message that creator-track can classify it without a Gmail
 * round-trip. The webhook is responsible for resolving threadId → (campaignId,
 * creatorId) via the v2_outbox row gmail.send wrote.
 */
export const GmailReplyReceivedEvent = z.object({
  name: z.literal(Events.GmailReplyReceived),
  data: z.object({
    campaignId: z.string(),
    creatorId: z.string(),
    threadId: z.string(),
    messageId: z.string(),
    fromEmail: z.string().email(),
    subject: z.string().default(""),
    /** Plain-text body of the reply (HTML stripped by the webhook). */
    bodyText: z.string(),
    classificationHint: ReplyClassSchema.optional(),
  }),
});

/**
 * Fired by brand-campaign once a shortlist track is confirmed. Carries the
 * full brief + creator + (optional) prefetched recent posts so creator-track
 * can run end-to-end without re-fetching from the shared collections.
 *
 * `creatorEmail` is optional — many TikTok creators don't expose one. When
 * absent, creator-track terminates as `no_email` (Phase 5 enrichment will
 * close that gap).
 */
export const CreatorTrackStartEvent = z.object({
  name: z.literal(Events.CreatorTrackStart),
  data: z.object({
    campaignId: z.string(),
    brief: CampaignBriefSchema,
    creator: TikTokCreatorSchema,
    creatorEmail: z.string().email().optional(),
    recentPosts: z
      .array(
        z.object({
          desc: z.string().default(""),
          hashtags: z.array(z.string()).default([]),
        }),
      )
      .default([]),
  }),
});

export const StageAdvancedEvent = z.object({
  // emitted by the workflow itself for observability; not consumed to drive logic
  name: z.literal("campaign/stage.advanced"),
  data: z.object({ campaignId: z.string(), from: CampaignStage, to: CampaignStage }),
});

/**
 * Fired by `shipment.track` (Phase 3) when the carrier reports a status flip
 * on a shipment we own. Creator-track's shipping wait-loop awaits this with
 * a 14-day timeout; the poller (Phase-3.5 follow-up) is the producer.
 */
export const ShipmentTrackingUpdatedEvent = z.object({
  name: z.literal(Events.ShipmentTrackingUpdated),
  data: z.object({
    campaignId: z.string(),
    creatorTrackId: z.string(),
    creatorId: z.string(),
    shipmentId: z.string(),
    /** Latest mapped ShipmentStatus the workflow branches on. */
    status: z.enum([
      "pending",
      "address_pending",
      "shipped",
      "in_transit",
      "out_for_delivery",
      "delivered",
      "failed",
      "returned",
      "cancelled",
    ]),
    /** Tracking number for MC-side display. */
    trackingNumber: z.string().default(""),
  }),
});

/**
 * Fired by `tiktok-post-poller` (Phase 3) when it spots a creator's post that
 * looks like a match for an in-progress track (campaign hashtag overlap +
 * brand-name mention in the description). Creator-track's content-review
 * wait-loop awaits this with a 14-day timeout; content-verify (Phase 3 agent)
 * scores the post afterwards.
 */
export const TikTokPostDetectedEvent = z.object({
  name: z.literal(Events.TikTokPostDetected),
  data: z.object({
    campaignId: z.string(),
    creatorTrackId: z.string(),
    creatorId: z.string(),
    postId: z.string(),
    /** Verbatim post desc — the agent reads this. */
    desc: z.string().default(""),
    hashtags: z.array(z.string()).default([]),
    views: z.number().int().nonnegative().default(0),
    likes: z.number().int().nonnegative().default(0),
    comments: z.number().int().nonnegative().default(0),
    shares: z.number().int().nonnegative().default(0),
    createdAt: z.coerce.date(),
    /**
     * The hashtags from the campaign brief that overlapped with this post's
     * hashtags — what made the poller flag it.
     */
    matchedHashtags: z.array(z.string()).default([]),
  }),
});
