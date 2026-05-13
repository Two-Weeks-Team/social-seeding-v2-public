export { inngest } from "./client";
import { brandCampaign } from "./workflows/brand-campaign";
import { creatorTrack } from "./workflows/creator-track";
import { gmailWatchRenew } from "./workflows/gmail-watch-renew";
import { tiktokPostPoller } from "./workflows/tiktok-post-poller";

/** Every Inngest function the app serves. apps/web/app/api/inngest/route.ts re-exports this. */
export const functions = [brandCampaign, creatorTrack, gmailWatchRenew, tiktokPostPoller];
