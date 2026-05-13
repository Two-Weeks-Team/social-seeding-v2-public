import { ObjectId, type WithId } from "mongodb";
import {
  ShipmentSchema,
  type Shipment,
  type ShipmentStatus,
  type TrackingEvent,
} from "@ss/contracts";
import { getDb } from "../client";
import { Collections } from "../collections";

/**
 * Shipment repository — v2-owned `v2_shipments`. The logistics agent (write
 * path) and the carrier poller (status updates) are the only writers; the
 * creator-track workflow + MC read.
 */

type ShipmentDoc = Omit<Shipment, "id">;

async function col() {
  return (await getDb()).collection<ShipmentDoc>(Collections.V2_SHIPMENTS);
}

function toShipment(doc: WithId<ShipmentDoc>): Shipment {
  const { _id, ...rest } = doc;
  return ShipmentSchema.parse({ ...rest, id: String(_id) });
}

export const shipmentRepo = {
  async create(input: Omit<Shipment, "id" | "createdAt" | "updatedAt">): Promise<Shipment> {
    const c = await col();
    const now = new Date();
    const doc: ShipmentDoc = { ...input, createdAt: now, updatedAt: now };
    const res = await c.insertOne(doc);
    return { ...input, id: String(res.insertedId), createdAt: now, updatedAt: now };
  },

  /**
   * Atomic per-creatorTrackId claim — backs `shipment.create` against the
   * concurrent-create race that codex review P1#2 identified. The unique
   * index on `creatorTrackId` (init-indexes.ts) ensures at-most-one
   * concurrent claimant; the loser receives E11000 and we read back the
   * existing row to decide caller behaviour.
   */
  async claim(
    input: Omit<Shipment, "id" | "createdAt" | "updatedAt" | "status" | "trackingNumber" | "trackingEvents">,
  ): Promise<{ wonClaim: boolean; shipment: Shipment }> {
    const c = await col();
    const now = new Date();
    const doc: ShipmentDoc = {
      ...input,
      status: "pending",
      trackingNumber: "",
      trackingEvents: [],
      createdAt: now,
      updatedAt: now,
    };
    try {
      const res = await c.insertOne(doc);
      return {
        wonClaim: true,
        shipment: { ...doc, id: String(res.insertedId) },
      };
    } catch (err: unknown) {
      const code = (err as { code?: unknown })?.code;
      if (code !== 11000) throw err;
      const existing = await this.findByCreatorTrack(input.creatorTrackId);
      if (!existing) {
        throw new Error(
          `shipment.claim: duplicate-key but no row for creatorTrackId=${input.creatorTrackId} — likely a race window narrower than the read; retry.`,
        );
      }
      return { wonClaim: false, shipment: existing };
    }
  },

  async get(id: string): Promise<Shipment | null> {
    const c = await col();
    const doc = await c.findOne({ _id: new ObjectId(id) });
    return doc ? toShipment(doc) : null;
  },

  async findByCreatorTrack(creatorTrackId: string): Promise<Shipment | null> {
    const c = await col();
    const doc = await c.findOne({ creatorTrackId }, { sort: { createdAt: -1 } });
    return doc ? toShipment(doc) : null;
  },

  async listByCampaign(campaignId: string): Promise<Shipment[]> {
    const c = await col();
    const docs = await c.find({ campaignId }).sort({ updatedAt: -1 }).toArray();
    return docs.map(toShipment);
  },

  /**
   * Patch one tracking-event onto the timeline + reflect the latest status.
   * Updates `lastTrackedAt`, and (when the status flips into a milestone)
   * the corresponding shippedAt / deliveredAt field. Idempotent on the
   * event's timestamp+statusCode to make the poller safe to retry.
   */
  async appendTrackingEvent(
    id: string,
    event: TrackingEvent,
    statusOverride?: ShipmentStatus,
  ): Promise<Shipment | null> {
    const c = await col();
    const oid = new ObjectId(id);
    const now = new Date();

    // dedupe: skip if (timestamp, statusCode) already on the timeline.
    const existing = await c.findOne({
      _id: oid,
      "trackingEvents.timestamp": event.timestamp,
      "trackingEvents.statusCode": event.statusCode,
    });
    if (existing) {
      // Just bump lastTrackedAt so the poller doesn't loop.
      await c.updateOne({ _id: oid }, { $set: { lastTrackedAt: now, updatedAt: now } });
      return this.get(id);
    }

    const status = statusOverride ?? event.status;
    const set: Partial<ShipmentDoc> = { lastTrackedAt: now, updatedAt: now };
    if (status) set.status = status;
    if (status === "shipped") set.shippedAt = event.timestamp;
    if (status === "delivered") set.deliveredAt = event.timestamp;

    await c.updateOne(
      { _id: oid },
      {
        $push: { trackingEvents: event },
        $set: set,
      },
    );
    return this.get(id);
  },

  async patchStatus(id: string, status: ShipmentStatus, notes?: string): Promise<Shipment | null> {
    const c = await col();
    const set: Partial<ShipmentDoc> = { status, updatedAt: new Date() };
    if (notes !== undefined) set.notes = notes;
    if (status === "shipped" && !set.shippedAt) set.shippedAt = new Date();
    if (status === "delivered" && !set.deliveredAt) set.deliveredAt = new Date();
    await c.updateOne({ _id: new ObjectId(id) }, { $set: set });
    return this.get(id);
  },

  /**
   * Atomically seal a claimed (status='pending') row as shipped: set status,
   * trackingNumber, estimatedDeliveryAt, shippedAt, push the CREATED event.
   * Used by `shipment.create` once the carrier has returned a tracking number.
   */
  async finalizeShipped(
    id: string,
    args: {
      trackingNumber: string;
      estimatedDeliveryAt?: Date;
      carrier: Shipment["carrier"];
    },
  ): Promise<Shipment | null> {
    const c = await col();
    const now = new Date();
    const set: Partial<ShipmentDoc> = {
      status: "shipped",
      trackingNumber: args.trackingNumber,
      shippedAt: now,
      updatedAt: now,
    };
    if (args.estimatedDeliveryAt) set.estimatedDeliveryAt = args.estimatedDeliveryAt;
    const createdEvent: TrackingEvent = {
      timestamp: now,
      statusCode: "CREATED",
      status: "shipped",
      location: "",
      description: `Shipment created with ${args.carrier} (tracking ${args.trackingNumber}).`,
    };
    await c.updateOne(
      { _id: new ObjectId(id) },
      { $set: set, $push: { trackingEvents: createdEvent } },
    );
    return this.get(id);
  },
};
