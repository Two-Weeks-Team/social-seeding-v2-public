export { inngest } from "./client";
import { brandCampaign } from "./workflows/brand-campaign";
import { campaignAutopilot } from "./workflows/campaign-autopilot";
import { campaignProgression } from "./workflows/campaign-progression";
import { creatorTrack } from "./workflows/creator-track";
import { gmailWatchRenew } from "./workflows/gmail-watch-renew";
import { leadCampaign } from "./workflows/lead-campaign";
import { leadTrack } from "./workflows/lead-track";
import { reportDeliver } from "./workflows/report-deliver";
import { reportDeliverCron } from "./workflows/report-deliver-cron";
import { shipmentTrackingPoller } from "./workflows/shipment-tracking-poller";
import { tiktokPostPoller } from "./workflows/tiktok-post-poller";

/** Every Inngest function the app serves. apps/web/app/api/inngest/route.ts re-exports this. */
export const functions = [
  brandCampaign,
  campaignAutopilot,
  campaignProgression,
  creatorTrack,
  gmailWatchRenew,
  leadCampaign,
  leadTrack,
  reportDeliver,
  reportDeliverCron,
  shipmentTrackingPoller,
  tiktokPostPoller,
];
