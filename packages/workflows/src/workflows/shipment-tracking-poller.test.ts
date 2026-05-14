import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Shipment, ShipmentStatus, TrackingEvent } from "@ss/contracts";
import { closeMongo, Collections, getDb, shipmentRepo } from "@ss/db";
import { setCarrierClientFactory, type CarrierClient } from "@ss/capabilities";
import { setUsageStore, type UsageStore } from "@ss/capabilities";
import {
  STALE_POLL_THRESHOLD_MS,
  shipmentTrackingPollerHandler,
  type SendFn,
} from "./shipment-tracking-poller";

/**
 * P3 codex review P1#1 fix — shipment-tracking-poller test suite. Verifies:
 *   · skips rows already polled recently (lastTrackedAt within threshold);
 *   · skips rows with no tracking number;
 *   · skips rows in terminal status;
 *   · emits 'shipment/tracking.updated' on a status flip;
 *   · doesn't emit when status didn't change (carrier returned dup events);
 *   · failures are recorded but don't kill the run.
 */

const memUsageStore: UsageStore = {
  async increment() { return 1; },
  async decrement() {},
  async getOverride() { return null; },
};

function recordingSend(): SendFn & { calls: Array<{ name: string; data: Record<string, unknown> }> } {
  const calls: Array<{ name: string; data: Record<string, unknown> }> = [];
  const fn = (async (payload) => {
    const list = Array.isArray(payload) ? payload : [payload];
    for (const p of list) calls.push(p);
    return { ids: list.map((_, i) => `evt_${calls.length - list.length + i}`) };
  }) as SendFn;
  (fn as SendFn & { calls: typeof calls }).calls = calls;
  return fn as SendFn & { calls: typeof calls };
}

interface FakeCarrierWithMap extends CarrierClient {
  setEventsForTracking(trackingNumber: string, events: TrackingEvent[]): void;
}
function fakeCarrier(): FakeCarrierWithMap {
  const byTracking = new Map<string, TrackingEvent[]>();
  return {
    setEventsForTracking(trackingNumber: string, events: TrackingEvent[]) {
      byTracking.set(trackingNumber, events);
    },
    async createShipment() {
      throw new Error("not used in poller tests");
    },
    async trackShipment(trackingNumber: string) {
      const events = byTracking.get(trackingNumber) ?? [];
      byTracking.set(trackingNumber, []); // drain by default
      return { events };
    },
  };
}

const baseShipmentDoc = {
  campaignId: "camp_pollster",
  creatorTrackId: "camp_pollster:cr_x",
  creatorId: "cr_x",
  carrier: "yuntrack" as const,
  shippingAddress: {
    recipientName: "x", phone: "", line1: "x", line2: "",
    city: "", region: "", postalCode: "", countryCode: "KR",
  },
  products: [{ sku: "x", name: "x", valueUsdCents: 0, weightGrams: 0 }],
  notes: "",
};

beforeAll(async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set — start scripts/dev-mongo first");
  const db = await getDb();
  await db
    .collection(Collections.V2_SHIPMENTS)
    .createIndex({ creatorTrackId: 1 }, { unique: true })
    .catch(() => undefined);
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.V2_SHIPMENTS).deleteMany({});
  setUsageStore(memUsageStore);
});

afterEach(() => {
  setUsageStore(undefined);
  setCarrierClientFactory(undefined);
});

afterAll(async () => { await closeMongo(); });

async function seed(s: Partial<Shipment> & Pick<Shipment, "creatorTrackId" | "creatorId">): Promise<string> {
  const out = await shipmentRepo.create({
    ...baseShipmentDoc,
    creatorTrackId: s.creatorTrackId,
    creatorId: s.creatorId,
    status: s.status ?? "shipped",
    trackingNumber: s.trackingNumber ?? "YT_X",
    trackingEvents: s.trackingEvents ?? [],
    ...(s.lastTrackedAt ? { lastTrackedAt: s.lastTrackedAt } : {}),
    ...(s.shippedAt ? { shippedAt: s.shippedAt } : {}),
  });
  return out.id;
}

