import { Events, type Shipment, type ShipmentStatus } from "@ss/contracts";
import { getDb, Collections } from "@ss/db";
import { invokeCapability } from "@ss/capabilities";
import { inngest } from "../client";

/**
 * shipment-tracking-poller — Phase 3 scheduled fn. Walks v2_shipments rows
 * with a non-terminal status + stale lastTrackedAt; for each, invokes
 * `shipment.track` (which the existing capability already does dedupe +
 * status-update for) and emits `shipment/tracking.updated` when the
 * status actually flipped.
 *
 * This is the producer creator-track's `await-shipment:…` step waits on
 * (codex review P3-full P1#1). Without it, real prod sits at terminalState=
 * 'shipped' until the 14-day timeout. The cron pulls the carrier and
 * fans the result out as an event.
 *
 * Cadence: every 12 hours (04:00 + 16:00 UTC). Skips rows touched in the
 * last 6 hours to stay under the carrier rate limit (codex review P3-full
 * P2#4 — `lastTrackedAt` is bumped on every successful poll, even no-op).
 */

/** Polls within this many ms are considered "recent" and skipped. */
export const STALE_POLL_THRESHOLD_MS = 6 * 60 * 60 * 1000;

/** Statuses that don't need further polling (carrier has done all it will). */
const TERMINAL_STATUSES: ReadonlySet<ShipmentStatus> = new Set([
  "delivered",
  "cancelled",
  "failed",
  "returned",
]);

export interface ShipmentPollResult {
  scanned: number;
  /** Polls that produced new tracking events. */
  updated: number;
  /** Polls that resulted in a status FLIP from the prior persisted status. */
  statusFlipped: number;
  /** No-op polls (skipped or empty carrier response). */
  skipped: number;
  failures: Array<{ shipmentId: string; reason: string }>;
}

export type SendFn = (
  payload: { name: string; data: Record<string, unknown> } | Array<{ name: string; data: Record<string, unknown> }>,
) => Promise<unknown>;

async function findPollable(now: Date): Promise<Shipment[]> {
  const db = await getDb();
  // Find shipments with a tracking number, non-terminal status, and either
  // never-polled or polled > STALE_POLL_THRESHOLD_MS ago.
  const cursor = db.collection<Shipment & { _id: unknown }>(Collections.V2_SHIPMENTS).find({
    trackingNumber: { $ne: "" },
    status: { $nin: [...TERMINAL_STATUSES] },
    $or: [
      { lastTrackedAt: { $exists: false } },
      { lastTrackedAt: { $lt: new Date(now.getTime() - STALE_POLL_THRESHOLD_MS) } },
    ],
  });
  const docs = await cursor.toArray();
  return docs.map((d) => {
    const { _id, ...rest } = d;
    return { ...(rest as Shipment), id: String(_id) };
  });
}

/**
 * Pure handler exported for tests — driven by an injectable send function
 * (production binds `inngest.send`; tests inject a recording fake).
 */
export async function shipmentTrackingPollerHandler(
  send: SendFn = (payload) => inngest.send(payload as Parameters<typeof inngest.send>[0]),
  now: Date = new Date(),
): Promise<ShipmentPollResult> {
  const result: ShipmentPollResult = { scanned: 0, updated: 0, statusFlipped: 0, skipped: 0, failures: [] };
  const pollable = await findPollable(now);
  for (const shipment of pollable) {
    result.scanned++;
    const prevStatus = shipment.status;
    try {
      const tracked = (await invokeCapability(
        "shipment.track",
        { shipmentId: shipment.id },
        {
          workspaceId: shipment.campaignId, // for the rate-limit class; not workspace-routed today
          userId: shipment.creatorId,
          campaignId: shipment.campaignId,
          rateLimitClass: "shipment",
        },
      )) as { newEvents: Array<unknown>; status: ShipmentStatus };
      if (tracked.newEvents.length === 0) {
        result.skipped++;
        continue;
      }
      result.updated++;
      if (tracked.status !== prevStatus) {
        result.statusFlipped++;
        await send({
          name: Events.ShipmentTrackingUpdated,
          data: {
            campaignId: shipment.campaignId,
            creatorTrackId: shipment.creatorTrackId,
            creatorId: shipment.creatorId,
            shipmentId: shipment.id,
            status: tracked.status,
            trackingNumber: shipment.trackingNumber,
          },
        });
      }
    } catch (err) {
      result.failures.push({
        shipmentId: shipment.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

/**
 * Every 12 hours. Off-peak alignment vs the daily TikTok-post-poller
 * (02:00) and gmail-watch-renew (04:00); shipment-poller fires at 04:00
 * AND 16:00 to give the workflow's 14-day wait two chances per day to
 * resolve on a status flip.
 */
export const shipmentTrackingPoller = inngest.createFunction(
  { id: "shipment-tracking-poller" },
  { cron: "0 4,16 * * *" },
  () => shipmentTrackingPollerHandler(),
);
