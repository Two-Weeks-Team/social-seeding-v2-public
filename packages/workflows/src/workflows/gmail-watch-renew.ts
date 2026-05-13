import { Collections, getDb } from "@ss/db";
import { getGmailClientFactory } from "@ss/capabilities";
import { inngest } from "../client";

/**
 * gmail-watch-renew — daily cron that refreshes every active Gmail watch
 * before its 7-day Pub/Sub expiry. Without this, our Pub/Sub subscription
 * silently goes dead a week after setup; this is exactly why v1's
 * `cron/renew-gmail-watch` existed.
 *
 * Iterates every row in v2_gmail_watches, builds the per-user GmailClient
 * via the seam (default factory throws — googleapis isn't wired yet, see
 * P2-C2 follow-up), and would call `gmail.users.watch` to re-arm. For
 * Phase-2 we ship the workflow scaffold + iteration; the actual watch call
 * goes through a new optional method on the GmailClient interface so
 * tests + the default-throw factory both stay coherent.
 *
 * Triggered by Inngest cron. Run state ends up in the Inngest dashboard;
 * per-renewal trace ends up on stderr (no per-watch persistence beyond
 * updating the `updatedAt` field — failures don't drop the row, they just
 * leave it stale until the next attempt).
 */

interface WatchRow {
  userId: string;
  emailAddress: string;
  lastHistoryId: string;
  updatedAt: Date;
}

export interface WatchRenewResult {
  total: number;
  renewed: number;
  skipped: number;
  failed: number;
  failures: Array<{ emailAddress: string; reason: string }>;
}

/**
 * Pure handler exported for tests — driven by a fake step + a fake
 * GmailClient factory. The Inngest function below just wraps it.
 */
export async function gmailWatchRenewHandler(): Promise<WatchRenewResult> {
  const db = await getDb();
  const rows = await db
    .collection<WatchRow>(Collections.V2_GMAIL_WATCHES)
    .find({})
    .toArray();

  const result: WatchRenewResult = { total: rows.length, renewed: 0, skipped: 0, failed: 0, failures: [] };

  for (const row of rows) {
    let client;
    try {
      client = await getGmailClientFactory()(row.userId);
    } catch (err) {
      result.failed++;
      result.failures.push({ emailAddress: row.emailAddress, reason: `client_unavailable: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    // The watch-renew method is optional on the interface so existing
    // GmailClient fakes (and the default-throwing factory) compile.
    // When the googleapis-wired factory lands (P2-C2 follow-up), it
    // implements this and the cron starts doing real work.
    const renew = (client as { renewWatch?: () => Promise<{ historyId: string }> }).renewWatch;
    if (!renew) {
      result.skipped++;
      continue;
    }
    try {
      const out = await renew();
      await db.collection<WatchRow>(Collections.V2_GMAIL_WATCHES).updateOne(
        { emailAddress: row.emailAddress },
        { $set: { lastHistoryId: out.historyId, updatedAt: new Date() } },
      );
      result.renewed++;
    } catch (err) {
      result.failed++;
      result.failures.push({ emailAddress: row.emailAddress, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/**
 * Daily cron, 4 a.m. UTC. Gmail watches are good for 7 days; running every
 * 24h gives us 6 chances to recover before any single watch silently dies.
 */
export const gmailWatchRenew = inngest.createFunction(
  { id: "gmail-watch-renew" },
  { cron: "0 4 * * *" },
  () => gmailWatchRenewHandler(),
);
