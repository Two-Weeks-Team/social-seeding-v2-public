import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeMongo, Collections, getDb } from "@ss/db";
import { setGmailClientFactory, type GmailClient } from "@ss/capabilities";
import { gmailWatchRenewHandler } from "./gmail-watch-renew";

/**
 * P2-C7d — gmail-watch-renew. Drives the handler against dev-mongo with a
 * fake GmailClient factory that implements the optional `renewWatch` hook.
 */

beforeAll(() => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set — start scripts/dev-mongo first");
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.V2_GMAIL_WATCHES).deleteMany({});
});

afterEach(() => {
  setGmailClientFactory(undefined);
});

afterAll(async () => { await closeMongo(); });

async function seed(rows: Array<{ userId: string; emailAddress: string; lastHistoryId: string }>): Promise<void> {
  const db = await getDb();
  await db.collection(Collections.V2_GMAIL_WATCHES).insertMany(
    rows.map((r) => ({ ...r, updatedAt: new Date() })),
  );
}

interface RenewableClient extends GmailClient {
  renewWatch: () => Promise<{ historyId: string }>;
}

describe("gmail-watch-renew", () => {
  it("empty list → total=0; no work, no failures", async () => {
    const out = await gmailWatchRenewHandler();
    expect(out).toEqual({ total: 0, renewed: 0, skipped: 0, failed: 0, failures: [] });
  });

  it("default factory throws ⇒ each row counts as failed with a clear reason (no googleapis wired)", async () => {
    await seed([
      { userId: "u_1", emailAddress: "a@example.com", lastHistoryId: "100" },
      { userId: "u_2", emailAddress: "b@example.com", lastHistoryId: "200" },
    ]);
    // No setGmailClientFactory → default throws
    const out = await gmailWatchRenewHandler();
    expect(out.total).toBe(2);
    expect(out.failed).toBe(2);
    expect(out.failures.map((f) => f.emailAddress).sort()).toEqual(["a@example.com", "b@example.com"]);
    expect(out.failures[0]?.reason).toMatch(/googleapis not wired/i);
  });

  it("factory without renewWatch ⇒ row counts as skipped (compat with P2-C2 GmailClient fakes)", async () => {
    await seed([{ userId: "u_a", emailAddress: "a@example.com", lastHistoryId: "100" }]);
    const fake: GmailClient = {
      async send() { return { messageId: "x", threadId: "y" }; },
      // no renewWatch
    };
    setGmailClientFactory(async () => fake);
    const out = await gmailWatchRenewHandler();
    expect(out).toMatchObject({ total: 1, skipped: 1, renewed: 0, failed: 0 });
  });

  it("renewWatch returns a fresh historyId ⇒ row counts renewed + lastHistoryId persisted", async () => {
    await seed([{ userId: "u_a", emailAddress: "a@example.com", lastHistoryId: "100" }]);
    const fake: RenewableClient = {
      async send() { return { messageId: "x", threadId: "y" }; },
      async renewWatch() { return { historyId: "999" }; },
    };
    setGmailClientFactory(async () => fake);
    const out = await gmailWatchRenewHandler();
    expect(out).toMatchObject({ total: 1, renewed: 1, skipped: 0, failed: 0 });
    const db = await getDb();
    const row = await db
      .collection<{ lastHistoryId: string }>(Collections.V2_GMAIL_WATCHES)
      .findOne({ emailAddress: "a@example.com" });
    expect(row?.lastHistoryId).toBe("999");
  });

  it("partial failure: one row throws on renew, another succeeds — both buckets populate independently", async () => {
    await seed([
      { userId: "u_ok", emailAddress: "ok@example.com", lastHistoryId: "100" },
      { userId: "u_bad", emailAddress: "bad@example.com", lastHistoryId: "200" },
    ]);
    setGmailClientFactory(async (userId) => {
      if (userId === "u_bad") {
        return {
          async send() { return { messageId: "x", threadId: "y" }; },
          async renewWatch() { throw new Error("token revoked"); },
        } satisfies RenewableClient;
      }
      return {
        async send() { return { messageId: "x", threadId: "y" }; },
        async renewWatch() { return { historyId: "555" }; },
      } satisfies RenewableClient;
    });
    const out = await gmailWatchRenewHandler();
    expect(out.total).toBe(2);
    expect(out.renewed).toBe(1);
    expect(out.failed).toBe(1);
    const failure = out.failures.find((f) => f.emailAddress === "bad@example.com");
    expect(failure?.reason).toMatch(/token revoked/);
  });
});
