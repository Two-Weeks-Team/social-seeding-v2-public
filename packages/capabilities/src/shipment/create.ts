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
    // Sequential-idempotency fast path: an already-shipped row for this
    // creatorTrackId just returns. The atomic claim below handles the
    // concurrent race (codex review P1#2); this branch handles the more
    // common manual-replay / re-run-after-completion case.
    const existing = await shipmentRepo.findByCreatorTrack(input.creatorTrackId);
    if (existing && existing.status !== "pending") return existing;
    if (
      existing &&
      existing.status === "pending" &&
      existing.updatedAt &&
      Date.now() - existing.updatedAt.getTime() < 30_000
    ) {
      throw new Error(
        `shipment.create: concurrent_create (another worker is mid-carrier-call for creatorTrackId=${input.creatorTrackId})`,
      );
    }

    // Atomic claim — backed by the unique index on creatorTrackId.
    const claim = await shipmentRepo.claim({
      campaignId: input.campaignId,
      creatorTrackId: input.creatorTrackId,
      creatorId: input.creatorId,
      carrier: input.carrier,
      shippingAddress: input.shippingAddress,
      products: input.products,
      notes: input.notes,
    });

    if (!claim.wonClaim) {
      // A racing worker won between our findByCreatorTrack and the claim.
      // If their row is already shipped → return it. If still pending and
      // fresh → refuse with concurrent_create (caller can retry). If stale
      // pending → conservatively refuse rather than racing them further.
      const r = claim.shipment;
      if (r.status !== "pending") return r;
      throw new Error(
        `shipment.create: concurrent_create (another worker holds creatorTrackId=${input.creatorTrackId})`,
      );
    }

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
    // Carrier-call success → seal the claim row as shipped. A failure above
    // leaves the row in status='pending'; a Phase-3.5 janitor will sweep
    // stale claims and either retry or mark them 'cancelled'.

    const finalized = await shipmentRepo.finalizeShipped(claim.shipment.id, {
      trackingNumber: created.trackingNumber,
      ...(created.estimatedDeliveryAt ? { estimatedDeliveryAt: created.estimatedDeliveryAt } : {}),
      carrier: input.carrier,
    });
    if (!finalized) {
      throw new Error(`shipment.create: claim row vanished mid-update (id=${claim.shipment.id})`);
    }
    return finalized;
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
