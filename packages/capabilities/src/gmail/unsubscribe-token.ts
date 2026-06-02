/**
 * HMAC-signed unsubscribe tokens for cold outreach — port of v1
 * `~/social-seeding/src/lib/email-unsubscribe-token.ts` (issue #1018 Phase 1).
 *
 * Token format: `${base64url(payload)}.${base64url(hmac)}`.
 *   payload = JSON({ rid, cid, iat, exp })  // unix seconds
 *   hmac    = HMAC-SHA256(currentSecret, base64url(payload))
 *
 * ## Why a dedicated secret
 *
 * v1's adversarial review flagged that reusing an account-restore secret would
 * stack three independent trust domains on a single key — an unsubscribe-token
 * leak would become an account-restore bypass. v2 keeps the same isolation:
 * reads `EMAIL_UNSUBSCRIBE_HMAC_SECRET` (≥ 16 chars), refuses to sign or
 * verify without it.
 *
 * ## Why dual-secret rotation
 *
 * CAN-SPAM §5 requires unsubscribe links to keep working for ≥ 10 days after
 * the message is sent. A single-secret scheme would invalidate every in-flight
 * link on rotation. Verify accepts either `EMAIL_UNSUBSCRIBE_HMAC_SECRET`
 * (current) OR `EMAIL_UNSUBSCRIBE_HMAC_SECRET_PREVIOUS` (retiring); sign always
 * uses the current secret.
 *
 * Default TTL: 30 days. The CAN-SPAM minimum is 10 days; 30 matches the v1
 * default and gives operators a generous margin to rotate.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_TTL_SECONDS = 60 * 24 * 60 * 60;
const MIN_SECRET_LEN = 16;

export interface UnsubscribeTokenPayload {
  /** recipient identifier — the v2 creator track id (or email fingerprint). */
  rid: string;
  /** campaign identifier — correlates back to the campaign that sent it. */
  cid: string;
  /** issued-at, unix seconds. */
  iat: number;
  /** expires-at, unix seconds. */
  exp: number;
}

export type UnsubscribeVerifyResult =
  | { valid: true; rid: string; cid: string; iat: number; exp: number }
  | { valid: false; reason: "malformed" | "bad_signature" | "expired" | "not_configured" };

function readCurrentSecret(): string {
  const s = process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET;
  if (!s || s.length < MIN_SECRET_LEN) {
    throw new Error(
      `EMAIL_UNSUBSCRIBE_HMAC_SECRET is not configured (need ≥ ${MIN_SECRET_LEN} chars). ` +
        "Refusing to sign or verify unsubscribe tokens.",
    );
  }
  return s;
}

function readPreviousSecret(): string | null {
  const s = process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET_PREVIOUS;
  if (!s || s.length < MIN_SECRET_LEN) return null;
  return s;
}

function base64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Buffer {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payloadPart: string, secret: string): string {
  return base64urlEncode(createHmac("sha256", secret).update(payloadPart).digest());
}

export interface SignUnsubscribeOptions {
  /** override default TTL (seconds). Clamped to [60, 60d]. */
  ttlSeconds?: number;
}

/**
 * Mint a new unsubscribe token. Called once per (recipient × send) at email
 * render time — the resulting token goes into the footer URL.
 */
export function signUnsubscribeToken(
  rid: string,
  cid: string,
  opts: SignUnsubscribeOptions = {},
): string {
  if (!rid) throw new Error("signUnsubscribeToken: rid required");
  if (!cid) throw new Error("signUnsubscribeToken: cid required");
  const secret = readCurrentSecret();
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.min(Math.max(opts.ttlSeconds ?? DEFAULT_TTL_SECONDS, 60), MAX_TTL_SECONDS);
  const payload: UnsubscribeTokenPayload = { rid, cid, iat: now, exp: now + ttl };
  const payloadPart = base64urlEncode(Buffer.from(JSON.stringify(payload)));
  const sigPart = sign(payloadPart, secret);
  return `${payloadPart}.${sigPart}`;
}

/**
 * Verify a token (constant-time signature compare). Accepts either the current
 * or the previous secret so rotation doesn't kill in-flight links.
 */
export function verifyUnsubscribeToken(token: string): UnsubscribeVerifyResult {
  if (!token || typeof token !== "string") return { valid: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 2) return { valid: false, reason: "malformed" };
  const [payloadPart, sigPart] = parts;
  if (!payloadPart || !sigPart) return { valid: false, reason: "malformed" };

  let currentSecret: string;
  try {
    currentSecret = readCurrentSecret();
  } catch {
    return { valid: false, reason: "not_configured" };
  }
  const previousSecret = readPreviousSecret();
  const candidates = [sign(payloadPart, currentSecret)];
  if (previousSecret) candidates.push(sign(payloadPart, previousSecret));

  let sigOk = false;
  for (const expected of candidates) {
    const a = Buffer.from(sigPart);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      sigOk = true;
      break;
    }
  }
  if (!sigOk) return { valid: false, reason: "bad_signature" };

  let payload: UnsubscribeTokenPayload;
  try {
    payload = JSON.parse(base64urlDecode(payloadPart).toString("utf8")) as UnsubscribeTokenPayload;
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (
    !payload ||
    typeof payload.rid !== "string" ||
    typeof payload.cid !== "string" ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number"
  ) {
    return { valid: false, reason: "malformed" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) return { valid: false, reason: "expired" };
  return { valid: true, rid: payload.rid, cid: payload.cid, iat: payload.iat, exp: payload.exp };
}

/**
 * Compose the unsubscribe URL the email footer points at. `baseUrl` is the
 * workspace's public MC origin (e.g. `https://agents.socialseed.ing`) — Phase 2
 * resolves this from the policy / workspace config; for now the caller passes
 * it in so this stays pure.
 */
export function unsubscribeUrl(baseUrl: string, token: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return `${trimmed}/unsubscribe?token=${encodeURIComponent(token)}`;
}
