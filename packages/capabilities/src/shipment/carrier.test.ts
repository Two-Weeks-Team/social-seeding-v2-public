import { afterEach, describe, expect, it } from "vitest";
import { TrackingEventSchema } from "@ss/contracts";
import {
  demoCarrierClient,
  getCarrierClientFactory,
  setCarrierClientFactory,
} from "./carrier";

/**
 * #29 P0-A — carrier gate unblock. The default factory must yield a working
 * deterministic carrier when no YUNTRACK_API_KEY is set (so the full campaign
 * loop can reach `delivered` → content_review → performance), and must fail
 * loudly when a key IS set (real yuntrack port is a follow-up — no silent fake).
 */

afterEach(() => {
  setCarrierClientFactory(undefined);
  delete process.env.YUNTRACK_API_KEY;
});

const FIXED_NOW = new Date("2026-06-01T00:00:00Z").getTime();

describe("demoCarrierClient", () => {
  it("createShipment returns a deterministic SSDEMO tracking number + ETA", async () => {
    const c = demoCarrierClient(() => FIXED_NOW);
    const input = {
      recipientName: "Jiwoo", phone: "", line1: "12 Garosu-gil", line2: "",
      city: "Seoul", region: "", postalCode: "06000", countryCode: "KR",
      weightGrams: 120, declaredValueUsdCents: 1500, reference: "campaign:wooriliu creator:@glow",
    };
    const a = await c.createShipment(input);
    const b = await c.createShipment(input);
    expect(a.trackingNumber).toMatch(/^SSDEMO\d{6}$/);
    expect(a.trackingNumber).toBe(b.trackingNumber); // deterministic
    expect(a.estimatedDeliveryAt?.getTime()).toBe(FIXED_NOW + 2 * 24 * 60 * 60 * 1000);
  });

  it("trackShipment returns a valid timeline whose NEWEST event is 'delivered'", async () => {
    const c = demoCarrierClient(() => FIXED_NOW);
    const { events } = await c.trackShipment("SSDEMO123456");
    // every event validates against the contract
    for (const e of events) expect(TrackingEventSchema.safeParse(e).success).toBe(true);
    // chronological newest = delivered (track.ts sorts asc; last wins → shipment delivered)
    const newest = [...events].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()).at(-1);
    expect(newest?.status).toBe("delivered");
    // the timeline progresses through the expected statuses
    const statuses = events.map((e) => e.status);
    expect(statuses).toContain("shipped");
    expect(statuses).toContain("in_transit");
    expect(statuses).toContain("out_for_delivery");
    expect(statuses).toContain("delivered");
  });
});

describe("defaultCarrierClientFactory", () => {
  it("no YUNTRACK_API_KEY → returns the deterministic demo client (loop can reach delivered)", async () => {
    delete process.env.YUNTRACK_API_KEY;
    const client = await getCarrierClientFactory()("yuntrack");
    const { events } = await client.trackShipment("SSDEMO999999");
    expect(events.at(-1)?.status ?? events[0]?.status).toBeDefined();
    const delivered = events.some((e) => e.status === "delivered");
    expect(delivered).toBe(true);
  });

  it("YUNTRACK_API_KEY set → throws (real yuntrack port pending, no silent fake)", async () => {
    process.env.YUNTRACK_API_KEY = "test-key";
    await expect(getCarrierClientFactory()("yuntrack")).rejects.toThrow(/not ported yet|follow-up/i);
  });
});
