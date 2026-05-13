import { NextResponse, type NextRequest } from "next/server";
// import { inngest } from "@ss/workflows";
// import { Events } from "@ss/contracts";

/**
 * Gmail Pub/Sub push receiver — ports v1 `api/webhooks/gmail/pubsub`. On a new
 * message in a watched mailbox: resolve which campaign/creator/thread it belongs
 * to, then emit `gmail/reply.received` so the waiting creator-track wakes up.
 * The watch is renewed daily by a scheduled Inngest fn (ports v1
 * `cron/renew-gmail-watch`). SKELETON — Phase 2.
 */
export async function POST(_req: NextRequest) {
  // 1. verify Pub/Sub JWT, decode message
  // 2. pull the changed thread via Gmail API (token-manager auto-refresh — v1 lib/gmail)
  // 3. match thread → { campaignId, creatorId }
  // 4. await inngest.send({ name: Events.GmailReplyReceived, data: { ... } })
  return NextResponse.json({ ok: true });
}
