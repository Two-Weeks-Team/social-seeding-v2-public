import { createHmac } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { Collections, getDb } from "@ss/db";
import { SESSION_COOKIE, signSession } from "@/lib/auth";

/**
 * GET /api/auth/judge-demo?token=<JUDGE_DEMO_TOKEN>
 *
 * 1-click, no-2FA judge access — the URL goes in the Devpost "Testing access"
 * field so reviewers land on a populated Mission Control without their own
 * Google account. Ports the *concept* of v1's `yc-demo` magic link onto v2's
 * jose `signSession` seam (no next-auth/jwt, no id-mapping lookup).
 *
 * The minted session carries `demo: true` — every state-mutating API route
 * refuses it (see `denyIfDemo`), so a publicly-shared link is a read-only tour,
 * never an actuator. The demo email is deliberately NOT Gmail-connected, so
 * `gmail.send` is structurally impossible even before the gate.
 *
 * Guards (env-driven, flippable without a deploy):
 *   - JUDGE_DEMO_ENABLED !== "true"        → 404 (kill switch)
 *   - now > JUDGE_DEMO_EXPIRES_AT (ISO)    → 410 (judging window closed)
 *   - token absent / wrong                 → 401
 *   - global usage cap reached             → 429 (atomic counter, _id = HMAC(token))
 *
 * Env:
 *   JUDGE_DEMO_ENABLED       "true" to arm the route
 *   JUDGE_DEMO_TOKEN         the shared magic-link secret (openssl rand -hex 32)
 *   JUDGE_DEMO_WORKSPACE_ID  landing workspace (default ws_wooriliu_2nd — the seeded report)
 *   JUDGE_DEMO_EMAIL         JWT email claim + logging (default judge-demo@2weeks.co)
 *   JUDGE_DEMO_USER_ID       synthetic session userId (default a clearly-demo id)
 *   JUDGE_DEMO_EXPIRES_AT    optional ISO timestamp; after it the route 410s
 *   JUDGE_DEMO_MAX_USES      optional global cap (default 30)
 *   AUTH_SECRET              reused to sign the session + as the HMAC key
 */

export const runtime = "nodejs";

const SESSION_TTL_SECONDS = 3 * 24 * 60 * 60; // 3 days
const DEFAULT_MAX_USES = 30;

function json(status: number, body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, { status });
}

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
    // E11000: another request inserted the row first. Retry without upsert so
    // we respect the cap predicate instead of racing a second insert.
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

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (process.env.JUDGE_DEMO_ENABLED !== "true") {
    return json(404, { error: "not_found" });
  }

  const expiresAt = process.env.JUDGE_DEMO_EXPIRES_AT?.trim();
  if (expiresAt) {
    const exp = Date.parse(expiresAt);
    if (Number.isFinite(exp) && Date.now() > exp) {
      return json(410, { error: "demo_window_closed" });
    }
  }

  const expected = process.env.JUDGE_DEMO_TOKEN;
  if (!expected) return json(500, { error: "judge_demo_misconfigured" });
  const token = req.nextUrl.searchParams.get("token") ?? "";
  if (token.length === 0 || token.length > 256 || token !== expected) {
    return json(401, { error: "invalid_token" });
  }

  const secret = process.env.AUTH_SECRET;
  if (!secret) return json(500, { error: "judge_demo_misconfigured" });
  const tokenHash = createHmac("sha256", secret).update(token, "utf8").digest("hex");
  const maxUses = Number(process.env.JUDGE_DEMO_MAX_USES) || DEFAULT_MAX_USES;

  const consumed = await consumeUsage(tokenHash, maxUses);
  if (!consumed) return json(429, { error: "demo_uses_exhausted" });

  const workspaceId = process.env.JUDGE_DEMO_WORKSPACE_ID?.trim() || "ws_wooriliu_2nd";
  const email = process.env.JUDGE_DEMO_EMAIL?.trim() || "judge-demo@2weeks.co";
  const userId = process.env.JUDGE_DEMO_USER_ID?.trim() || "judge-demo-0000000000";

  const sessionToken = await signSession({ userId, workspaceId, email, demo: true }, SESSION_TTL_SECONDS);

  const res = NextResponse.redirect(new URL("/campaigns", req.url));
  res.cookies.set(SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}
