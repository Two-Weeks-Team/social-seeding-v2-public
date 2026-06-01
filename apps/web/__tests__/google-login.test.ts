import { describe, expect, it, beforeAll } from "vitest";

import {
  LOGIN_SCOPES,
  buildConsentUrl,
  decodeIdentity,
  decodeState,
  encodeState,
} from "@/lib/gmail-oauth";

const CLIENT_ID = "842411554437-test.apps.googleusercontent.com";

beforeAll(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = CLIENT_ID;
});

/** Build an unsigned id_token (header.payload.signature) for decode tests. */
function fakeIdToken(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

describe("login OAuth state", () => {
  it("round-trips purpose=login through encode/decode", () => {
    const s = encodeState({ returnUrl: "/campaigns", nonce: "n1", purpose: "login" });
    const decoded = decodeState(s);
    expect(decoded).not.toBeNull();
    expect(decoded?.purpose).toBe("login");
    expect(decoded?.returnUrl).toBe("/campaigns");
  });

  it("defaults absent purpose to undefined (treated as connect)", () => {
    const decoded = decodeState(encodeState({ returnUrl: "/", nonce: "n2" }));
    expect(decoded?.purpose).toBeUndefined();
  });

  it("rejects an unknown purpose", () => {
    const raw = Buffer.from(
      JSON.stringify({ returnUrl: "/", nonce: "n3", purpose: "evil" }),
      "utf8",
    ).toString("base64url");
    expect(decodeState(raw)).toBeNull();
  });
});

describe("login consent url", () => {
  it("uses identity-only scopes and online access", () => {
    const url = new URL(
      buildConsentUrl({
        origin: "https://agents.socialseed.ing",
        state: "st",
        scopes: LOGIN_SCOPES,
        accessType: "online",
        prompt: "select_account",
      }),
    );
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("access_type")).toBe("online");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://agents.socialseed.ing/api/auth/google/callback",
    );
    expect(url.searchParams.get("scope")).not.toContain("gmail");
  });

  it("still defaults to gmail connect scopes when none passed", () => {
    const url = new URL(buildConsentUrl({ origin: "https://x.test", state: "st" }));
    expect(url.searchParams.get("scope")).toContain("gmail.send");
    expect(url.searchParams.get("access_type")).toBe("offline");
  });
});

describe("decodeIdentity", () => {
  it("extracts sub + email from a valid Google id_token", () => {
    const id = decodeIdentity(
      fakeIdToken({
        iss: "https://accounts.google.com",
        aud: CLIENT_ID,
        sub: "102248148591352004682",
        email: "operator@2weeks.co",
      }),
    );
    expect(id).toEqual({ sub: "102248148591352004682", email: "operator@2weeks.co" });
  });

  it("rejects a token whose aud is a different client", () => {
    expect(
      decodeIdentity(
        fakeIdToken({ iss: "https://accounts.google.com", aud: "someone-else", sub: "x", email: "a@b.co" }),
      ),
    ).toBeNull();
  });

  it("rejects a non-Google issuer", () => {
    expect(
      decodeIdentity(fakeIdToken({ iss: "https://evil.example", aud: CLIENT_ID, sub: "x", email: "a@b.co" })),
    ).toBeNull();
  });

  it("rejects a malformed token", () => {
    expect(decodeIdentity("not.a.jwt.at.all")).toBeNull();
    expect(decodeIdentity("onlyonepart")).toBeNull();
  });
});
