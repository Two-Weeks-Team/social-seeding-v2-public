import { NextResponse, type NextRequest } from "next/server";

import { buildConsentUrl, encodeState } from "@/lib/gmail-oauth";

/**
 * Start the reusable Gmail OAuth connect flow.
 *
 *   GET /api/auth/gmail/start?email=<hint>&returnUrl=<path>
 *   → 302 to Google's consent screen (gmail.send + gmail.readonly).
 *
 * After consent, Google redirects to /api/auth/google/callback, which exchanges
 * the code and persists the refresh token to the shared backend user_tokens
 * store. Every user connects through this same screen.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const emailHint = url.searchParams.get("email") ?? undefined;
  const returnUrl = url.searchParams.get("returnUrl") ?? "/";

  // Origin must match a registered redirect URI (localhost:3000 / socialseed.ing).
  const origin = process.env.GMAIL_OAUTH_ORIGIN?.trim() || url.origin;

  // Random nonce — a lightweight CSRF marker round-tripped via `state`.
  const nonce = crypto.randomUUID();
  const state = encodeState({ returnUrl, emailHint, nonce });

  let consentUrl: string;
  try {
    consentUrl = buildConsentUrl({ origin, state, emailHint });
  } catch (err) {
    return NextResponse.json(
      { error: "gmail_oauth_misconfigured", detail: (err as Error).message },
      { status: 500 },
    );
  }

  const res = NextResponse.redirect(consentUrl, { status: 302 });
  // Persist the nonce so the callback can verify the round-trip (CSRF defense).
  res.cookies.set("gmail_oauth_nonce", nonce, {
    httpOnly: true,
    secure: origin.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
