import { Events } from "@ss/contracts";
import { campaignRepo } from "@ss/db";
import type { StepLike } from "./gate";

/**
 * pause helper — carry-over (Phase 6.5). Minimal "soft pause":
 * the workflow keeps its in-flight state (no Inngest cancellation),
 * but BEFORE any external-side-effect step (gmail.send, carrier
 * dispatch, etc.) it calls `pauseCheck(step, campaignId)`. When the
 * campaign is `status='paused'`, the helper parks the workflow on
 * `step.waitForEvent('campaign/resumed', timeout='30d')` and only
 * proceeds when the operator clicks "재개" in MC (which emits
 * `CampaignResumed`) or when the 30-day timeout elapses.
 *
 * Discipline this gets right:
 *  · No re-emit of `CreatorTrackStart` / `LeadTrackStart` on resume —
 *    the workflow's existing state is preserved (Inngest's durable
 *    timers + step graph survive).
 *  · No need for cancelOn — pausing is a soft guard at the boundary
 *    between "thinking" (free) and "doing" (expensive / outward
 *    facing). Reply waits + classifier calls still run; only sends
 *    + carrier dispatches pause.
 *  · Cancellation is a separate, harder action via cancelOn against
 *    `CampaignCancelled` — that fully kills the run.
 *  · If the campaign is `cancelled` or `completed` when we check,
 *    the helper throws so the calling step exits cleanly via Inngest
 *    error semantics (no implicit "proceed anyway").
 *
 * Discipline this DOESN'T cover (P6.5+ if needed):
 *  · Pausing won't stop a creator-track-fanout already mid-emit —
 *    the parent workflow only checks once before the fanout. Some
 *    children may still receive LeadTrackStart in flight; they'll
 *    pause individually at their first send.
 *  · The 30d resume timeout is a hard cap. After that the workflow
 *    proceeds as if resumed; operator visibility on a 30-day-paused
 *    campaign is left as a HANDOFF item.
 */

/** Terminal campaign statuses where pauseCheck refuses to proceed. */
export class CampaignTerminalError extends Error {
  constructor(readonly campaignId: string, readonly status: "cancelled" | "completed") {
    super(`campaign ${campaignId} is ${status} — workflow should exit`);
    this.name = "CampaignTerminalError";
  }
}

/** Hard cap on how long pauseCheck will wait for resume before proceeding. */
export const RESUME_WAIT_TIMEOUT = "30d";

/**
 * Inspect the campaign's status. Three branches:
 *   · running   → returns immediately, workflow proceeds.
 *   · paused    → parks on waitForEvent(`campaign/resumed`, 30d).
 *                 When the event arrives (or the timeout fires),
 *                 returns and the workflow proceeds. If the campaign
 *                 transitioned to cancelled while paused, throws
 *                 CampaignTerminalError.
 *   · cancelled | completed → throws CampaignTerminalError so the
 *                 enclosing step.run exits without side effects.
 *
 * Re-reads campaign.status both before AND after the wait so a
 * resume-then-cancel doesn't slip through.
 */
export async function pauseCheck(step: StepLike, campaignId: string): Promise<void> {
  const status = await step.run(`pause-check:${campaignId}`, async () => {
    const c = await campaignRepo.get(campaignId);
    return c?.status ?? "running";
  });
  if (status === "cancelled" || status === "completed") {
    throw new CampaignTerminalError(campaignId, status);
  }
  if (status !== "paused") return;
  // Park until resume / cancel.
  await step.waitForEvent<{ campaignId: string }>(`await-resume:${campaignId}`, {
    event: Events.CampaignResumed,
    timeout: RESUME_WAIT_TIMEOUT,
    if: `event.data.campaignId == "${campaignId}"`,
  });
  // Re-check after the wait: an operator could have cancelled in the
  // same window. We trust the latest persisted status, not the event.
  const afterStatus = await step.run(`pause-check-after-resume:${campaignId}`, async () => {
    const c = await campaignRepo.get(campaignId);
    return c?.status ?? "running";
  });
  if (afterStatus === "cancelled" || afterStatus === "completed") {
    throw new CampaignTerminalError(campaignId, afterStatus);
  }
  // If still paused after a timeout-fired waitForEvent, proceed
  // (30d cap honored — surface the case to HANDOFF for operator review).
}
