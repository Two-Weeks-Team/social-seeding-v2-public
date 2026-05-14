import { Inngest, EventSchemas } from "inngest";
import { z } from "zod";
import {
  CampaignSubmittedEvent,
  ApprovalResolvedEvent,
  CreatorTrackStartEvent,
  GmailReplyReceivedEvent,
  ShipmentTrackingUpdatedEvent,
  TikTokPostDetectedEvent,
  ReportDeliverRequestEvent,
  ReportDeliveredEvent,
  Events,
} from "@ss/contracts";

/**
 * The Inngest client — the durable execution engine. A campaign is a workflow
 * that may run for weeks: `step.run` makes each side-effect atomic + retried,
 * `step.sleep` / `step.sleepUntil` are durable timers ("follow up in 3 days"),
 * `step.waitForEvent` blocks on a human approval or a Gmail reply without
 * holding a process. State survives deploys.
 */
export const inngest = new Inngest({
  id: "social-seeding-v2",
  schemas: new EventSchemas().fromZod({
    [Events.CampaignSubmitted]: { data: CampaignSubmittedEvent.shape.data },
    [Events.ApprovalResolved]: { data: ApprovalResolvedEvent.shape.data },
    [Events.GmailReplyReceived]: { data: GmailReplyReceivedEvent.shape.data },
    [Events.CampaignPaused]: { data: z.object({ campaignId: z.string() }) },
    [Events.CampaignResumed]: { data: z.object({ campaignId: z.string() }) },
    [Events.CampaignCancelled]: { data: z.object({ campaignId: z.string() }) },
    [Events.CreatorTrackStart]: { data: CreatorTrackStartEvent.shape.data },
    [Events.ShipmentTrackingUpdated]: { data: ShipmentTrackingUpdatedEvent.shape.data },
    [Events.TikTokPostDetected]: { data: TikTokPostDetectedEvent.shape.data },
    [Events.ReportDeliverRequest]: { data: ReportDeliverRequestEvent.shape.data },
    [Events.ReportDelivered]: { data: ReportDeliveredEvent.shape.data },
  }),
});
