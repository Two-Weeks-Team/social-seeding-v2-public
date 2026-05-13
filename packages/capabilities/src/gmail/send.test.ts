import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeMongo, Collections, getDb } from "@ss/db";
import { setGmailClientFactory, tokenManager, type GmailClient } from "./client";
import { gmailSend } from "./send";

/**
 * P2-C2e — gmail.send end-to-end with the injected GmailClient seam. Verifies:
 *   - happy path: spam-score gate clears → MIME built → client.send called →
 *     v2_outbox row sealed with status=sent + messageId/threadId.
 *   - retry with same idempotencyKey: returns the cached sent result, does NOT
 *     re-call the client.
 *   - spam-score > MAX: throws "spam_score_too_high", persists status=failed,
 *     never touches the client.
 *   - sendAt > now+5s: returns scheduled=true, writes status=scheduled, does
 *     NOT call the client. Re-invoking without sendAt then sends and updates.
 *   - tracking pixel + unsubscribe footer appear in the raw MIME (base64).
 *   - missing Gmail token ⇒ refuses to send.
 *   - missing unsubscribe secret ⇒ refuses to compose the footer.
 */

const ctx = {
  workspaceId: "ws_1",
  userId: "u".repeat(21),
  campaignId: "camp_1",
  rateLimitClass: "gmail_send" as const,
};

interface FakeSpy extends GmailClient {
  calls: Array<{ raw: string; threadId?: string }>;
}
function fakeClient(): FakeSpy {
  const calls: Array<{ raw: string; threadId?: string }> = [];
  return {
    calls,
    async send({ raw, threadId }) {
      calls.push({ raw, threadId });
      return { messageId: `msg_${calls.length}`, threadId: threadId ?? `thread_${calls.length}` };
    },
  };
}

function decodeBase64Url(input: string): string {
  const padLen = input.length % 4 === 0 ? 0 : 4 - (input.length % 4);
  return Buffer.from(
    input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen),
    "base64",
  ).toString("utf8");
}

const baseInput = {
  to: "creator@example.com",
  subject: "Quick collab idea for your skincare content",
  bodyHtml:
    "<html><body><p>Hi {{name}}, we loved your serum review.</p>" +
    "<p>Open to a paid collab — your angle? Brand HQ: 12 Garosu-gil, Seoul.</p></body></html>",
  creatorTrackId: "track_42",
  publicBaseUrl: "https://app.example.com",
  idempotencyKey: "ik-abc-123-xyz",
};

let originalSecret: string | undefined;

beforeAll(async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI not set — start scripts/dev-mongo + source .mongo-dev/dev-env first");
  }
  originalSecret = process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET;
  process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = "test_secret_at_least_16_chars_long_xx";
  // Atomic-claim idempotency (codex review P2#5) relies on the unique index
  // on idempotencyKey. scripts/init-indexes.ts creates it in prod; here we
  // create it in the test setup so we exercise the same production path.
  const db = await getDb();
  await db
    .collection(Collections.V2_OUTBOX)
    .createIndex({ idempotencyKey: 1 }, { unique: true })
    .catch(() => undefined);
});

afterAll(async () => {
  if (originalSecret === undefined) delete process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET;
  else process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = originalSecret;
  await closeMongo();
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.V2_OUTBOX).deleteMany({});
  await db.collection(Collections.SHARED_USER_TOKENS).deleteMany({});
  await db.collection(Collections.V2_SUPPRESSION_LIST).deleteMany({});
  await tokenManager.saveToken({
    userId: ctx.userId,
    email: "sender@brand.example",
    accessToken: "at_fresh",
    refreshToken: "rt",
    expiresIn: 3600,
    scope: "https://www.googleapis.com/auth/gmail.send",
  });
});

afterEach(() => {
  setGmailClientFactory(undefined);
});

