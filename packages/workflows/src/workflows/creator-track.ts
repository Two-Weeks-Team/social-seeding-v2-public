import { Events } from "@ss/contracts";
import { inngest } from "../client";

/**
 * creator-track — a per-creator child workflow spawned by brand-campaign once a
 * creator is on the confirmed shortlist. Owns one creator's journey: outreach →
 * reply loop → agreement → shipment → posting → verification. Isolating it as a
 * child means one creator's retries/timers/escalations don't block the others,
 * and the parent stays a clean fan-out/fan-in.
 *
 * SKELETON — wired in Phase 2 (see docs/PHASE-1-PLAN.md and brand-campaign.ts).
 */
export const creatorTrack = inngest.createFunction(
  { id: "creator-track", cancelOn: [{ event: Events.CampaignCancelled, match: "data.campaignId" }] },
  { event: Events.CreatorTrackStart }, // emitted by brand-campaign (or step.invoke)
  async ({ event }) => {
    // event.data: { campaignId, creatorId }  (brief/policy fetched from @ss/db in the real impl)
    // 1. extractFacts(brief, creator)  — port v1 cold-mail/extract-facts; if !minContext → escalate
    // 2. runAgent(outreachWriterAgent) → OutreachDraft
    // 3. gate(approveOutreachSend) → gmail.send (idempotencyKey = `${campaignId}:${creatorId}:outreach`)
    // 4. loop ≤ MAX_FOLLOWUPS:
    //      race( step.waitForEvent(GmailReplyReceived, "3d"), timer )
    //        timer → step.run(follow-up) using cold-mail/followup.ts, continue
    //        reply → runAgent(conversationAgent) → branch on classification
    // 5. on "agreed" + address → emit to parent / advance; on "declined" → end
    return { creatorId: event.data.creatorId, status: "skeleton" as const };
  },
);
