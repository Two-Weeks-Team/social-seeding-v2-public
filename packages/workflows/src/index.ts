export { inngest } from "./client";
import { brandCampaign } from "./workflows/brand-campaign";
import { creatorTrack } from "./workflows/creator-track";

/** Every Inngest function the app serves. apps/web/app/api/inngest/route.ts re-exports this. */
export const functions = [brandCampaign, creatorTrack];