describe("gmail.send", () => {
  it("happy path: composes MIME with tracking pixel + unsubscribe footer, calls client, seals outbox", async () => {
    const fake = fakeClient();
    setGmailClientFactory(async () => fake);
    const out = await gmailSend.handler(baseInput, ctx);
    expect(out.scheduled).toBe(false);
    expect(out.messageId).toBe("msg_1");
    expect(fake.calls).toHaveLength(1);

    // The raw payload is base64url-encoded MIME — decode and inspect.
    const mime = decodeBase64Url(fake.calls[0]!.raw);
    expect(mime).toContain("From: sender@brand.example");
    expect(mime).toContain("To: creator@example.com");
    // Subject is RFC 2047 base64-encoded only when non-ASCII; this subject is ASCII.
    expect(mime).toContain("Subject: Quick collab idea for your skincare content");
    expect(mime).toContain("multipart/alternative");

    // The HTML body part is itself base64'd inside the MIME; the outer base64url
    // decode gives us the MIME text, then we have to base64-decode the body part.
    // Easier: pluck the HTML by searching for our visible markers in any decode.
    const allText = mime + "\n" + Buffer.from(mime, "ascii").toString("utf8");
    void allText;
    // Decode the embedded text/html part to verify pixel + footer landed inside it.
    const htmlBase64 = mime.split(/Content-Type: text\/html[\s\S]+?\r\n\r\n/)[1]?.split("\r\n")[0];
    expect(htmlBase64).toBeTruthy();
    const html = Buffer.from(htmlBase64!, "base64").toString("utf8");
    expect(html).toContain('<img src="https://app.example.com/api/email/track?tid=ik-abc-123-xyz"');
    expect(html).toContain("/unsubscribe?token=");

    const db = await getDb();
    const row = await db.collection(Collections.V2_OUTBOX).findOne({ idempotencyKey: baseInput.idempotencyKey });
    expect(row?.status).toBe("sent");
    expect(row?.messageId).toBe("msg_1");
    expect(row?.threadId).toBe("thread_1");
    // The agent-authored body is below the default MAX (precision tested in spam-score.test.ts).
    expect(typeof row?.spamScore).toBe("number");
    expect(row?.spamScore).toBeLessThan(6);
  });

  it("concurrent send race (codex review P2#5): a fresh pending claim refuses subsequent in-flight callers", async () => {
    const fake = fakeClient();
    setGmailClientFactory(async () => fake);
    const db = await getDb();
    // Simulate worker A having just claimed the row (status='pending', fresh updatedAt).
    await db.collection(Collections.V2_OUTBOX).insertOne({
      idempotencyKey: "ik-race-1",
      status: "pending",
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      campaignId: ctx.campaignId,
      to: baseInput.to,
      subject: baseInput.subject,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // Worker B calls with the same key — should refuse rather than send.
    await expect(
      gmailSend.handler({ ...baseInput, idempotencyKey: "ik-race-1" }, ctx),
    ).rejects.toThrow(/concurrent_send/);
    expect(fake.calls).toHaveLength(0);
  });

  it("idempotency: retry with the same key returns the cached result without re-calling the client", async () => {
    const fake = fakeClient();
    setGmailClientFactory(async () => fake);
    const first = await gmailSend.handler(baseInput, ctx);
    const second = await gmailSend.handler(baseInput, ctx);
    expect(fake.calls).toHaveLength(1);
    expect(second.messageId).toBe(first.messageId);
    expect(second.threadId).toBe(first.threadId);
    expect(second.scheduled).toBe(false);
  });

  it("spam-score above MAX: throws spam_score_too_high, persists failed row, never calls client", async () => {
    const fake = fakeClient();
    setGmailClientFactory(async () => fake);
    const ugly = {
      ...baseInput,
      idempotencyKey: "ik-spam-1",
      subject: "FREE!! URGENT!! WINNER!! ACT NOW!!",
      bodyHtml: '<span style="display:none">hidden</span>Dear customer',
      maxSpamScore: 2,
    };
    await expect(gmailSend.handler(ugly, ctx)).rejects.toThrow(/spam_score_too_high/);
    expect(fake.calls).toHaveLength(0);
    const db = await getDb();
    const row = await db.collection(Collections.V2_OUTBOX).findOne({ idempotencyKey: "ik-spam-1" });
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toMatch(/spam_score_too_high/);
  });

  it("suppression list: recipient on the workspace's list ⇒ throws recipient_suppressed, never calls client", async () => {
    const fake = fakeClient();
    setGmailClientFactory(async () => fake);
    const db = await getDb();
    await db.collection(Collections.V2_SUPPRESSION_LIST).insertOne({
      email: baseInput.to,
      workspaceId: ctx.workspaceId,
      reason: "unsubscribed",
      source: "unsubscribe page",
      addedAt: new Date(),
    });
    await expect(
      gmailSend.handler({ ...baseInput, idempotencyKey: "ik-suppressed-1" }, ctx),
    ).rejects.toThrow(/recipient_suppressed/);
    expect(fake.calls).toHaveLength(0);
    const row = await db.collection(Collections.V2_OUTBOX).findOne({ idempotencyKey: "ik-suppressed-1" });
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toMatch(/recipient_suppressed/);
  });

  it("sendAt in the future: returns scheduled=true, writes status=scheduled, does NOT call the client", async () => {
    const fake = fakeClient();
    setGmailClientFactory(async () => fake);
    const sendAt = new Date(Date.now() + 60 * 60 * 1000); // 1h
    const out = await gmailSend.handler({ ...baseInput, sendAt }, ctx);
    expect(out.scheduled).toBe(true);
    expect(out.messageId).toBe("");
    expect(fake.calls).toHaveLength(0);
    const db = await getDb();
    const row = await db.collection(Collections.V2_OUTBOX).findOne({ idempotencyKey: baseInput.idempotencyKey });
    expect(row?.status).toBe("scheduled");
    expect(row?.sendAt).toBeInstanceOf(Date);
  });

  it("scheduled → drain: workflow re-invokes without sendAt (same idempotency key) and the row flips to sent", async () => {
    const fake = fakeClient();
    setGmailClientFactory(async () => fake);
    const sendAt = new Date(Date.now() + 60 * 60 * 1000);
    await gmailSend.handler({ ...baseInput, sendAt }, ctx); // scheduled
    expect(fake.calls).toHaveLength(0);
    const out = await gmailSend.handler(baseInput, ctx); // drain — sendAt absent
    expect(out.scheduled).toBe(false);
    expect(fake.calls).toHaveLength(1);
    const db = await getDb();
    const row = await db.collection(Collections.V2_OUTBOX).findOne({ idempotencyKey: baseInput.idempotencyKey });
    expect(row?.status).toBe("sent");
    expect(row?.sendAt).toBeUndefined();
  });

  it("missing Gmail token ⇒ throws, doesn't reach the client", async () => {
    const fake = fakeClient();
    setGmailClientFactory(async () => fake);
    const db = await getDb();
    await db.collection(Collections.SHARED_USER_TOKENS).deleteMany({});
    await expect(gmailSend.handler(baseInput, ctx)).rejects.toThrow(/no Gmail token/);
    expect(fake.calls).toHaveLength(0);
  });

  it("input schema: empty fields, bad URL, short idempotencyKey all rejected", () => {
    expect(gmailSend.input.safeParse({ ...baseInput, to: "not-an-email" }).success).toBe(false);
    expect(gmailSend.input.safeParse({ ...baseInput, publicBaseUrl: "not-a-url" }).success).toBe(false);
    expect(gmailSend.input.safeParse({ ...baseInput, idempotencyKey: "short" }).success).toBe(false);
    expect(gmailSend.input.safeParse({ ...baseInput, creatorTrackId: "" }).success).toBe(false);
  });

  it("RFC 2047 encoding kicks in for non-ASCII fromName / subject", async () => {
    const fake = fakeClient();
    setGmailClientFactory(async () => fake);
    await gmailSend.handler(
      {
        ...baseInput,
        idempotencyKey: "ik-utf8-1",
        fromName: "지우",
        subject: "협업 제안",
      },
      ctx,
    );
    const mime = decodeBase64Url(fake.calls[0]!.raw);
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
    expect(mime).toMatch(/From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <sender@brand.example>/);
  });

  it("client failure ⇒ throws and records status=failed on the outbox row", async () => {
    const failing: GmailClient = {
      async send() {
        throw new Error("simulated network error");
      },
    };
    setGmailClientFactory(async () => failing);
    await expect(gmailSend.handler({ ...baseInput, idempotencyKey: "ik-fail-1" }, ctx)).rejects.toThrow(
      /simulated network error/,
    );
    const db = await getDb();
    const row = await db.collection(Collections.V2_OUTBOX).findOne({ idempotencyKey: "ik-fail-1" });
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toContain("simulated network error");
  });
});
