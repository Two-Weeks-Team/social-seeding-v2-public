import { Events } from "@ss/contracts";
import { inngest } from "../client";

/**
 * brand-campaign — the durable workflow that *is* the product. It encodes the
 * 6 stages v1 made the human click through, and runs them with agents,
 * pausing at policy gates. This file is a SKELETON: the comments describe the
 * intended `step.*` graph; `docs/PHASE-1-PLAN.md` tasks fill it in slice by
 * slice (Phase 1 = stages 1–2, Phase 2 = stage 3, etc.).
 *
 * Why deterministic-orchestrator-invokes-agents (not a free agent loop): a
 * 6-week business process needs retries, durable timers, human gates and
 * replayable state. The agents handle the judgment; the workflow handles the
 * choreography. (Same split v1's cold-mail pipeline already uses internally.)
 */
export const brandCampaign = inngest.createFunction(
  {
    id: "brand-campaign",
    // one run per campaign; pause/resume/cancel via events
    cancelOn: [{ event: Events.CampaignCancelled, match: "data.campaignId" }],
  },
  { event: Events.CampaignSubmitted },
  // `step` will be destructured here once the stages below are filled in (Phase 1+).
  async ({ event }) => {
    const { campaignId } = event.data;

    // ── Stage 1: overview ────────────────────────────────────────────────
    // step.run("plan", ...) — load brief + workspace policy; persist a plan;
    //   set campaign.stage = "sourcing". (campaignRepo.patchStage)

    // ── Stage 2: sourcing + vetting ──────────────────────────────────────
    // const candidates = await step.run("source", () => runAgent(sourcingAgent, ...))
    // const vetted = await Promise.all(candidates.map((c, i) =>
    //   step.run(`vet-${i}`, () => runAgent(vettingAgent, ...))))
    // const shortlist = pickTop(vetted, brief.targeting.creatorCount * 1.5)
    //
    // GATE: approveShortlist
    //   const decision = await gate(step, "approveShortlist", { campaignId, recommendation: shortlist })
    //   // gate() = if policy says auto/auto_unless-and-no-escalation: return shortlist;
    //   //          else create an Approval row, emit, and step.waitForEvent(ApprovalResolved)
    //   const confirmed = decision.editedPayload ?? shortlist

    // ── Stage 3: outreach + conversation (Phase 2) ───────────────────────
    // For each confirmed creator, fan out a `creatorTrack` child workflow via
    // step.invoke / step.sendEvent. Each child: extractFacts → outreachWriter →
    // GATE approveOutreachSend → gmail.send → loop:
    //   step.waitForEvent(GmailReplyReceived, timeout: "3d")
    //     timeout  → step.run("follow-up", ...) (v1 follow-up cadence), repeat ≤N
    //     reply    → runAgent(conversationAgent) → classify:
    //                  interested + address    → mark agreed
    //                  negotiating / question  → GATE approveReplyResponse → gmail.send
    //                  declined / unsubscribe  → end track (feeds blacklist auto-detect)

    // ── Stage 4: shipping (Phase 3) ──────────────────────────────────────
    // GATE approveShipment → shipment.create → step.waitForEvent(ShipmentTrackingUpdated)…

    // ── Stage 5: content review (Phase 3) ────────────────────────────────
    // schedule a poller (separate scheduled fn) that emits TikTokPostDetected;
    // the track step.waitForEvent on it (timeout 14d → escalate "no post yet").

    // ── Stage 6: performance (Phase 4) ───────────────────────────────────
    // step.run("report", () => runAgent(analystAgent, ...)); deliver weekly via
    // a recurring child; set campaign.status = "completed" when all tracks done.

    return { campaignId, status: "skeleton" as const };
  },
);
