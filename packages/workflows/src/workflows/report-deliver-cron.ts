import { Events, type Campaign, type CreatorTrack } from "@ss/contracts";
import { Collections, getDb, reportRepo } from "@ss/db";
import { inngest } from "../client";

/**
 * report-deliver-cron — Phase 4 P4-C3 weekly producer. Walks every
 * "running" campaign that has at least one verified track AND hasn't had
 * a report delivered in the last 6 days; emits one
 * `report/deliver.request` per row. The `report-deliver` workflow does
 * the actual compile + analyst + persist for each (concurrency=1 keyed
 * on campaignId so simultaneous crons don't double-deliver).
 *
 * Cadence: weekly Monday 09:00 UTC (= 18:00 KST — operator's morning).
 * The 6-day staleness floor means a manual export on Friday doesn't get
 * re-delivered Monday morning; the next cron run will pick it up two
 * weeks later. Crons skipped due to recency aren't an issue — the next
 * stage-transition or manual export covers them.
 */

export const STALE_REPORT_THRESHOLD_MS = 6 * 24 * 60 * 60 * 1000;

export interface ReportCronResult {
  scanned: number;
  /** Campaigns where we emitted a fresh request. */
  requested: number;
  /** Campaigns skipped because a report was delivered within the staleness floor. */
  skippedRecent: number;
  /** Campaigns skipped because no verified tracks yet (nothing to report on). */
  skippedNoVerified: number;
  failures: Array<{ campaignId: string; reason: string }>;
}

export type SendFn = (
  payload:
    | { name: string; data: Record<string, unknown> }
    | Array<{ name: string; data: Record<string, unknown> }>,
) => Promise<unknown>;

interface RunningCampaignRow {
  id: string;
  workspaceId: string;
  verifiedCount: number;
}

async function findRunningCampaigns(): Promise<RunningCampaignRow[]> {
  const db = await getDb();
  const cursor = db
    .collection<{
      _id: unknown;
      brief: Campaign["brief"];
      status: Campaign["status"];
      tracks: CreatorTrack[];
    }>(Collections.V2_CAMPAIGNS)
    .find({ status: "running" });
  const rows: RunningCampaignRow[] = [];
  for await (const c of cursor) {
    const verifiedCount = (c.tracks ?? []).filter((t) => t.state === "verified").length;
    rows.push({
      id: String(c._id),
      workspaceId: c.brief.workspaceId,
      verifiedCount,
    });
  }
  return rows;
}

/**
 * Pure handler exported for tests. Production binds `inngest.send`.
 */
export async function reportDeliverCronHandler(
  send: SendFn = (payload) => inngest.send(payload as Parameters<typeof inngest.send>[0]),
  now: Date = new Date(),
): Promise<ReportCronResult> {
  const result: ReportCronResult = {
    scanned: 0, requested: 0, skippedRecent: 0, skippedNoVerified: 0, failures: [],
  };
  const campaigns = await findRunningCampaigns();
  const stalenessFloor = new Date(now.getTime() - STALE_REPORT_THRESHOLD_MS);
  for (const c of campaigns) {
    result.scanned++;
    try {
      if (c.verifiedCount === 0) {
        result.skippedNoVerified++;
        continue;
      }
      const latest = await reportRepo.latestForCampaign(c.id);
      if (latest && latest.generatedAt > stalenessFloor) {
        result.skippedRecent++;
        continue;
      }
      await send({
        name: Events.ReportDeliverRequest,
        data: { campaignId: c.id, trigger: "cron", notes: "" },
      });
      result.requested++;
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
 * Weekly cron, Monday 09:00 UTC. Mirrors the shipment-tracking-poller /
 * tiktok-post-poller producer pattern (own cron, emits events, the durable
 * `report-deliver` workflow handles per-row execution).
 */
export const reportDeliverCron = inngest.createFunction(
  { id: "report-deliver-cron" },
  { cron: "0 9 * * 1" },
  () => reportDeliverCronHandler(),
);
