/**
 * Judge-demo session minting — shared by the token-bearing magic-link route
 * (`GET /api/auth/judge-demo`) and the sign-in "Enter as judge" button.
 *
 * The magic-link route validates a caller-supplied `?token=` (the secret that
 * goes in Devpost "Testing access"); this helper instead trusts the server's
 * own env token, so the sign-in button needs no secret in the page HTML. Both
 * paths share one env config + one usage cap (counter keyed on HMAC(token)),
 * so total demo logins are bounded regardless of which entry a reviewer uses.
 *
 * The minted session carries `demo: true` → every state-mutating route refuses
 * it (`denyIfDemo`), so this is a read-only tour, never an actuator.
 */
import { createHmac } from "node:crypto";

import { Collections, getDb } from "@ss/db";

import { signSession } from "@/lib/auth";

/** 3 days — matches the magic-link route. */
export const JUDGE_DEMO_SESSION_TTL_SECONDS = 3 * 24 * 60 * 60;
const DEFAULT_MAX_USES = 30;

export type JudgeDemoMint =
  | { ok: true; sessionToken: string; ttlSeconds: number }
  | { ok: false; status: number; error: string };

/** Atomic, capped usage counter. Returns true if a slot was consumed. */
async function consumeUsage(tokenHash: string, maxUses: number): Promise<boolean> {
  const col = getDb ? (await getDb()).collection(Collections.V2_JUDGE_DEMO_TOKEN_USAGE) : null;
  if (!col) return false;
  const now = new Date();
  try {
    const res = await col.findOneAndUpdate(
      { _id: tokenHash as unknown as never, count: { $lt: maxUses } },
      { $inc: { count: 1 }, $set: { lastUsedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true, returnDocument: "after" },
    );
    return Boolean(res);
  } catch (err: unknown) {
    // E11000: another request inserted the row first. Retry without upsert so we
    // respect the cap predicate instead of racing a second insert.
    if ((err as { code?: number })?.code === 11000) {
      const res = await col.findOneAndUpdate(
        { _id: tokenHash as unknown as never, count: { $lt: maxUses } },
        { $inc: { count: 1 }, $set: { lastUsedAt: now } },
        { returnDocument: "after" },
      );
      return Boolean(res); // null → cap reached
    }
    throw err;
  }
}

/**
 * Mint a read-only judge-demo session without a caller-supplied token.
 * Returns a discriminated result mirroring the magic-link route's status codes
 * (404 kill-switch, 410 window closed, 429 cap reached, 500 misconfigured) so
 * callers can surface a friendly message instead of throwing.
 */
export async function mintJudgeDemoSession(): Promise<JudgeDemoMint> {
  if (process.env.JUDGE_DEMO_ENABLED !== "true") {
    return { ok: false, status: 404, error: "not_found" };
  }

  const expiresAt = process.env.JUDGE_DEMO_EXPIRES_AT?.trim();
  if (expiresAt) {
    const exp = Date.parse(expiresAt);
    if (Number.isFinite(exp) && Date.now() > exp) {
      return { ok: false, status: 410, error: "demo_window_closed" };
    }
  }

  const token = process.env.JUDGE_DEMO_TOKEN;
  const secret = process.env.AUTH_SECRET;
  if (!token || !secret) {
    return { ok: false, status: 500, error: "judge_demo_misconfigured" };
  }

  const tokenHash = createHmac("sha256", secret).update(token, "utf8").digest("hex");
  const maxUses = Number(process.env.JUDGE_DEMO_MAX_USES) || DEFAULT_MAX_USES;
  const consumed = await consumeUsage(tokenHash, maxUses);
  if (!consumed) return { ok: false, status: 429, error: "demo_uses_exhausted" };

  const workspaceId = process.env.JUDGE_DEMO_WORKSPACE_ID?.trim() || "ws_wooriliu_2nd";
  const email = process.env.JUDGE_DEMO_EMAIL?.trim() || "judge-demo@2weeks.co";
  const userId = process.env.JUDGE_DEMO_USER_ID?.trim() || "judge-demo-0000000000";

  const sessionToken = await signSession(
    { userId, workspaceId, email, demo: true },
    JUDGE_DEMO_SESSION_TTL_SECONDS,
  );
  return { ok: true, sessionToken, ttlSeconds: JUDGE_DEMO_SESSION_TTL_SECONDS };
}
