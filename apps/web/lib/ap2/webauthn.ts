/**
 * WebAuthn helpers for AP2 Mandate signing.
 *
 * D-IDs touched:
 *   D19 — Identity Platform issues the operator's WebAuthn credentials;
 *         this module assumes the credential is already provisioned on the
 *         platform authenticator (Touch ID / Windows Hello / Android biometric)
 *         or roaming authenticator (YubiKey / Titan).
 *   D27 — every signing action is a fresh WebAuthn ceremony (no caching, §9.3
 *         anti-pattern in AP2-UX.md).
 *   R2 / R6 — server time is authoritative; client clocks are advisory only;
 *             the `nonce` is bound to the challenge and the verifier rejects
 *             replay within the 48 h jti window.
 *
 * Browser API contract:
 *   - `navigator.credentials.get(...)` returns a `PublicKeyCredential` with an
 *     `AuthenticatorAssertionResponse` payload. We base64url-encode the binary
 *     fields so they survive JSON transport to /api/approvals/[id]/sign-mandate.
 *   - The challenge embeds the Intent JWS hash (or, for bulk, the bundle hash)
 *     so the user is signing OVER the Mandate content, not just authenticating.
 *
 * Why we don't use `@simplewebauthn/browser` here:
 *   - The package is a thin wrapper around `navigator.credentials.*` and adds
 *     ~12 kB to the bundle. For a single ceremony we hand-roll the binary
 *     conversion. The server-side verifier in `/api/approvals/[id]/sign-mandate`
 *     uses `@simplewebauthn/server` (where the dep weight is justified by the
 *     CBOR + COSE parsing the server must do).
 *
 * Anti-pattern §9.3 (caching assertions): every call to `signMandate` /
 * `signBundle` MUST trigger a fresh `navigator.credentials.get`. The caller
 * is responsible for not memoising the return value.
 */
import type { Money } from "./mandate";
import { DEFAULT_ROAMING_THRESHOLD, moneyGreaterThanOrEqual, type AP2Locale } from "./mandate";

/**
 * Encode an `ArrayBuffer` (or `Uint8Array`) as base64url (RFC 4648 §5) — the
 * encoding WebAuthn uses on the wire.
 */
export function bufferToBase64Url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** Decode a base64url string back to a `Uint8Array`. */
export function base64UrlToBuffer(input: string): Uint8Array {
  const padLength = (4 - (input.length % 4)) % 4;
  const padded = input + "=".repeat(padLength);
  const bin = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

/**
 * Derived "freshness window" for an assertion. Per AP2-UX.md §3.6, every sign
 * action triggers a fresh challenge — but the server still validates `iat`
 * against ±5 minute server-time skew (R6).
 */
export const ASSERTION_FRESHNESS_WINDOW_MS = 5 * 60 * 1000;

/** Shape of a WebAuthn assertion as transported in `SignMandateRequest`. */
export interface SerializedAssertion {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
}

/**
 * Map a browser `PublicKeyCredential` to the JSON-safe shape the
 * `/api/approvals/[id]/sign-mandate` endpoint expects.
 */
export function serializeAssertion(credential: PublicKeyCredential): SerializedAssertion {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: "public-key",
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      authenticatorData: bufferToBase64Url(response.authenticatorData),
      signature: bufferToBase64Url(response.signature),
      userHandle: response.userHandle ? bufferToBase64Url(response.userHandle) : undefined,
    },
  };
}

/**
 * Whether the user agent supports WebAuthn at all. UI surfaces fall back to
 * a "open this Mandate on a supported device" message when this is false
 * (AP2-UX.md §4.4 — signing is online-only AND device-capable-only).
 */
export function isWebAuthnSupported(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof globalThis.PublicKeyCredential !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.credentials !== "undefined" &&
    typeof navigator.credentials.get === "function"
  );
}

/**
 * Whether the operator's device exposes a platform authenticator (Touch ID,
 * Windows Hello, Android biometric). Probe used by the inbox to decide
 * whether to render `[전체 서명]` as enabled vs. "open on supported device".
 */
