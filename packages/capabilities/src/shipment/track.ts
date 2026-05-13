import { z } from "zod";
import { ShipmentSchema, ShipmentStatusSchema, TrackingEventSchema } from "@ss/contracts";
import { shipmentRepo } from "@ss/db";
import { defineCapability } from "../registry";
import { getCarrierClientFactory } from "./carrier";

/**
 * shipment.track — fetch the latest carrier events for a shipment + persist
 * the delta on v2_shipments. Idempotent per (shipmentId, event timestamp +
 * statusCode); calling twice in a row returns the same canonical row without
 * appending duplicates.
 *
 * The `tiktok-post-poller` cron (P3-C4) and the creator-track shipping
 * wait-loop (P3-C4) both call this. Scope = "read" because the carrier
 * already knows; we're just reflecting state.
 *
 * Status mapping: the carrier returns its own status codes. The carrier
 * client maps each event's `status` field to our v2 ShipmentStatus enum
 * (the repo also persists the raw `statusCode` for audit). When no event
 * carries a mapped status (informational-only events), the shipment's
 * top-level status is left untouched.
 */
export const shipmentTrack = defineCapability({
  name: "shipment.track",
  description:
    "Pull the latest carrier tracking events for a shipment, persist the delta, and return the canonical Shipment with its updated event timeline + status.",
  scope: "read",
  idempotent: true,
  rateLimitClass: "shipment",
  input: z.object({ shipmentId: z.string().min(1) }),
  output: z.object({
    shipment: ShipmentSchema,
    /** Newly-appended events from this call. Empty when the carrier had nothing new. */
    newEvents: z.array(TrackingEventSchema),
    /** The shipment's status after this poll — useful for the workflow's wait-loop branch. */
    status: ShipmentStatusSchema,
  }),
  async handler({ shipmentId }, _ctx) {
    const existing = await shipmentRepo.get(shipmentId);
    if (!existing) {
      throw new Error(`shipment.track: no shipment with id=${shipmentId}`);
    }
    if (!existing.trackingNumber) {
      // Shipment created but not yet handed off to carrier (status="pending"
      // or "address_pending"). Nothing to poll — return as-is.
      return { shipment: existing, newEvents: [], status: existing.status };
    }

    const factory = getCarrierClientFactory();
    const client = await factory(existing.carrier);
    const { events } = await client.trackShipment(existing.trackingNumber);

    // Snapshot the (timestamp, statusCode) pairs we already have to filter
    // the delta. The repo's appendTrackingEvent also dedupes, but doing it
    // here avoids N round-trips when the carrier returns the full timeline
    // on every poll.
    const seen = new Set(
      existing.trackingEvents.map((e) => `${e.timestamp.toISOString()}|${e.statusCode}`),
    );
    // Sort chronologically (oldest → newest). Codex review P2#4: some
    // carriers return their event list newest-first; if we appended in
    // their order, the LATEST status that wins on shipment.status would be
    // the OLDEST event in the batch — a delivered shipment could regress
    // to in_transit on the second poll. Sorting here means the last
    // append (and therefore the row's top-level status) is the newest event.
    const newEvents = events
      .filter((e) => !seen.has(`${e.timestamp.toISOString()}|${e.statusCode}`))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    let latest = existing;
    for (const e of newEvents) {
      const after = await shipmentRepo.appendTrackingEvent(shipmentId, e);
      if (after) latest = after;
    }

    return { shipment: latest, newEvents, status: latest.status };
  },
});
