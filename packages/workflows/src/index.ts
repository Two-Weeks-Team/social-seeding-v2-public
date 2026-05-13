export { inngest } from "./client.js";
import { brandCampaign } from "./workflows/brand-campaign.js";
import { creatorTrack } from "./workflows/creator-track.js";

/** Every Inngest function the app serves. apps/web/app/api/inngest/route.ts re-exports this. */
export const functions = [brandCampaign, creatorTrack];
