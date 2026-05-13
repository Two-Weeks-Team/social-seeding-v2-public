/**
 * Gmail Pub/Sub message verification + parse — port of v1
 * `~/social-seeding/src/lib/pubsub/verify.ts`. Pure: no I/O, no SDK.
 *
 * Wire model: Google Cloud Pub/Sub delivers a JSON POST to our webhook
 * (`apps/web/app/api/webhooks/gmail/route.ts`). The payload envelope is
 * standard Pub/Sub; the `message.data` field is a base64-encoded JSON
 * `{ emailAddress, historyId }` from Gmail's push notification (see
 * https://developers.google.com/gmail/api/guides/push).
 *
 * Authentication strategy:
 *   1. `?token=…` query param vs `PUBSUB_AUTH_TOKEN` env. v1 production
 *      pattern — only thing GCP push subscriptions can natively attach
 *      since they can't add request headers.
 *   2. Bearer OIDC JWT (Authorization header) — recommended; not yet
 *      verified here because pulling in `google-auth-library` is a heavy
 *      dep for Phase-2 demo. Hook: extend `verifyAuth()` to check the JWT
 *      signature against Google's JWKS + the configured audience.
 *
 * `verifyAuth` returns true when EITHER token matches AND the request
 * looks like a Google-Cloud-Pub-Sub call (User-Agent / Content-Type).
 * Returns false otherwise — caller decides on the HTTP status (401 vs 200
 * with a no-op).
 */

export interface PubSubMessage {
  message: {
    data: string; // base64-encoded
    messageId: string;
    publishTime: string;
    attributes?: Record<string, string>;
  };
  subscription: string;
}

export interface GmailNotification {
  emailAddress: string;
  historyId: string;
}

export interface PubSubAuthHeaders {
  userAgent: string;
  contentType: string;
  /** Bearer JWT if present — verified upstream when google-auth-library is wired. */
  authorization?: string;
}

export interface PubSubAuthOpts {
  /** `?token=…` query parameter on the webhook URL. */
  queryToken?: string;
  /** The expected token from PUBSUB_AUTH_TOKEN env (resolved by the caller). */
  expectedToken?: string;
}

/**
 * Authenticate an inbound Pub/Sub call. Two-of-three checks:
 *   · User-Agent contains "google" (smoke check),
 *   · Content-Type includes "application/json",
 *   · ?token= matches PUBSUB_AUTH_TOKEN if both sides are set.
 *
 * Token check is short-circuit-strict: if `expectedToken` is set but
 * `queryToken` doesn't match, we return false even when other signals pass.
 * If `expectedToken` is unset, the route is open by environment policy
 * (dev-only).
 */
export function verifyPubSubAuth(headers: PubSubAuthHeaders, opts: PubSubAuthOpts = {}): boolean {
  const ua = headers.userAgent.toLowerCase();
  if (!ua.includes("google")) return false;
  if (!headers.contentType.toLowerCase().includes("application/json")) return false;
  if (opts.expectedToken) {
    if (opts.queryToken !== opts.expectedToken) return false;
  }
  return true;
}

/**
 * Parse the Pub/Sub envelope into the Gmail notification it wraps. Returns
 * `null` rather than throwing so the webhook can ack a 200 even on malformed
 * payloads (otherwise GCP will redeliver indefinitely).
 */
export function parsePubSubMessage(body: unknown): GmailNotification | null {
  if (!body || typeof body !== "object") return null;
  const env = body as Partial<PubSubMessage>;
  const data = env.message?.data;
  if (typeof data !== "string" || data.length === 0) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(data, "base64").toString("utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const n = parsed as Partial<GmailNotification>;
  if (typeof n.emailAddress !== "string" || typeof n.historyId !== "string") return null;
  if (n.emailAddress.length === 0 || n.historyId.length === 0) return null;
  return { emailAddress: n.emailAddress, historyId: n.historyId };
}

/**
 * Compose a Pub/Sub envelope for a Gmail notification. Test helper — same
 * shape Google would send, base64-encoded `{emailAddress, historyId}`.
 */
export function buildPubSubMessage(notification: GmailNotification): PubSubMessage {
  const data = Buffer.from(JSON.stringify(notification), "utf8").toString("base64");
  return {
    message: {
      data,
      messageId: `test_${Math.random().toString(36).slice(2)}`,
      publishTime: new Date().toISOString(),
    },
    subscription: "projects/test/subscriptions/test",
  };
}
