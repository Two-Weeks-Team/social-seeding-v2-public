import { describe, expect, it } from "vitest";
import {
  buildPubSubMessage,
  parsePubSubMessage,
  verifyPubSubAuth,
  type GmailNotification,
  type PubSubMessage,
} from "./pubsub";

/**
 * P2-C7a — Pub/Sub verify + parse. Pure; no env, no I/O.
 */

describe("verifyPubSubAuth", () => {
  it("accepts Google UA + JSON content-type when no expectedToken is configured (dev path)", () => {
    expect(
      verifyPubSubAuth({
        userAgent: "Google-Cloud-Pub-Sub",
        contentType: "application/json",
      }),
    ).toBe(true);
  });

  it("rejects non-Google User-Agent", () => {
    expect(
      verifyPubSubAuth({
        userAgent: "curl/8.0",
        contentType: "application/json",
      }),
    ).toBe(false);
  });

  it("rejects non-JSON content-type", () => {
    expect(
      verifyPubSubAuth({
        userAgent: "APIs-Google; (+https://x)",
        contentType: "text/plain",
      }),
    ).toBe(false);
  });

  it("expectedToken set: ?token= must match; mismatch ⇒ false even with valid UA/CT", () => {
    const headers = { userAgent: "Google", contentType: "application/json" };
    expect(verifyPubSubAuth(headers, { expectedToken: "secret", queryToken: "secret" })).toBe(true);
    expect(verifyPubSubAuth(headers, { expectedToken: "secret", queryToken: "wrong" })).toBe(false);
    expect(verifyPubSubAuth(headers, { expectedToken: "secret" /* no query */ })).toBe(false);
  });
});

describe("parsePubSubMessage", () => {
  const sample: GmailNotification = {
    emailAddress: "outreach@brand.example",
    historyId: "12345",
  };

  it("round-trips with buildPubSubMessage", () => {
    const env = buildPubSubMessage(sample);
    const parsed = parsePubSubMessage(env);
    expect(parsed).toEqual(sample);
  });

  it("returns null on malformed envelope shapes", () => {
    expect(parsePubSubMessage(null)).toBeNull();
    expect(parsePubSubMessage(undefined)).toBeNull();
    expect(parsePubSubMessage("not an object")).toBeNull();
    expect(parsePubSubMessage({})).toBeNull();
    expect(parsePubSubMessage({ message: {} })).toBeNull();
    expect(parsePubSubMessage({ message: { data: "" } })).toBeNull();
  });

  it("returns null when the inner JSON is malformed or missing required fields", () => {
    const bad = (data: string): PubSubMessage => ({
      message: { data, messageId: "x", publishTime: "now" },
      subscription: "x",
    });
    expect(parsePubSubMessage(bad(Buffer.from("not json").toString("base64")))).toBeNull();
    expect(parsePubSubMessage(bad(Buffer.from(JSON.stringify({})).toString("base64")))).toBeNull();
    expect(
      parsePubSubMessage(bad(Buffer.from(JSON.stringify({ emailAddress: "" })).toString("base64"))),
    ).toBeNull();
  });
});
