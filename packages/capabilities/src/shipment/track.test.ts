import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TrackingEvent } from "@ss/contracts";
import { closeMongo, Collections, getDb, shipmentRepo } from "@ss/db";
import { shipmentCreate } from "./create";
import { shipmentTrack } from "./track";
import { setCarrierClientFactory, type CarrierClient } from "./carrier";

/**
 * P3-C2 — shipment.track. Drives a freshly-created shipment through several
 * carrier polls; verifies:
 *   · new events get appended (with deltas only — no duplicate events),
 *   · status flips when the carrier emits a mapped status,
 *   · a second poll right after the first is a no-op when the carrier returns
 *     no new events,
 *   · a shipment without a tracking number returns the row untouched (no
 *     carrier round-trip).
 */

const ctx = {
  workspaceId: "ws_3t",
  userId: "u".repeat(21),
  campaignId: "camp_3t",
  rateLimitClass: "shipment" as const,
};

interface FakeSpy extends CarrierClient {
  trackCalls: number;
  /** Per-call events injected via setEvents([…]). Resets to [] after read. */
  setEvents(events: TrackingEvent[]): void;
}
function fakeCarrier(initialTracking = "YT-AUTO"): FakeSpy {
  let pending: TrackingEvent[] = [];
  const f: FakeSpy = {
    trackCalls: 0,
    setEvents(events: TrackingEvent[]) {
      pending = events;
    },
    async createShipment() {
      return { trackingNumber: initialTracking };
    },
    async trackShipment() {
      f.trackCalls++;
      const out = pending;
      pending = []; // by default, the next call sees nothing new
      return { events: out };
    },
  };
  return f;
}

beforeAll(() => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set — start scripts/dev-mongo first");
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.V2_SHIPMENTS).deleteMany({});
});

afterEach(() => setCarrierClientFactory(undefined));

afterAll(async () => { await closeMongo(); });

async function setup(): Promise<string> {
  const c = fakeCarrier("YT-12345");
  setCarrierClientFactory(async () => c);
  const s = await shipmentCreate.handler(
    {
      campaignId: "camp_3t",
      creatorTrackId: "camp_3t:cr_a",
      creatorId: "cr_a",
      carrier: "yuntrack",
      shippingAddress: {
        recipientName: "Jiwoo",
        phone: "",
        line1: "x",
        line2: "",
        city: "Seoul",
        region: "",
        postalCode: "00000",
        countryCode: "KR",
      },
      products: [{ sku: "x", name: "x", valueUsdCents: 100, weightGrams: 50 }],
      reference: "",
      notes: "",
    },
    ctx,
  );
  return s.id;
}

describe("shipment.track", () => {
  it("first poll: appends new events, flips status to the latest mapped status", async () => {
    const id = await setup();
    const c = fakeCarrier(); // reset to a fresh tracking client
    setCarrierClientFactory(async () => c);
    c.setEvents([
      {
        timestamp: new Date("2026-06-02T08:00:00Z"),
        statusCode: "IN_TRANSIT",
        status: "in_transit",
        location: "Seoul Hub",
        description: "Departed",
      },
      {
        timestamp: new Date("2026-06-04T14:00:00Z"),
        statusCode: "DELIVERED",
        status: "delivered",
        location: "Recipient",
        description: "Signed by Jiwoo",
      },
    ]);
    const out = await shipmentTrack.handler({ shipmentId: id }, ctx);
    expect(c.trackCalls).toBe(1);
    expect(out.newEvents).toHaveLength(2);
    expect(out.status).toBe("delivered");
    expect(out.shipment.trackingEvents.length).toBeGreaterThanOrEqual(3); // CREATED + 2 new
    expect(out.shipment.deliveredAt).toEqual(new Date("2026-06-04T14:00:00Z"));
  });

  it("second poll with no new events ⇒ newEvents=[], status unchanged", async () => {
    const id = await setup();
    const c = fakeCarrier();
    setCarrierClientFactory(async () => c);
    c.setEvents([
      {
        timestamp: new Date("2026-06-02T08:00:00Z"),
        statusCode: "IN_TRANSIT",
        status: "in_transit",
        location: "x",
        description: "x",
      },
    ]);
    await shipmentTrack.handler({ shipmentId: id }, ctx);
    // second call: carrier returns [] (pending was already drained)
    const out2 = await shipmentTrack.handler({ shipmentId: id }, ctx);
    expect(c.trackCalls).toBe(2);
    expect(out2.newEvents).toEqual([]);
    expect(out2.status).toBe("in_transit");
  });

  it("dedupes by (timestamp, statusCode) — same event from a re-poll is skipped", async () => {
    const id = await setup();
    const c = fakeCarrier();
    setCarrierClientFactory(async () => c);
    const evt: TrackingEvent = {
      timestamp: new Date("2026-06-02T08:00:00Z"),
      statusCode: "IN_TRANSIT",
      status: "in_transit",
      location: "x",
      description: "x",
    };
    c.setEvents([evt]);
    const first = await shipmentTrack.handler({ shipmentId: id }, ctx);
    c.setEvents([evt]); // carrier returns the same event again
    const second = await shipmentTrack.handler({ shipmentId: id }, ctx);
    expect(first.newEvents).toHaveLength(1);
    expect(second.newEvents).toHaveLength(0);
    expect(second.shipment.trackingEvents.length).toBe(first.shipment.trackingEvents.length);
  });

  it("no tracking number yet (status='pending') ⇒ returns row untouched, no carrier call", async () => {
    // Insert a direct pending row (skipping shipment.create's mandatory carrier path).
    const s = await shipmentRepo.create({
      campaignId: "camp_3t",
      creatorTrackId: "camp_3t:cr_no_tracking",
      creatorId: "cr_no_tracking",
      status: "pending",
      carrier: "yuntrack",
      trackingNumber: "",
      shippingAddress: {
        recipientName: "x",
        phone: "",
        line1: "x",
        line2: "",
        city: "",
        region: "",
        postalCode: "",
        countryCode: "KR",
      },
      products: [{ sku: "x", name: "x", valueUsdCents: 0, weightGrams: 0 }],
      trackingEvents: [],
      notes: "",
    });
    const c = fakeCarrier();
    setCarrierClientFactory(async () => c);
    const out = await shipmentTrack.handler({ shipmentId: s.id }, ctx);
    expect(c.trackCalls).toBe(0);
    expect(out.status).toBe("pending");
  });

  it("missing shipmentId ⇒ throws", async () => {
    await expect(
      shipmentTrack.handler({ shipmentId: "000000000000000000000000" }, ctx),
    ).rejects.toThrow(/no shipment with id/);
  });
});