export async function hasPlatformAuthenticator(): Promise<boolean> {
  if (!isWebAuthnSupported()) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/** Authenticator transport preference — drives the high-value step-up. */
export type AuthenticatorTransportPref = "platform" | "cross-platform" | "any";

/**
 * Decide which authenticator to require for a given Mandate amount.
 * Per AP2-UX.md §3.6 and §4.3:
 *   - amount < high-value threshold → platform OK
 *   - amount ≥ high-value threshold → roaming (cross-platform) required
 *
 * `locale` selects the default threshold; workspace policy may override.
 */
export function authenticatorTransportFor(
  amount: Money,
  locale: AP2Locale,
  overrideThreshold?: Money,
): AuthenticatorTransportPref {
  const threshold = overrideThreshold ?? DEFAULT_ROAMING_THRESHOLD[locale];
  // Threshold's currency must match the Mandate's currency. If not, the
  // caller is mixing currencies — be conservative and require cross-platform.
  if (amount.currency !== threshold.currency) {
    return "cross-platform";
  }
  return moneyGreaterThanOrEqual(amount, threshold) ? "cross-platform" : "platform";
}

/**
 * Build the WebAuthn `PublicKeyCredentialRequestOptions` for a single Mandate
 * signing ceremony.
 *
 * The challenge is the SHA-256 of the canonical Mandate JSON (the same hash
 * the server-side verifier will reconstruct from the stored Mandate); this
 * binds the assertion to the specific Mandate payload (anti-replay-across-
 * Mandates).
 *
 * Per AP2-UX.md §3.6:
 *   - userVerification: "required" (forces biometric, not just presence)
 *   - timeout: 60_000 (1 min — the assertion freshness window)
 *   - rpId: the eTLD+1 of the Mission Control origin (set by the caller).
 */
export interface BuildAssertionOptionsInput {
  challenge: Uint8Array;
  rpId: string;
  allowCredentialIds: Uint8Array[];
  transport: AuthenticatorTransportPref;
  timeoutMs?: number;
}

export function buildAssertionOptions(
  input: BuildAssertionOptionsInput,
): PublicKeyCredentialRequestOptions {
  const allowCredentials: PublicKeyCredentialDescriptor[] = input.allowCredentialIds.map((id) => ({
    type: "public-key" as const,
    id: id.buffer as ArrayBuffer,
    // When transport is "platform" / "cross-platform" we surface a hint to the
    // user agent; "any" omits the field so the platform picks freely.
    ...(input.transport === "platform"
      ? { transports: ["internal" as AuthenticatorTransport] }
      : input.transport === "cross-platform"
        ? { transports: ["usb", "nfc", "ble", "hybrid"] as AuthenticatorTransport[] }
        : {}),
  }));
  return {
    challenge: input.challenge.buffer as ArrayBuffer,
    rpId: input.rpId,
    allowCredentials,
    userVerification: "required",
    timeout: input.timeoutMs ?? 60_000,
  };
}

/**
 * Run the WebAuthn ceremony and return a JSON-safe serialised assertion. The
 * caller POSTs this to `/api/approvals/[id]/sign-mandate` along with the
 * nonce. Throws if WebAuthn is unsupported, the user cancels, or the platform
 * raises an error (caller is expected to surface a user-friendly message).
 */
export async function runWebAuthnCeremony(
  options: PublicKeyCredentialRequestOptions,
): Promise<SerializedAssertion> {
  if (!isWebAuthnSupported()) {
    throw new Error("webauthn_unsupported");
  }
  const credential = (await navigator.credentials.get({
    publicKey: options,
  })) as PublicKeyCredential | null;
  if (!credential) {
    throw new Error("webauthn_cancelled");
  }
  return serializeAssertion(credential);
}

/**
 * Compute the SHA-256 of a UTF-8 string. Used to derive the WebAuthn
 * challenge from the canonical Mandate JSON.
 */
export async function sha256(text: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(text);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hash);
}

/**
 * Stringify a value with sorted keys — the canonical form used in the
 * challenge hash. Both client and server compute it the same way; any drift
 * causes the verifier to reject the assertion. This is intentionally minimal
 * (no fancy escapes); the underlying Mandate fields are well-defined JSON.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    parts.push(JSON.stringify(key) + ":" + canonicalize(v));
  }
  return "{" + parts.join(",") + "}";
}

/**
 * Common error codes the UI surfaces. Each maps to a localised toast.
 */
export type WebAuthnErrorCode =
  | "webauthn_unsupported"
  | "webauthn_cancelled"
  | "webauthn_timeout"
  | "webauthn_security"
  | "webauthn_unknown";

export function toErrorCode(error: unknown): WebAuthnErrorCode {
  if (!(error instanceof Error)) return "webauthn_unknown";
  if (error.message === "webauthn_unsupported") return "webauthn_unsupported";
  if (error.message === "webauthn_cancelled") return "webauthn_cancelled";
  // DOMException names from the WebAuthn spec.
  const name = (error as DOMException).name ?? "";
  if (name === "NotAllowedError") return "webauthn_cancelled";
  if (name === "AbortError") return "webauthn_cancelled";
  if (name === "TimeoutError") return "webauthn_timeout";
  if (name === "SecurityError") return "webauthn_security";
  return "webauthn_unknown";
}
