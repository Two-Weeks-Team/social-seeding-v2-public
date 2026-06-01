import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE, defaultWorkspaceId, sessionCookieOptions, signSession } from "@/lib/auth";
import { decodeIdentity, decodeState, exchangeCode, getConnectedEmail, storeToken } from "@/lib/gmail-oauth";

/**
 * Shared Google OAuth callback — the registered redirect URI
 * (`<origin>/api/auth/google/callback`). Serves two flows, branched on
 * `state.purpose`:
 *
 *   "login"   → resolve identity from the id_token (openid/email scopes) and
 *               mint the ss_session cookie, then redirect to returnUrl.
 *   "connect" → exchange + persist the Gmail refresh token (default; v1 parity)
 *               and redirect with a `gmail_connected=` flag.
 *
 *   GET /api/auth/google/callback?code=&state=
 *   1. Verify the CSRF nonce (cookie ↔ state).
 *   2. Exchange the code for tokens.
 *   3a. login:   decode id_token → signSession → set cookie.
 *   3b. connect: getProfile → upsert token into shared backend user_tokens.
 *   4. Redirect back to returnUrl.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  const origin = process.env.GMAIL_OAUTH_ORIGIN?.trim() || url.origin;
  const fail = (reason: string, status = 400) =>
    NextResponse.json({ error: "google_oauth_callback_failed", reason }, { status });

  if (oauthError) return fail(`google_error:${oauthError}`);
  if (!code || !stateRaw) return fail("missing_code_or_state");

  const state = decodeState(stateRaw);
  if (!state) return fail("invalid_state");

  // CSRF: the nonce in the cookie must match the one round-tripped in state.
  const cookieNonce = req.cookies.get("gmail_oauth_nonce")?.value;
  if (!cookieNonce || cookieNonce !== state.nonce) return fail("state_nonce_mismatch", 403);

  // ── Login flow: identity-only, mint the session cookie. ──────────────────
  if (state.purpose === "login") {
    // Open-redirect guard: only same-origin relative paths.
    let dest = state.returnUrl || "/campaigns";
    if (!dest.startsWith("/") || dest.startsWith("//")) dest = "/campaigns";
    let identity;
    try {
      const tokens = await exchangeCode({ code, origin });
      if (!tokens.id_token) return fail("no_id_token", 502);
      identity = decodeIdentity(tokens.id_token);
    } catch (err) {
      return fail(`exchange_error:${(err as Error).message}`, 502);
    }
    if (!identity) return fail("invalid_identity", 502);

    const token = await signSession({
      userId: identity.sub,
      workspaceId: defaultWorkspaceId(),
      email: identity.email,
    });
    const res = NextResponse.redirect(new URL(dest, origin).toString(), { status: 302 });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    res.cookies.delete("gmail_oauth_nonce");
    return res;
  }

  // ── Connect flow (default): persist the Gmail refresh token. ─────────────
  let connectedEmail: string;
  try {
    const tokens = await exchangeCode({ code, origin });
    connectedEmail = await getConnectedEmail(tokens.access_token);
    await storeToken(connectedEmail, tokens);
  } catch (err) {
    return fail(`exchange_or_store_error:${(err as Error).message}`, 502);
  }

  // Redirect back into the app with the result; clear the nonce cookie.
  // Open-redirect guard: returnUrl is user-controlled (round-tripped via state),
  // so only honor same-origin relative paths — reject absolute/`//` URLs.
  let safeReturnUrl = state.returnUrl || "/";
  if (!safeReturnUrl.startsWith("/") || safeReturnUrl.startsWith("//")) {
    safeReturnUrl = "/";
  }
  const dest = new URL(safeReturnUrl, origin);
  dest.searchParams.set("gmail_connected", connectedEmail);
  const res = NextResponse.redirect(dest.toString(), { status: 302 });
  res.cookies.delete("gmail_oauth_nonce");
  return res;
}
