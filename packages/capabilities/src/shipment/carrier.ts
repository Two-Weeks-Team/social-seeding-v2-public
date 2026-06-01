import type { ShipmentCarrier, ShipmentStatus, TrackingEvent } from "@ss/contracts";

/**
 * Injectable carrier-client seam — same pattern as the `GmailClient` /
 * `TikTokFetcher` seams. Real carrier integrations (yuntrack + future
 * additions) plug in via `setCarrierClient`; tests inject deterministic
 * fakes.
 *
 * The narrow surface area is intentional — every carrier-specific quirk
 * (auth headers, status-code maps, retry policy) lives behind the same
 * three methods. v1's `lib/tracking/yuntrack.ts` ports cleanly into a
 * concrete `yuntrackClient` implementation that the default factory
 * builds when `YUNTRACK_API_KEY` is set; that wiring is a Phase-3.5
 * follow-up (see HANDOFF). For Phase-3 demo, the default factory throws
 * the clear `not wired` error the rest of v2's seams use.
 */

export interface CarrierCreateInput {
  /** Same shape as `Shipment.shippingAddress` — see @ss/contracts. */
  recipientName: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2. */
  countryCode: string;
  /** Total grams (sum across product weights). */
  weightGrams: number;
  /** USD cents (for customs / cost tracking). */
  declaredValueUsdCents: number;
  /** Free-form one-line summary for the carrier's UI. */
  reference: string;
}

export interface CarrierCreateResult {
  trackingNumber: string;
  /** Carrier's idea of when the package will arrive. */
  estimatedDeliveryAt?: Date;
}

export interface CarrierTrackResult {
  /** Carrier's current top-level status, mapped to our enum at the repo boundary. */
  events: TrackingEvent[];
}

export interface CarrierClient {
  /**
   * Hand a package off to the carrier. Returns the tracking number that
   * v2_shipments stores as the join key. The carrier may also return an
   * ETA; the workflow uses it for the wait-loop deadline.
   */
  createShipment(input: CarrierCreateInput): Promise<CarrierCreateResult>;
  /**
   * Pull the latest tracking events for a known number. The poller calls
   * this on a per-shipment cycle; the repo dedupes by (timestamp,
   * statusCode) so the same event isn't appended twice.
   */
  trackShipment(trackingNumber: string): Promise<CarrierTrackResult>;
}

export type CarrierClientFactory = (carrier: ShipmentCarrier) => Promise<CarrierClient>;

/**
 * Deterministic offline carrier — a faithful port of v1's
 * `getEnhancedFallbackData` (`~/.../social-seeding-frontend/src/lib/tracking/
 * yuntrack.ts`): a fixed Seller → warehouse → export → in-transit → customs →
 * out-for-delivery → delivered timeline. No network, no key, fully
 * reproducible. This is what the default factory returns when no
 * `YUNTRACK_API_KEY` is set — it lets the full campaign loop reach
 * `delivered` (and therefore content_review → performance) in a demo run.
 *
 * HONEST SCOPE: this is a DETERMINISTIC DEMO timeline, not a live carrier
 * scrape. The real yuntrack integration (network scrape / API) is the
 * follow-up that activates when `YUNTRACK_API_KEY` is present.
 */
const DEMO_TIMELINE: ReadonlyArray<{ daysBack: number; status: ShipmentStatus; location: string; desc: string }> = [
  { daysBack: 9.5, status: "pending", location: "Seller", desc: "Parcel information created" },
  { daysBack: 9.2, status: "pending", location: "YunExpress Warehouse", desc: "Shipment information received" },
  { daysBack: 8.4, status: "shipped", location: "YunExpress Warehouse", desc: "Package processed at facility" },
  { daysBack: 7.0, status: "shipped", location: "China Export Hub", desc: "Export clearance completed" },
  { daysBack: 5.0, status: "in_transit", location: "Destination Airport", desc: "Arrived at destination country" },
  { daysBack: 3.5, status: "in_transit", location: "Customs", desc: "Customs clearance completed" },
  { daysBack: 1.5, status: "in_transit", location: "Local Distribution Center", desc: "Arrived at local delivery facility" },
  { daysBack: 0.4, status: "out_for_delivery", location: "Local Courier", desc: "Out for delivery" },
  { daysBack: 0.1, status: "delivered", location: "Destination", desc: "Delivered - Signed by recipient" },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Build the deterministic demo carrier client (no network, no key). */
export function demoCarrierClient(now: () => number = Date.now): CarrierClient {
  return {
    async createShipment(input: CarrierCreateInput): Promise<CarrierCreateResult> {
      const seed = `${input.recipientName}|${input.reference}`;
      const hash = Array.from(seed).reduce((acc, c) => acc + c.charCodeAt(0), 0);
      return {
        trackingNumber: `SSDEMO${100000 + (hash % 900000)}`,
        estimatedDeliveryAt: new Date(now() + 2 * DAY_MS),
      };
    },
    async trackShipment(trackingNumber: string): Promise<CarrierTrackResult> {
      const base = now();
      const events: TrackingEvent[] = DEMO_TIMELINE.map((t) => ({
        timestamp: new Date(base - t.daysBack * DAY_MS),
        statusCode: t.status,
        status: t.status,
        location: t.location,
        description: `(${t.location}) ${t.desc} [demo:${trackingNumber}]`,
      }));
      return { events };
    },
  };
}

async function defaultCarrierClientFactory(carrier: ShipmentCarrier): Promise<CarrierClient> {
  // With a real key present we must NOT silently fake a live carrier — the
  // real yuntrack network integration is a follow-up (issue #29). Fail loudly
  // so prod doesn't mistake demo data for live tracking.
  if (process.env.YUNTRACK_API_KEY) {
    throw new Error(
      `defaultCarrierClientFactory: live yuntrack integration for carrier='${carrier}' is not ported yet ` +
        "(issue #29 follow-up). Unset YUNTRACK_API_KEY to use the deterministic demo carrier, " +
        "or inject a client via setCarrierClientFactory(...).",
    );
  }
  // No key → deterministic, offline demo timeline (Seller → … → delivered).
  return demoCarrierClient();
}

let _factory: CarrierClientFactory | undefined;

export function getCarrierClientFactory(): CarrierClientFactory {
  return (_factory ??= defaultCarrierClientFactory);
}

/** Pass `undefined` to reset to the default. */
export function setCarrierClientFactory(f: CarrierClientFactory | undefined): void {
  _factory = f;
}

export { defaultCarrierClientFactory };
