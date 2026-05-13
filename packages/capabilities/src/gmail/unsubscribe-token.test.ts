import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  signUnsubscribeToken,
  unsubscribeUrl,
  verifyUnsubscribeToken,
} from "./unsubscribe-token";

/**
 * P2-C2b — unsubscribe-token. Pure; env-driven. We set the secret per-test so
 * the suite doesn't depend on a global config.
 */

const SECRET = "test_secret_at_least_16_chars_xxxxx";
const PREV_SECRET = "previous_secret_also_16_chars_yyyyy";

let originalSecret: string | undefined;
let originalPrev: string | undefined;

beforeEach(() => {
  originalSecret = process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET;
  originalPrev = process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET_PREVIOUS;
  process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = SECRET;
  delete process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET_PREVIOUS;
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET;
  else process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = originalSecret;
  if (originalPrev === undefined) delete process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET_PREVIOUS;
  else process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET_PREVIOUS = originalPrev;
});

describe("unsubscribe-token", () => {
  it("round-trips: signed token verifies back to its (rid, cid)", () => {
    const token = signUnsubscribeToken("track_abc", "camp_xyz");
    const res = verifyUnsubscribeToken(token);
    expect(res.valid).toBe(true);
    if (res.valid) {
      expect(res.rid).toBe("track_abc");
      expect(res.cid).toBe("camp_xyz");
      expect(res.exp).toBeGreaterThan(res.iat);
    }
  });

  it("rejects a token signed with a different secret (bad_signature)", () => {
    const token = signUnsubscribeToken("track_abc", "camp_xyz");
    // rotate to a brand-new secret with no previous fallback
    process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = "different_secret_at_least_16_chars";
    const res = verifyUnsubscribeToken(token);
    expect(res).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("dual-secret rotation: previous secret still validates in-flight tokens", () => {
    const token = signUnsubscribeToken("track_abc", "camp_xyz"); // signed with SECRET
    // operator rotates: old becomes PREVIOUS, new becomes current
    process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = PREV_SECRET; // new current (any value)
    process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET_PREVIOUS = SECRET; // retiring
    const res = verifyUnsubscribeToken(token);
    expect(res.valid).toBe(true);
  });

  it("rejects an expired token", () => {
    const token = signUnsubscribeToken("track_abc", "camp_xyz", { ttlSeconds: 60 });
    // Forge an expired token by tampering with the payload — re-sign with the
    // same secret so only the exp invariant fails.
    const [payloadPart] = token.split(".");
    expect(payloadPart).toBeTruthy();
    const padLen = payloadPart!.length % 4 === 0 ? 0 : 4 - (payloadPart!.length % 4);
    const decoded = Buffer.from(
      payloadPart!.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen),
      "base64",
    ).toString("utf8");
    const obj = JSON.parse(decoded);
    obj.exp = Math.floor(Date.now() / 1000) - 10; // 10s in the past
    const tampered = Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const sig = createHmac("sha256", SECRET)
      .update(tampered)
      .digest()
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const res = verifyUnsubscribeToken(`${tampered}.${sig}`);
    expect(res).toEqual({ valid: false, reason: "expired" });
  });

  it("missing secret ⇒ not_configured (no throw on verify)", () => {
    delete process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET;
    const res = verifyUnsubscribeToken("anything.atall");
    expect(res).toEqual({ valid: false, reason: "not_configured" });
  });

  it("missing secret ⇒ sign throws (never silently mint an unverifiable token)", () => {
    delete process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET;
    expect(() => signUnsubscribeToken("r", "c")).toThrow(/EMAIL_UNSUBSCRIBE_HMAC_SECRET/);
  });

  it("malformed inputs are rejected without throwing", () => {
    expect(verifyUnsubscribeToken("")).toEqual({ valid: false, reason: "malformed" });
    expect(verifyUnsubscribeToken("no-dot")).toEqual({ valid: false, reason: "malformed" });
    expect(verifyUnsubscribeToken("a.")).toEqual({ valid: false, reason: "malformed" });
    expect(verifyUnsubscribeToken(".b")).toEqual({ valid: false, reason: "malformed" });
  });

  it("unsubscribeUrl: trims trailing slash and URL-encodes the token", () => {
    const url = unsubscribeUrl("https://app.example.com/", "abc.def+ghi=");
    expect(url).toBe("https://app.example.com/unsubscribe?token=abc.def%2Bghi%3D");
  });
});
