import { NextResponse, type NextRequest } from "next/server";

import { buildConsentUrl, encodeState, LOGIN_SCOPES } from "@/lib/gmail-oauth";

/**
 * Start the real Google sign-in flow.
 *
 *   GET /api/auth/google/start?returnUrl=<path>
 *   → 302 to Google's consent screen (openid + email + profile only).
 *
 * Identity-only scopes → no Google app verification needed for public users.
 * Reuses the already-registered redirect URI `/api/auth/google/callback`; the
 * callback branches on `state.purpose === "login"` to mint the ss_session
 * cookie from the id_token. The nonce cookie is the CSRF round-trip marker.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  // Open-redirect guard: only same-origin relative paths.
  const rawReturn = url.searchParams.get("returnUrl") ?? "/campaigns";
  const returnUrl = rawReturn.startsWith("/") && !rawReturn.startsWith("//") ? rawReturn : "/campaigns";

  // Origin must match a registered redirect URI (localhost:3000 / *.socialseed.ing).
  const origin = process.env.GMAIL_OAUTH_ORIGIN?.trim() || url.origin;

  const nonce = crypto.randomUUID();
  const state = encodeState({ returnUrl, nonce, purpose: "login" });

  let consentUrl: string;
  try {
    consentUrl = buildConsentUrl({
      origin,
      state,
      scopes: LOGIN_SCOPES,
      accessType: "online",
      prompt: "select_account",
    });
  } catch (err) {
    return NextResponse.json(
      { error: "google_login_misconfigured", detail: (err as Error).message },
      { status: 500 },
    );
  }

  const res = NextResponse.redirect(consentUrl, { status: 302 });
  res.cookies.set("gmail_oauth_nonce", nonce, {
    httpOnly: true,
    secure: origin.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
