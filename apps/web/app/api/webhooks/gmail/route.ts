import { NextResponse, type NextRequest } from "next/server";
import {
  getGmailClientFactory,
  parsePubSubMessage,
  tokenManager,
  verifyPubSubAuth,
  type GmailMessage,
} from "@ss/capabilities";
import { Collections, getDb } from "@ss/db";
import { Events } from "@ss/contracts";
import { inngest } from "@ss/workflows";

/**
 * Gmail Pub/Sub push receiver — ports v1 `api/webhooks/gmail/pubsub`.
 * Producer of `gmail/reply.received` which creator-track is awaiting via
 * step.waitForEvent (P2-C5).
 *
 * Pipeline:
 *   1. Authenticate the request (verifyPubSubAuth — User-Agent + content-type
 *      + ?token= vs `GMAIL_PUBSUB_TOKEN` env). 401 on mismatch.
 *   2. Parse the Pub/Sub envelope into `{ emailAddress, historyId }`.
 *      Malformed payload → still 200 (otherwise GCP redelivers forever).
 *   3. Resolve the user's last seen historyId from `v2_gmail_watches`
 *      (the watch-setup row) and call `GmailClient.listHistory(startHistoryId)`
 *      to discover newly-arrived message ids. Update the high-water mark.
 *   4. For each new messageId: `GmailClient.getMessage(id)` → look up the
 *      `v2_outbox` row by `threadId` to recover `(campaignId, creatorId)`.
 *      If no row: this thread isn't one of ours — skip. If found: emit
 *      `gmail/reply.received` with the body normalized.
 *   5. Respond 200 with the count processed.
 *
 * The default GmailClient factory still throws (`googleapis not wired` —
 * P2-C2 follow-up). Tests inject a fake; production live demo needs the
 * googleapis SDK + GOOGLE_CLIENT_ID/SECRET + a real Pub/Sub subscription.
 */

export const dynamic = "force-dynamic";

interface OutboxLookupRow {
  campaignId?: string;
  threadId?: string;
  idempotencyKey?: string;
}

interface WatchDoc {
  userId: string;
  emailAddress: string;
  lastHistoryId: string;
  updatedAt: Date;
}

async function resolveCampaignCreator(
  threadId: string,
): Promise<{ campaignId: string; creatorId: string } | null> {
  const db = await getDb();
  const row = await db
    .collection<OutboxLookupRow>(Collections.V2_OUTBOX)
    .findOne({ threadId, status: "sent" });
  if (!row?.campaignId || !row.idempotencyKey) return null;
  // idempotencyKey = `${campaignId}:${creatorId}:outreach` — derive creatorId.
  const parts = row.idempotencyKey.split(":");
  if (parts.length < 3 || parts[0] !== row.campaignId) return null;
  return { campaignId: row.campaignId, creatorId: parts[1]! };
}

async function readWatchRow(emailAddress: string): Promise<WatchDoc | null> {
  const db = await getDb();
  return db.collection<WatchDoc>(Collections.V2_GMAIL_WATCHES).findOne({ emailAddress });
}

async function persistWatchHighWater(emailAddress: string, latest: string): Promise<void> {
  const db = await getDb();
  await db
    .collection<WatchDoc>(Collections.V2_GMAIL_WATCHES)
    .updateOne(
      { emailAddress },
      { $set: { lastHistoryId: latest, updatedAt: new Date() } },
    );
}

interface WebhookResult {
  ok: boolean;
  processed: number;
  emitted: number;
  skipped: number;
  reason?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse<WebhookResult>> {
  // Fail closed in production when GMAIL_PUBSUB_TOKEN isn't set (codex review
  // P2#4). The capability-layer verifyPubSubAuth allows a missing
  // expectedToken (dev/local default), but a deployed prod env without the
  // token configured would let anyone with a Google-looking User-Agent +
  // JSON content-type hit this endpoint. 503 with config_missing makes the
  // misconfiguration loud rather than silently insecure.
  const expectedToken = process.env.GMAIL_PUBSUB_TOKEN;
  if (process.env.NODE_ENV === "production" && !expectedToken) {
    return NextResponse.json(
      { ok: false, processed: 0, emitted: 0, skipped: 0, reason: "config_missing:GMAIL_PUBSUB_TOKEN" },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const auth = verifyPubSubAuth(
    {
      userAgent: req.headers.get("user-agent") ?? "",
      contentType: req.headers.get("content-type") ?? "",
      authorization: req.headers.get("authorization") ?? undefined,
    },
    {
      expectedToken,
      queryToken: url.searchParams.get("token") ?? undefined,
    },
  );
  if (!auth) {
    return NextResponse.json(
      { ok: false, processed: 0, emitted: 0, skipped: 0, reason: "unauthenticated" },
      { status: 401 },
    );
  }

  // Parse — never throw on a malformed payload; GCP redelivers on non-2xx.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: true, processed: 0, emitted: 0, skipped: 0, reason: "malformed_json" });
  }
  const note = parsePubSubMessage(body);
  if (!note) {
    return NextResponse.json({ ok: true, processed: 0, emitted: 0, skipped: 0, reason: "malformed_payload" });
  }

  // Resolve the user behind the address → GmailClient + watch row.
  const token = await tokenManager.getToken(note.emailAddress);
  if (!token) {
    return NextResponse.json({ ok: true, processed: 0, emitted: 0, skipped: 0, reason: "no_token" });
  }

  let client;
  try {
    client = await getGmailClientFactory()(token.userId);
  } catch (err) {
    // googleapis not wired or token-refresh failed — ack so GCP stops
    // hammering us. Real prod needs the P2-C2 follow-up.
    return NextResponse.json({
      ok: true,
      processed: 0,
      emitted: 0,
      skipped: 0,
      reason: `gmail_client_unavailable: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  if (!client.listHistory || !client.getMessage) {
    return NextResponse.json({
      ok: true,
      processed: 0,
      emitted: 0,
      skipped: 0,
      reason: "client_missing_methods",
    });
  }

  const watch = await readWatchRow(note.emailAddress);
  const startHistoryId = watch?.lastHistoryId ?? note.historyId;
  const delta = await client.listHistory(startHistoryId);

  let emitted = 0;
  let skipped = 0;
  let processed = 0;
  for (const messageId of delta.addedMessageIds) {
    processed++;
    let msg: GmailMessage;
    try {
      msg = await client.getMessage(messageId);
    } catch {
      skipped++;
      continue;
    }
    const link = await resolveCampaignCreator(msg.threadId);
    if (!link) {
      // Not one of our threads — common during early demo when the user
      // also gets unrelated mail on the same Gmail box.
      skipped++;
      continue;
    }
    await inngest.send({
      name: Events.GmailReplyReceived,
      data: {
        campaignId: link.campaignId,
        creatorId: link.creatorId,
        threadId: msg.threadId,
        messageId: msg.messageId,
        fromEmail: msg.fromEmail,
        subject: msg.subject,
        bodyText: msg.bodyText,
      },
    });
    emitted++;
  }

  await persistWatchHighWater(note.emailAddress, delta.latestHistoryId);

  return NextResponse.json({ ok: true, processed, emitted, skipped });
}
