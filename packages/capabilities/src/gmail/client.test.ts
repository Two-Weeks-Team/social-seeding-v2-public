import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeMongo, Collections, getDb } from "@ss/db";
import {
  defaultGmailClientFactory,
  getGmailClientFactory,
  setGmailClientFactory,
  tokenManager,
  type GmailClient,
  type GmailClientFactory,
} from "./client";

/**
 * P2-C2d — Gmail client seam + token-manager port. Verifies:
 *   - tokenManager round-trips through SHARED user_tokens additively,
 *   - isExpired honors the 5-min safety buffer,
 *   - the factory seam returns a freshly-injected fake (test-only path),
 *   - the default factory loudly throws so we never silently no-op a send.
 */

beforeAll(async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI not set — start scripts/dev-mongo + source .mongo-dev/dev-env first");
  }
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.SHARED_USER_TOKENS).deleteMany({});
});

afterEach(() => {
  setGmailClientFactory(undefined);
});

afterAll(async () => {
  await closeMongo();
});

describe("tokenManager", () => {
  it("saveToken upserts a v1-shaped row, getToken reads it back", async () => {
    await tokenManager.saveToken({
      userId: "google-oauth-id-123",
      email: "user@example.com",
      accessToken: "at_1",
      refreshToken: "rt_1",
      expiresIn: 3600,
      scope: "https://www.googleapis.com/auth/gmail.send",
    });
    const got = await tokenManager.getToken("google-oauth-id-123");
    expect(got?.email).toBe("user@example.com");
    expect(got?.accessToken).toBe("at_1");
    expect(got?.scope).toContain("gmail.send");
    expect(got?.expiresAt).toBeInstanceOf(Date);
  });

  it("getToken supports lookup by email (v1 parity for the email-only flow)", async () => {
    await tokenManager.saveToken({
      userId: "uid",
      email: "by-email@example.com",
      accessToken: "at",
      refreshToken: "rt",
      expiresIn: 3600,
      scope: "x",
    });
    const got = await tokenManager.getToken("by-email@example.com");
    expect(got?.userId).toBe("uid");
  });

  it("isExpired: true if expiresAt is within the 5-min safety buffer", () => {
    const now = Date.now();
    expect(tokenManager.isExpired({ expiresAt: new Date(now + 60 * 60 * 1000) })).toBe(false);
    expect(tokenManager.isExpired({ expiresAt: new Date(now + 4 * 60 * 1000) })).toBe(true); // < buffer
    expect(tokenManager.isExpired({ expiresAt: new Date(now - 60 * 1000) })).toBe(true); // past
  });

  it("getValid returns the existing token when it's not near expiry (no refresh)", async () => {
    await tokenManager.saveToken({
      userId: "u",
      email: "u@example.com",
      accessToken: "fresh_token",
      refreshToken: "rt",
      expiresIn: 3600,
      scope: "s",
    });
    const t = await tokenManager.getValid("u");
    expect(t.accessToken).toBe("fresh_token");
  });

  it("getValid throws on missing token (caller decides to escalate)", async () => {
    await expect(tokenManager.getValid("nobody")).rejects.toThrow(/no token/);
  });

  it("refresh fails loudly when GOOGLE_CLIENT_ID/SECRET are missing", async () => {
    await tokenManager.saveToken({
      userId: "u",
      email: "u@example.com",
      accessToken: "at",
      refreshToken: "rt",
      expiresIn: 1, // already expired-ish
      scope: "s",
    });
    const prevId = process.env.GOOGLE_CLIENT_ID;
    const prevSecret = process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    try {
      await expect(tokenManager.refresh("u")).rejects.toThrow(/GOOGLE_CLIENT_ID/);
    } finally {
      if (prevId !== undefined) process.env.GOOGLE_CLIENT_ID = prevId;
      if (prevSecret !== undefined) process.env.GOOGLE_CLIENT_SECRET = prevSecret;
    }
  });
});

describe("GmailClient factory seam", () => {
  it("setGmailClientFactory installs a fake; getGmailClientFactory returns it", async () => {
    const fake: GmailClient = {
      send: async ({ raw, threadId }) => ({
        messageId: `msg_${raw.length}`,
        threadId: threadId ?? "thread_new",
      }),
    };
    const factory: GmailClientFactory = async (_uid) => fake;
    setGmailClientFactory(factory);
    const client = await getGmailClientFactory()("any-user");
    const out = await client.send({ raw: "Zm9v" }); // base64url("foo")
    expect(out.messageId).toBe("msg_4");
    expect(out.threadId).toBe("thread_new");
  });

  it("default factory throws a clear, actionable error (no silent success)", async () => {
    setGmailClientFactory(undefined);
    await expect(defaultGmailClientFactory("any-user")).rejects.toThrow(/googleapis not wired/);
  });
});
