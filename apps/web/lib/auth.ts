/**
 * Session JWT helpers — minimal, jose-based, used by the E2E test-login route
 * and the campaigns API. Full Auth.js v5 + Google OAuth wiring is a follow-up
 * (next-auth@5.0.0-beta.25 currently has a peer-dep mismatch with next@16 —
 * see SCOPE-DECISIONS.md); the JWT shape here is what Auth.js v5 will eventually
 * issue, so the rest of the API doesn't need to change when that lands.
 */
import { jwtVerify, SignJWT } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const SESSION_COOKIE = "ss_session";

export interface SessionClaims {
  /** 21-char Google OAuth id (v1 parity) */
  userId: string;
  workspaceId: string;
  email: string;
  /**
   * Present (and `true`) only on the judge-demo bypass session. Read-only:
   * every state-mutating API route refuses when this is set, so a publicly
   * shared demo link can tour Mission Control but never trigger a real
   * workflow / outbound send. Real Google / test-login sessions omit it.
   */
  demo?: true;
}

function secretKey(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    throw new Error("AUTH_SECRET is not set (>=16 chars required)");
  }
  return new TextEncoder().encode(s);
}

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days, v1 parity

/**
 * Workspace assigned to a freshly signed-in Google user. Multi-tenant
 * user→workspace mapping is a follow-up (see HONEST-SCOPE); for now every
 * sign-in lands in the operator workspace, overridable per deployment via
 * `DEFAULT_LOGIN_WORKSPACE_ID`.
 */
export function defaultWorkspaceId(): string {
  return process.env.DEFAULT_LOGIN_WORKSPACE_ID?.trim() || "ws_demo";
}

/**
 * Whether the ss_session cookie carries the `Secure` attribute. True in
 * production (HTTPS Cloud Run) so the session never rides plain HTTP. But a
 * LOCAL `next start` demo also runs in NODE_ENV=production while being served
 * over plain HTTP — and if it's reached via a LAN address (e.g. 192.168.x.x),
 * which the browser does NOT treat as a secure context (unlike localhost /
 * 127.0.0.1), a Secure cookie is silently dropped and sign-in loops forever.
 * Set AUTH_COOKIE_INSECURE=true for such demos. Never set it on the HTTPS deploy.
 */
export function cookieSecure(): boolean {
  if (process.env.AUTH_COOKIE_INSECURE === "true") return false;
  return process.env.NODE_ENV === "production";
}

/** Cookie options for the ss_session cookie, shared by every route that sets it. */
export function sessionCookieOptions(): {
  httpOnly: true;
  sameSite: "lax";
  path: string;
  maxAge: number;
  secure: boolean;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: DEFAULT_TTL_SECONDS,
    secure: cookieSecure(),
  };
}

export async function signSession(claims: SessionClaims, ttlSeconds: number = DEFAULT_TTL_SECONDS): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(secretKey());
}

export async function verifySession(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    if (typeof payload.userId === "string" && typeof payload.workspaceId === "string" && typeof payload.email === "string") {
      const claims: SessionClaims = { userId: payload.userId, workspaceId: payload.workspaceId, email: payload.email };
      if (payload.demo === true) claims.demo = true;
      return claims;
    }
    return null;
  } catch {
    return null;
  }
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Read-only guard for the judge-demo session. State-mutating API routes call
 * this right after resolving the session: returns a ready-to-return 403 when
 * `session.demo` is set, otherwise `null` (proceed). Keeps the demo bypass a
 * tour, never an actuator.
 */
export function denyIfDemo(session: SessionClaims): Response | null {
  if (session.demo) {
    return new Response(JSON.stringify({ error: "demo_session_readonly" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}

/**
 * Server-action counterpart of denyIfDemo. API routes return a 403 Response,
 * but mutating *server actions* (the MC form posts: resolve approval, pause /
 * cancel campaign, save policy, create campaign…) can't — so they call this
 * right after resolving the session. For a demo session it redirects back to
 * `backTo` with `?demoReadonly=1` (pages may surface a notice; the mutation
 * never runs), keeping the judge-demo bypass a tour, never an actuator.
 * No-op for real sessions.
 */
export function demoReadonlyGuard(session: SessionClaims | null, backTo: string): void {
  if (session?.demo) {
    redirect(`${backTo}${backTo.includes("?") ? "&" : "?"}demoReadonly=1`);
  }
}

/** Returns the session, or a ready-to-return 401 Response. Bearer-only (API routes). */
export async function getSessionOr401(req: Request): Promise<
  | { ok: true; session: SessionClaims }
  | { ok: false; response: Response }
> {
  // Try Authorization: Bearer first (existing API contract), then fall back to the session cookie.
  const authHeader = req.headers.get("authorization");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  if (bearer) {
    const s = await verifySession(bearer);
    if (s) return { ok: true, session: s };
  }
  const cookieToken = (await cookies()).get(SESSION_COOKIE)?.value;
  if (cookieToken) {
    const s = await verifySession(cookieToken);
    if (s) return { ok: true, session: s };
  }
  return { ok: false, response: unauthorized() };
}

/**
 * Server-component / server-action helper. Returns the SessionClaims if a
 * valid ss_session cookie is present, otherwise null. Pages that require auth
 * should redirect or render a "sign in" view when this returns null.
 */
export async function getServerSession(): Promise<SessionClaims | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySession(token);
}
