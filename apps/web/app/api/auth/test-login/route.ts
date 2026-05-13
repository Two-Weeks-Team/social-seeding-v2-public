import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, signSession } from "@/lib/auth";

/**
 * E2E auth bypass — mints a session JWT directly (mirrors v1 `/api/auth/test-login`).
 * Only honored when `AUTH_TEST_LOGIN_ENABLED === "true"`; the caller must present
 * the `AUTH_TEST_LOGIN_SECRET`. In every other env this route 404s.
 *
 *   POST /api/auth/test-login
 *   { "secret": "$AUTH_TEST_LOGIN_SECRET", "email"?, "userId"?, "workspaceId"? }
 *   → 200 { token, userId, workspaceId, email }
 */
export async function POST(req: NextRequest) {
  if (process.env.AUTH_TEST_LOGIN_ENABLED !== "true") {
    return NextResponse.json({ error: "test-login disabled" }, { status: 404 });
  }
  const expected = process.env.AUTH_TEST_LOGIN_SECRET;
  if (!expected) return NextResponse.json({ error: "test-login misconfigured" }, { status: 500 });

  const body = (await req.json().catch(() => null)) as
    | { secret?: unknown; email?: unknown; userId?: unknown; workspaceId?: unknown }
    | null;
  if (!body || body.secret !== expected) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const email = typeof body.email === "string" ? body.email : "tester@2weeks.co";
  // 21-char id (v1's Google-OAuth-id parity)
  const userId = typeof body.userId === "string" && body.userId.length === 21 ? body.userId : "tu_" + "0".repeat(18);
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "ws_test";

  const token = await signSession({ userId, workspaceId, email });
  const res = NextResponse.json({ token, userId, workspaceId, email });
  // Set the cookie so Mission Control's server-component pages can read the
  // session without the caller having to handle it (matches v1's test-login
  // behaviour). httpOnly + sameSite=lax + 30-day TTL.
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}
