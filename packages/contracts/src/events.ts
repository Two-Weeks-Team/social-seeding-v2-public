import { z } from "zod";
import { CampaignBriefSchema, CampaignStage } from "./campaign.js";
import { ReplyClassSchema } from "./outreach.js";

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

export const GmailReplyReceivedEvent = z.object({
  name: z.literal(Events.GmailReplyReceived),
  data: z.object({
    campaignId: z.string(),
    creatorId: z.string(),
    threadId: z.string(),
    messageId: z.string(),
    classificationHint: ReplyClassSchema.optional(),
  }),
});

export const StageAdvancedEvent = z.object({
  // emitted by the workflow itself for observability; not consumed to drive logic
  name: z.literal("campaign/stage.advanced"),
  data: z.object({ campaignId: z.string(), from: CampaignStage, to: CampaignStage }),
});
