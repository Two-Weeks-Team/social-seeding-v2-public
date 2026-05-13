import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ShippingAddress, ShipmentProduct } from "@ss/contracts";
import { closeMongo, Collections, getDb } from "@ss/db";
import { shipmentCreate } from "./create";
import { setCarrierClientFactory, type CarrierClient } from "./carrier";

/**
 * P3-C2 — shipment.create. Verifies:
 *   · carrier client is invoked with a flattened address + summed weight/value,
 *   · v2_shipments row is persisted with status='shipped' + the
 *     tracking-number + a creation event on the timeline,
 *   · idempotency: a second call for the same creatorTrackId returns the
 *     existing row instead of double-shipping.
 */

const ctx = {
  workspaceId: "ws_3",
  userId: "u".repeat(21),
  campaignId: "camp_3a",
  rateLimitClass: "shipment" as const,
};

const address: ShippingAddress = {
  recipientName: "Jiwoo",
  phone: "+82-10-0000-0000",
  line1: "12 Garosu-gil",
  line2: "Apt 301",
  city: "Seoul",
  region: "Gangnam-gu",
  postalCode: "06000",
  countryCode: "KR",
};

const product: ShipmentProduct = {
  sku: "HS-30ML",
  name: "Hydra Serum 30ml",
  valueUsdCents: 2900,
  weightGrams: 80,
};

interface FakeSpy extends CarrierClient {
  createCalls: number;
  lastCreateInput?: Parameters<CarrierClient["createShipment"]>[0];
}
function fakeCarrier(): FakeSpy {
  let n = 0;
  const f: FakeSpy = {
    createCalls: 0,
    async createShipment(input) {
      f.createCalls++;
      f.lastCreateInput = input;
      n++;
      return {
        trackingNumber: `YT${String(n).padStart(8, "0")}`,
        estimatedDeliveryAt: new Date("2026-06-05T12:00:00Z"),
      };
    },
    async trackShipment() {
      return { events: [] };
    },
  };
  return f;
}

beforeAll(async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set — start scripts/dev-mongo first");
  // Atomic-claim idempotency (codex review P3-P1#2) relies on the unique
  // index on creatorTrackId. scripts/init-indexes.ts creates it in prod;
  // here we mirror it so the test exercises the production path.
  const db = await getDb();
  await db
    .collection(Collections.V2_SHIPMENTS)
    .createIndex({ creatorTrackId: 1 }, { unique: true })
    .catch(() => undefined);
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.V2_SHIPMENTS).deleteMany({});
});

afterEach(() => setCarrierClientFactory(undefined));

afterAll(async () => { await closeMongo(); });

describe("shipment.create", () => {
  it("happy path: calls carrier, persists shipped row + creation event", async () => {
    const c = fakeCarrier();
    setCarrierClientFactory(async () => c);
    const out = await shipmentCreate.handler(
      {
        campaignId: "camp_3a",
        creatorTrackId: "camp_3a:cr_freshly",
        creatorId: "cr_freshly",
        carrier: "yuntrack",
        shippingAddress: address,
        products: [product],
        reference: "",
        notes: "demo seed",
      },
      ctx,
    );
    expect(c.createCalls).toBe(1);
    expect(c.lastCreateInput?.weightGrams).toBe(80);
    expect(c.lastCreateInput?.declaredValueUsdCents).toBe(2900);
    expect(c.lastCreateInput?.line1).toBe("12 Garosu-gil");
    expect(out.status).toBe("shipped");
    expect(out.trackingNumber).toBe("YT00000001");
    expect(out.trackingEvents).toHaveLength(1);
    expect(out.trackingEvents[0]?.statusCode).toBe("CREATED");
    expect(out.estimatedDeliveryAt).toBeInstanceOf(Date);
    expect(out.shippedAt).toBeInstanceOf(Date);
    expect(out.notes).toBe("demo seed");
  });

  it("concurrent race (codex review P3-P1#2): a fresh pending claim refuses subsequent in-flight callers", async () => {
    const c = fakeCarrier();
    setCarrierClientFactory(async () => c);
    // Pre-seed a pending claim row (mimics worker A having just inserted but
    // not yet completed the carrier call).
    const db = await getDb();
    await db.collection(Collections.V2_SHIPMENTS).insertOne({
      campaignId: "camp_3a",
      creatorTrackId: "camp_3a:cr_race",
      creatorId: "cr_race",
      status: "pending",
      carrier: "yuntrack",
      trackingNumber: "",
      shippingAddress: address,
      products: [product],
      trackingEvents: [],
      notes: "",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // Worker B's concurrent call must refuse rather than ship.
    await expect(
      shipmentCreate.handler(
        {
          campaignId: "camp_3a",
          creatorTrackId: "camp_3a:cr_race",
          creatorId: "cr_race",
          carrier: "yuntrack",
          shippingAddress: address,
          products: [product],
          reference: "",
          notes: "",
        },
        ctx,
      ),
    ).rejects.toThrow(/concurrent_create/);
    expect(c.createCalls).toBe(0);
  });

  it("idempotency: a second call for the same creatorTrackId returns the existing row, never re-calls the carrier", async () => {
    const c = fakeCarrier();
    setCarrierClientFactory(async () => c);
    const first = await shipmentCreate.handler(
      {
        campaignId: "camp_3a",
        creatorTrackId: "camp_3a:cr_freshly",
        creatorId: "cr_freshly",
        carrier: "yuntrack",
        shippingAddress: address,
        products: [product],
        reference: "",
        notes: "",
      },
      ctx,
    );
    const second = await shipmentCreate.handler(
      {
        campaignId: "camp_3a",
        creatorTrackId: "camp_3a:cr_freshly",
        creatorId: "cr_freshly",
        carrier: "yuntrack",
        shippingAddress: { ...address, recipientName: "different" }, // even with different input
        products: [product],
        reference: "",
        notes: "",
      },
      ctx,
    );
    expect(c.createCalls).toBe(1);
    expect(second.id).toBe(first.id);
    expect(second.shippingAddress.recipientName).toBe("Jiwoo"); // original wins
  });

  it("sums multi-product weight + value before handing to the carrier", async () => {
    const c = fakeCarrier();
    setCarrierClientFactory(async () => c);
    await shipmentCreate.handler(
      {
        campaignId: "camp_3a",
        creatorTrackId: "camp_3a:cr_freshly",
        creatorId: "cr_freshly",
        carrier: "yuntrack",
        shippingAddress: address,
        products: [
          product, // 80g / $29
          { sku: "HS-CARD", name: "Personal note", valueUsdCents: 100, weightGrams: 20 },
        ],
        reference: "",
        notes: "",
      },
      ctx,
    );
    expect(c.lastCreateInput?.weightGrams).toBe(100);
    expect(c.lastCreateInput?.declaredValueUsdCents).toBe(3000);
  });

  it("default carrier factory throws when the implementation isn't wired (no setCarrierClient → no silent success)", async () => {
    setCarrierClientFactory(undefined);
    await expect(
      shipmentCreate.handler(
        {
          campaignId: "camp_3a",
          creatorTrackId: "camp_3a:cr_x",
          creatorId: "cr_x",
          carrier: "yuntrack",
          shippingAddress: address,
          products: [product],
          reference: "",
          notes: "",
        },
        ctx,
      ),
    ).rejects.toThrow(/not wired/);
  });
});
