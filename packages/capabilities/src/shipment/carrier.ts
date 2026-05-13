import type { ShipmentCarrier, TrackingEvent } from "@ss/contracts";

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

async function defaultCarrierClientFactory(carrier: ShipmentCarrier): Promise<CarrierClient> {
  // The yuntrack-backed factory needs YUNTRACK_API_KEY at invocation time;
  // until that wiring (Phase-3.5 follow-up port of
  // `~/social-seeding/src/lib/tracking/yuntrack.ts`) lands, throw loudly.
  throw new Error(
    `defaultCarrierClientFactory: carrier='${carrier}' is not wired yet — set up the real ` +
      "carrier SDK or inject a fake via setCarrierClient(...) for tests.",
  );
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
