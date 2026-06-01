/**
 * Reusable Gmail OAuth connect flow (v2 product feature).
 *
 * Mirrors the production socialseed.ing flow so every user — now and future —
 * connects Gmail the same way: a real Google consent screen → callback →
 * refresh token persisted to the SHARED backend `user_tokens` store (the same
 * store v1 and the ADK fleet read). No one-off code-paste.
 *
 * Flow:
 *   GET /api/auth/gmail/start?email=&returnUrl=  → 302 to Google consent
 *   GET /api/auth/google/callback?code=&state=   → exchange + persist + redirect
 *
 * Credentials reuse the shared Google OAuth client (GOOGLE_CLIENT_ID/SECRET);
 * the registered redirect URIs are `<origin>/api/auth/google/callback`
 * (localhost:3000 + socialseed.ing). Token storage reuses the backend's
 * X-API-Key (minted from BACKEND_DASHBOARD_EMAIL/PASSWORD) — the same auth the
 * TikTok proxy client uses.
 */

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

/** gmail.send is what outreach needs; gmail.readonly lets us read the connected
 * profile email + (later) sync threads — matches the scopes the live tokens carry. */
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
] as const;

const DEFAULT_BACKEND_URL = "https://backend.socialseed.ing";

export function googleClientId(): string {
  // Accept both names: the deployed service wires GOOGLE_OAUTH_CLIENT_ID
  // (deploy/web/service.yaml), local dev uses GOOGLE_CLIENT_ID.
  const v = (process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_CLIENT_ID)?.trim();
  if (!v) throw new Error("GOOGLE_OAUTH_CLIENT_ID / GOOGLE_CLIENT_ID unset");
  return v;
}

export function googleClientSecret(): string {
  const v = (process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET)?.trim();
  if (!v) throw new Error("GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_CLIENT_SECRET unset");
  return v;
}

export function backendBaseUrl(): string {
  return (process.env.SS_BACKEND_URL?.trim() || DEFAULT_BACKEND_URL).replace(/\/+$/, "");
}

/** The OAuth redirect URI for this deployment. Must be registered on the Google
 * client. We reuse the already-registered `/api/auth/google/callback` path so no
 * console change is needed for localhost:3000 or socialseed.ing. */
export function redirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/auth/google/callback`;
}

export interface OAuthState {
  returnUrl: string;
  /** Hint for which account the operator intends to connect (display only). */
  emailHint?: string;
  nonce: string;
}

export function encodeState(state: OAuthState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

export function decodeState(raw: string): OAuthState | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as OAuthState;
    if (typeof parsed.returnUrl !== "string" || typeof parsed.nonce !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function buildConsentUrl(params: { origin: string; state: string; emailHint?: string }): string {
  const q = new URLSearchParams({
    client_id: googleClientId(),
    redirect_uri: redirectUri(params.origin),
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent", // force a refresh_token even on re-consent
    state: params.state,
  });
  if (params.emailHint) q.set("login_hint", params.emailHint);
  return `${GOOGLE_AUTH_URL}?${q.toString()}`;
}

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

export async function exchangeCode(params: { code: string; origin: string }): Promise<GoogleTokenResponse> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: params.code,
      client_id: googleClientId(),
      client_secret: googleClientSecret(),
      redirect_uri: redirectUri(params.origin),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as GoogleTokenResponse;
}

/** Resolve the connected mailbox address from the access token (gmail.readonly
 * grants users.getProfile). This is the canonical key for the token store — the
 * operator may have logged in as a different account than the hint. */
export async function getConnectedEmail(accessToken: string): Promise<string> {
  const res = await fetch(GMAIL_PROFILE_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Gmail getProfile failed (${res.status})`);
  }
  const d = (await res.json()) as { emailAddress?: string };
  if (!d.emailAddress) throw new Error("Gmail getProfile returned no emailAddress");
  return d.emailAddress;
}

export interface GmailConnectionStatus {
  connected: boolean;
  needsReauth: boolean;
  expiresAt?: string;
}

/** Check whether `email` has a (valid) connected Gmail token in the shared
 * backend store. Used by the settings page to render connect vs reconnect.
 * Never throws — returns `connected:false` on any error. */
export async function gmailConnectionStatus(email: string): Promise<GmailConnectionStatus> {
  try {
    const key = await backendKey();
    const res = await fetch(
      `${backendBaseUrl()}/api/v1/auth/token-status?email=${encodeURIComponent(email)}`,
      { headers: { "X-API-Key": key, accept: "application/json" }, cache: "no-store" },
    );
    if (!res.ok) return { connected: false, needsReauth: true };
    const d = (await res.json()) as { isValid?: boolean; needsReauth?: boolean; expiresAt?: string; error?: string };
    if (d.error) return { connected: false, needsReauth: true };
    return { connected: Boolean(d.isValid), needsReauth: Boolean(d.needsReauth), expiresAt: d.expiresAt };
  } catch {
    return { connected: false, needsReauth: true };
  }
}

/** Mint a short-lived backend X-API-Key (same /auth/login the TikTok client uses). */
async function backendKey(): Promise<string> {
  const email = process.env.BACKEND_DASHBOARD_EMAIL?.trim();
  const password = process.env.BACKEND_DASHBOARD_PASSWORD?.trim();
  if (!email || !password) {
    throw new Error("BACKEND_DASHBOARD_EMAIL/PASSWORD unset — cannot store the Gmail token in the shared backend");
  }
  const res = await fetch(`${backendBaseUrl()}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`backend /auth/login returned ${res.status}`);
  const d = (await res.json()) as { success?: boolean; api_key?: string };
  if (!d.success || !d.api_key) throw new Error("backend /auth/login: no api_key");
  return d.api_key;
}

/** Upsert the connected token into the SHARED backend user_tokens store so the
 * whole platform (v1 + ADK fleet + v2) reads one source of truth. */
export async function storeToken(email: string, tokens: GoogleTokenResponse): Promise<void> {
  const key = await backendKey();
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  const res = await fetch(`${backendBaseUrl()}/api/v1/user-tokens/${encodeURIComponent(email)}`, {
    method: "PUT",
    headers: { "X-API-Key": key, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? "",
      expiresAt,
      scope: tokens.scope,
      tokenType: tokens.token_type,
    }),
  });
  if (!res.ok) {
    throw new Error(`backend user-tokens upsert failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}
