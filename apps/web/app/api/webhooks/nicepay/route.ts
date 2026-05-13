import { NextResponse, type NextRequest } from "next/server";

/**
 * NicePay billing webhook — ports v1 `api/webhooks/nicepay` + the idempotency
 * key store (`webhook_events`). Recurring billing itself becomes a scheduled
 * Inngest fn (ports v1 `cron/billing-recurring`). The plan model & quota
 * enforcement live in @ss/db + the capability layer's rate-limit class.
 * SKELETON — carried forward in Phase 0/1.
 */
export async function POST(_req: NextRequest) {
  // 1. verify signature
  // 2. dedupe on event id (webhook_events collection — shared with v1? or v2-owned? — decide in P0)
  // 3. update subscription / plan cache
  return NextResponse.json({ ok: true });
}
