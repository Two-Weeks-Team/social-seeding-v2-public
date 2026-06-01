import { NextResponse, type NextRequest } from "next/server";

import { decodeState, exchangeCode, getConnectedEmail, storeToken } from "@/lib/gmail-oauth";

/**
 * Gmail OAuth callback — the registered redirect URI
 * (`<origin>/api/auth/google/callback`).
 *
 *   GET /api/auth/google/callback?code=&state=
 *   1. Verify the CSRF nonce (cookie ↔ state).
 *   2. Exchange the code for tokens (refresh_token via access_type=offline).
 *   3. Resolve the connected mailbox (gmail.readonly getProfile).
 *   4. Upsert the token into the shared backend user_tokens store.
 *   5. Redirect back to returnUrl with a connected= flag.
 *
 * Reusable by every user; the ADK fleet + TS outreach then send with the
 * persisted token.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  const origin = process.env.GMAIL_OAUTH_ORIGIN?.trim() || url.origin;
  const fail = (reason: string, status = 400) =>
    NextResponse.json({ error: "gmail_oauth_callback_failed", reason }, { status });

  if (oauthError) return fail(`google_error:${oauthError}`);
  if (!code || !stateRaw) return fail("missing_code_or_state");

  const state = decodeState(stateRaw);
  if (!state) return fail("invalid_state");

  // CSRF: the nonce in the cookie must match the one round-tripped in state.
  const cookieNonce = req.cookies.get("gmail_oauth_nonce")?.value;
  if (!cookieNonce || cookieNonce !== state.nonce) return fail("state_nonce_mismatch", 403);

  let connectedEmail: string;
  try {
    const tokens = await exchangeCode({ code, origin });
    connectedEmail = await getConnectedEmail(tokens.access_token);
    await storeToken(connectedEmail, tokens);
  } catch (err) {
    return fail(`exchange_or_store_error:${(err as Error).message}`, 502);
  }

  // Redirect back into the app with the result; clear the nonce cookie.
  const dest = new URL(state.returnUrl || "/", origin);
  dest.searchParams.set("gmail_connected", connectedEmail);
  const res = NextResponse.redirect(dest.toString(), { status: 302 });
  res.cookies.delete("gmail_oauth_nonce");
  return res;
}
