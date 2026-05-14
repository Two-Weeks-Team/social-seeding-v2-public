import { Events, type Campaign, type CreatorTrack } from "@ss/contracts";
import { campaignRepo, Collections, getDb, reportRepo } from "@ss/db";
import { inngest } from "../client";

/**
 * campaign-progression — Phase 4 P4-C4. Daily cron that closes the brand-
 * campaign lifecycle after creator-track fan-out terminates. Two
 * transitions, both idempotent, both safe to re-run:
 *
 *   1. stage outreach → performance  (when all tracks reached a terminal
 *      state). If verifiedCount > 0, also emit `report/deliver.request`
 *      (trigger='stage_transition') — the report-deliver workflow (P4-C3)
 *      will compile + analyst-narrate + persist the row.
 *      If verifiedCount == 0, skip the report entirely and go straight to
 *      status='completed' — analyst has no signal to narrate.
 *
 *   2. status running → completed  (once stage='performance' AND a
 *      report row exists for the campaign). This catches both the
 *      cron-emitted stage_transition report AND any manual export the
 *      operator did first.
 *
 * Cron at 03:00 UTC sits between tiktok-post-poller (02:00) and the
 * shipment-tracking-poller (04:00); the chosen hour matters less than the
 * cadence (every transition resolves within 24h).
 *
 * brand-campaign itself is unchanged: it still exits at stage='outreach'
 * after fan-out. The cron is what advances the campaign past the work
 * the durable workflow doesn't need to hold state for (creator-tracks run
 * independently for days, sometimes weeks).
 */

/** Track states that count as "done" from the campaign-progression view. */
const TERMINAL_TRACK_STATES: ReadonlySet<CreatorTrack["state"]> = new Set([
  "verified",
  "declined",
  "no_response",
  "flaked",
]);

export interface CampaignProgressionResult {
  scanned: number;
  /** Campaigns advanced from outreach → performance (with verified > 0). */
  reportRequested: number;
  /** Campaigns marked completed directly because verified == 0 (no report). */
  completedNoReport: number;
  /** Campaigns marked completed because performance-stage + a report exists. */
  completedAfterReport: number;
  /** Campaigns inspected but unchanged (still in flight / already completed). */
  skipped: number;
  failures: Array<{ campaignId: string; reason: string }>;
}

export type SendFn = (
  payload:
    | { name: string; data: Record<string, unknown> }
    | Array<{ name: string; data: Record<string, unknown> }>,
) => Promise<unknown>;

function allTracksTerminal(tracks: ReadonlyArray<CreatorTrack>): boolean {
  if (tracks.length === 0) return false; // never-started campaign isn't "done"
  return tracks.every((t) => TERMINAL_TRACK_STATES.has(t.state));
}

function verifiedCountOf(tracks: ReadonlyArray<CreatorTrack>): number {
  return tracks.filter((t) => t.state === "verified").length;
}

async function findRunningCampaigns(): Promise<Campaign[]> {
  const db = await getDb();
  const cursor = db
    .collection<{
      _id: unknown;
      brief: Campaign["brief"];
      status: Campaign["status"];
      stage: Campaign["stage"];
      tracks: CreatorTrack[];
      createdAt: Date;
      updatedAt: Date;
    }>(Collections.V2_CAMPAIGNS)
    .find({ status: "running" });
  const out: Campaign[] = [];
  for await (const c of cursor) {
    const { _id, ...rest } = c;
    out.push({ ...(rest as unknown as Omit<Campaign, "id">), id: String(_id) });
  }
  return out;
}

/**
 * Pure handler exported for tests. Production binds `inngest.send`.
 */
export async function campaignProgressionHandler(
  send: SendFn = (payload) => inngest.send(payload as Parameters<typeof inngest.send>[0]),
): Promise<CampaignProgressionResult> {
  const result: CampaignProgressionResult = {
    scanned: 0,
    reportRequested: 0,
    completedNoReport: 0,
    completedAfterReport: 0,
    skipped: 0,
    failures: [],
  };
  const campaigns = await findRunningCampaigns();
  for (const c of campaigns) {
    result.scanned++;
    try {
      // ── Transition A: outreach → performance ────────────────────────────
      if (c.stage === "outreach" && allTracksTerminal(c.tracks)) {
        const verified = verifiedCountOf(c.tracks);
        if (verified > 0) {
          await campaignRepo.patchStage(c.id, "performance");
          await send({
            name: Events.ReportDeliverRequest,
            data: { campaignId: c.id, trigger: "stage_transition", notes: "" },
          });
          result.reportRequested++;
          continue;
        }
        // verified == 0 → skip the report, go straight to completed.
        await campaignRepo.patchStage(c.id, "performance", "completed");
        result.completedNoReport++;
        continue;
      }

      // ── Transition B: performance + report exists → completed ───────────
      if (c.stage === "performance") {
        const latest = await reportRepo.latestForCampaign(c.id);
        if (latest) {
          await campaignRepo.patchStage(c.id, "performance", "completed");
          result.completedAfterReport++;
          continue;
        }
      }

      result.skipped++;
    } catch (err) {
      result.failures.push({
        campaignId: c.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

/**
 * Daily cron at 03:00 UTC.
 */
export const campaignProgression = inngest.createFunction(
  { id: "campaign-progression" },
  { cron: "0 3 * * *" },
  () => campaignProgressionHandler(),
);
