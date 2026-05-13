import { z } from "zod";
import {
  ShipmentSchema,
  ShipmentCarrierSchema,
  ShippingAddressSchema,
  ShipmentProductSchema,
  type ShipmentProduct,
  type ShippingAddress,
} from "@ss/contracts";
import { shipmentRepo } from "@ss/db";
import { defineCapability } from "../registry";
import { getCarrierClientFactory } from "./carrier";

/**
 * shipment.create — accept a parsed address + product manifest + the
 * creator-track identity, hand the package to the carrier via the injectable
 * client, and persist a v2_shipments row with status='shipped' and the
 * carrier-issued tracking number.
 *
 * Idempotency: keyed by `creatorTrackId`. A second call for the same track
 * returns the existing row instead of double-shipping.
 *
 * scope = "write" — this is an outbound side-effect (the carrier physically
 * picks up the package). Always behind the approveShipment gate at the
 * workflow level (creator-track Phase-3 wiring in C4).
 */

const CreateInputSchema = z.object({
  campaignId: z.string().min(1),
  creatorTrackId: z.string().min(1),
  creatorId: z.string().min(1),
  carrier: ShipmentCarrierSchema.default("yuntrack"),
  shippingAddress: ShippingAddressSchema,
  products: z.array(ShipmentProductSchema).min(1),
  /** Optional one-line label the carrier shows in their UI. */
  reference: z.string().default(""),
  notes: z.string().default(""),
});

export const shipmentCreate = defineCapability({
  name: "shipment.create",
  description:
    "Hand a package off to the carrier and persist a v2_shipments row. External side-effect — gated by approveShipment at the workflow level. Idempotent per creatorTrackId.",
  scope: "write",
  idempotent: true,
  rateLimitClass: "shipment",
  input: CreateInputSchema,
  output: ShipmentSchema,
  async handler(input, _ctx) {
    // Idempotency by creatorTrackId — the workflow's step.run already
    // guards against double-execution per-step, but a second creator-track
    // run (manual replay / a follow-up campaign reusing the same id pair)
    // shouldn't double-ship.
    const existing = await shipmentRepo.findByCreatorTrack(input.creatorTrackId);
    if (existing) return existing;

    const weightGrams = sumWeight(input.products);
    const declaredValueUsdCents = sumValue(input.products);
    const reference =
      input.reference ||
      `${input.campaignId.slice(0, 8)}:${input.creatorId.slice(0, 12)}`;

    const factory = getCarrierClientFactory();
    const client = await factory(input.carrier);
    const created = await client.createShipment({
      ...flattenAddress(input.shippingAddress),
      weightGrams,
      declaredValueUsdCents,
      reference,
    });

    const now = new Date();
    return shipmentRepo.create({
      campaignId: input.campaignId,
      creatorTrackId: input.creatorTrackId,
      creatorId: input.creatorId,
      status: "shipped",
      carrier: input.carrier,
      trackingNumber: created.trackingNumber,
      shippingAddress: input.shippingAddress,
      products: input.products,
      trackingEvents: [
        {
          timestamp: now,
          statusCode: "CREATED",
          status: "shipped",
          location: "",
          description: `Shipment created with ${input.carrier} (tracking ${created.trackingNumber}).`,
        },
      ],
      ...(created.estimatedDeliveryAt ? { estimatedDeliveryAt: created.estimatedDeliveryAt } : {}),
      shippedAt: now,
      notes: input.notes,
    });
  },
});

function sumWeight(products: ShipmentProduct[]): number {
  return products.reduce((a, p) => a + p.weightGrams, 0);
}

function sumValue(products: ShipmentProduct[]): number {
  return products.reduce((a, p) => a + p.valueUsdCents, 0);
}

function flattenAddress(a: ShippingAddress): {
  recipientName: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
} {
  return {
    recipientName: a.recipientName,
    phone: a.phone,
    line1: a.line1,
    line2: a.line2,
    city: a.city,
    region: a.region,
    postalCode: a.postalCode,
    countryCode: a.countryCode,
  };
}