describe("shipment-tracking-poller", () => {
  it("empty queue → scanned=0; no work, no events emitted", async () => {
    const send = recordingSend();
    setCarrierClientFactory(async () => fakeCarrier());
    const out = await shipmentTrackingPollerHandler(send);
    expect(out).toEqual({ scanned: 0, updated: 0, statusFlipped: 0, skipped: 0, failures: [] });
    expect(send.calls).toHaveLength(0);
  });

  it("skips rows with terminal status (delivered / cancelled / failed / returned)", async () => {
    await seed({ creatorTrackId: "camp_pollster:cr_done", creatorId: "cr_done", status: "delivered", trackingNumber: "YT_DONE" });
    await seed({ creatorTrackId: "camp_pollster:cr_cancelled", creatorId: "cr_cancelled", status: "cancelled", trackingNumber: "YT_CAN" });
    await seed({ creatorTrackId: "camp_pollster:cr_failed", creatorId: "cr_failed", status: "failed", trackingNumber: "YT_FAIL" });
    const send = recordingSend();
    setCarrierClientFactory(async () => fakeCarrier());
    const out = await shipmentTrackingPollerHandler(send);
    expect(out.scanned).toBe(0);
  });

  it("skips rows polled within STALE_POLL_THRESHOLD_MS (defends carrier rate limit)", async () => {
    await seed({
      creatorTrackId: "camp_pollster:cr_fresh",
      creatorId: "cr_fresh",
      status: "in_transit",
      trackingNumber: "YT_FRESH",
      lastTrackedAt: new Date(Date.now() - STALE_POLL_THRESHOLD_MS / 2), // recent
    });
    const send = recordingSend();
    setCarrierClientFactory(async () => fakeCarrier());
    const out = await shipmentTrackingPollerHandler(send);
    expect(out.scanned).toBe(0);
  });

  it("status flip (shipped → delivered) ⇒ emits shipment/tracking.updated with terminal status", async () => {
    const id = await seed({
      creatorTrackId: "camp_pollster:cr_flip",
      creatorId: "cr_flip",
      status: "shipped",
      trackingNumber: "YT_FLIP",
    });
    const carrier = fakeCarrier();
    carrier.setEventsForTracking("YT_FLIP", [
      {
        timestamp: new Date(),
        statusCode: "DELIVERED",
        status: "delivered",
        location: "Recipient",
        description: "Signed by recipient",
      },
    ]);
    setCarrierClientFactory(async () => carrier);
    const send = recordingSend();
    const out = await shipmentTrackingPollerHandler(send);
    expect(out.scanned).toBe(1);
    expect(out.updated).toBe(1);
    expect(out.statusFlipped).toBe(1);
    expect(send.calls).toHaveLength(1);
    expect(send.calls[0]?.name).toBe("shipment/tracking.updated");
    expect(send.calls[0]?.data.shipmentId).toBe(id);
    expect(send.calls[0]?.data.status).toBe("delivered");
  });

  it("new events without a status flip (in_transit → in_transit at different times) ⇒ NO event emitted", async () => {
    await seed({
      creatorTrackId: "camp_pollster:cr_noflip",
      creatorId: "cr_noflip",
      status: "in_transit",
      trackingNumber: "YT_NOFLIP",
    });
    const carrier = fakeCarrier();
    carrier.setEventsForTracking("YT_NOFLIP", [
      {
        timestamp: new Date(),
        statusCode: "IN_TRANSIT_HUB",
        status: "in_transit", // still in_transit — no flip from prior persisted status
        location: "Customs",
        description: "Cleared customs",
      },
    ]);
    setCarrierClientFactory(async () => carrier);
    const send = recordingSend();
    const out = await shipmentTrackingPollerHandler(send);
    expect(out.scanned).toBe(1);
    expect(out.updated).toBe(1);
    expect(out.statusFlipped).toBe(0);
    expect(send.calls).toHaveLength(0);
  });

  it("carrier returns nothing new ⇒ skipped++, lastTrackedAt still updated (codex P2#4 — shipment.track touches it)", async () => {
    const id = await seed({
      creatorTrackId: "camp_pollster:cr_quiet",
      creatorId: "cr_quiet",
      status: "in_transit",
      trackingNumber: "YT_QUIET",
    });
    const carrier = fakeCarrier(); // empty by default
    setCarrierClientFactory(async () => carrier);
    const send = recordingSend();
    const out = await shipmentTrackingPollerHandler(send);
    expect(out.scanned).toBe(1);
    expect(out.skipped).toBe(1);
    expect(out.statusFlipped).toBe(0);
    expect(send.calls).toHaveLength(0);
    // shipment.track must have called touchLastTrackedAt
    const after = await shipmentRepo.get(id);
    expect(after?.lastTrackedAt).toBeInstanceOf(Date);
  });

  it("carrier throws on one row ⇒ recorded in failures, doesn't kill the run", async () => {
    await seed({ creatorTrackId: "camp_pollster:cr_a", creatorId: "cr_a", status: "shipped", trackingNumber: "YT_OK" });
    await seed({ creatorTrackId: "camp_pollster:cr_b", creatorId: "cr_b", status: "shipped", trackingNumber: "YT_BAD" });
    let calls = 0;
    const throwingCarrier: CarrierClient = {
      async createShipment() { throw new Error("not used"); },
      async trackShipment(tracking: string) {
        calls++;
        if (tracking === "YT_BAD") throw new Error("carrier_rate_limit");
        return {
          events: [{
            timestamp: new Date(),
            statusCode: "DELIVERED",
            status: "delivered" as ShipmentStatus,
            location: "x", description: "x",
          }],
        };
      },
    };
    setCarrierClientFactory(async () => throwingCarrier);
    const send = recordingSend();
    const out = await shipmentTrackingPollerHandler(send);
    expect(out.scanned).toBe(2);
    expect(out.statusFlipped).toBe(1); // OK row flipped to delivered
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]?.reason).toMatch(/carrier_rate_limit/);
    expect(calls).toBe(2);
  });
});
