import { z } from "zod";

/**
 * Shipment contract — port of v1 `~/social-seeding/src/types/shipping.ts`,
 * trimmed for v2's narrower seeding-only use case.
 *
 * What we drop vs v1:
 *  · `followUpSettings` (followup is a creator-track workflow concern, not a
 *    shipment field).
 *  · `manualUpdates[]` (an MC operator's manual override goes through a
 *    normal capability call + audit trail, not a parallel list on the doc).
 *  · the verbose creator denormalization (`influencerName`, `productName`):
 *    we have the creatorTrackId + campaignId joins; render labels at read time.
 *
 * What we keep verbatim: status enum (so the v1 carrier integrations remain
 * a drop-in port), the tracking-event timeline, the shippingAddress shape.
 */

export const ShipmentStatusSchema = z.enum([
  "pending", // accepted, awaiting carrier pickup
  "address_pending", // creator hasn't confirmed an address yet
  "shipped", // handed off to carrier; tracking number issued
  "in_transit",
  "out_for_delivery",
  "delivered",
  "failed",
  "returned",
  "cancelled",
]);
export type ShipmentStatus = z.infer<typeof ShipmentStatusSchema>;

/**
 * Carriers we ship via — `other` is the escape hatch for one-off manual
 * tracking. v1 used `yuntrack` for K-beauty samples; v2 keeps the slot open
 * so adding more is a one-enum-line change.
 */
export const ShipmentCarrierSchema = z.enum(["yuntrack", "other"]);
export type ShipmentCarrier = z.infer<typeof ShipmentCarrierSchema>;

export const ShippingAddressSchema = z.object({
  recipientName: z.string().min(1),
  phone: z.string().default(""),
  /** Free-form first line (street + number + apt). */
  line1: z.string().min(1),
  /** Free-form second line (building, unit, etc.). */
  line2: z.string().default(""),
  city: z.string().default(""),
  /** State / province / region — empty for ISO-3166 single-tier countries. */
  region: z.string().default(""),
  postalCode: z.string().default(""),
  /** ISO 3166-1 alpha-2. Default "KR" given v1's K-beauty seeding focus. */
  countryCode: z.string().length(2).default("KR"),
});
export type ShippingAddress = z.infer<typeof ShippingAddressSchema>;

/**
 * One product in the shipment. v1 had richer fields (dimensions, value);
 * v2 keeps the demo-essentials only. Add fields additively as the carrier
 * integration needs them.
 */
export const ShipmentProductSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  /** USD cents for cost tracking; carrier APIs use whatever currency they prefer. */
  valueUsdCents: z.number().int().nonnegative().default(0),
  /** Grams; the carrier's customs forms need it. */
  weightGrams: z.number().nonnegative().default(0),
});
export type ShipmentProduct = z.infer<typeof ShipmentProductSchema>;

export const TrackingEventSchema = z.object({
  timestamp: z.coerce.date(),
  /** Carrier-specific status code (mapped from their event). */
  statusCode: z.string().default(""),
  /** Normalized ShipmentStatus the workflow branches on. */
  status: ShipmentStatusSchema.optional(),
  location: z.string().default(""),
  description: z.string().default(""),
});
export type TrackingEvent = z.infer<typeof TrackingEventSchema>;

export const ShipmentSchema = z.object({
  id: z.string(),
  campaignId: z.string(),
  /** `${campaignId}:${creatorId}` — same shape gmail.send + creator-track use. */
  creatorTrackId: z.string(),
  /** TikTok creator id (for joins back to accounts_tiktok / v2_creator_tracks). */
  creatorId: z.string(),
  status: ShipmentStatusSchema,
  carrier: ShipmentCarrierSchema.default("yuntrack"),
  /** Carrier-side identifier — empty until status=shipped. */
  trackingNumber: z.string().default(""),
  shippingAddress: ShippingAddressSchema,
  products: z.array(ShipmentProductSchema).min(1),
  /** Append-only timeline of carrier-reported events. Newest entry → current. */
  trackingEvents: z.array(TrackingEventSchema).default([]),
  /**
   * Last time we asked the carrier for an update. The poller skips shipments
   * touched in the last N minutes to stay under the carrier rate limit.
   */
  lastTrackedAt: z.coerce.date().optional(),
  estimatedDeliveryAt: z.coerce.date().optional(),
  deliveredAt: z.coerce.date().optional(),
  shippedAt: z.coerce.date().optional(),
  notes: z.string().default(""),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Shipment = z.infer<typeof ShipmentSchema>;

/**
 * Terminal-state set the creator-track workflow exits on. `failed` and
 * `returned` aren't terminal — they trigger a human-review approval but
 * don't close the track.
 */
export const TERMINAL_SHIPMENT_STATUSES: ReadonlySet<ShipmentStatus> = new Set([
  "delivered",
  "cancelled",
]);

export function isTerminalShipmentStatus(s: ShipmentStatus): boolean {
  return TERMINAL_SHIPMENT_STATUSES.has(s);
}
