/**
 * Session JWT helpers — minimal, jose-based, used by the E2E test-login route
 * and the campaigns API. Full Auth.js v5 + Google OAuth wiring is a follow-up
 * (next-auth@5.0.0-beta.25 currently has a peer-dep mismatch with next@16 —
 * see SCOPE-DECISIONS.md); the JWT shape here is what Auth.js v5 will eventually
 * issue, so the rest of the API doesn't need to change when that lands.
 */
import { jwtVerify, SignJWT } from "jose";

export interface SessionClaims {
  /** 21-char Google OAuth id (v1 parity) */
  userId: string;
  workspaceId: string;
  email: string;
}

function secretKey(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    throw new Error("AUTH_SECRET is not set (>=16 chars required)");
  }
  return new TextEncoder().encode(s);
}

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days, v1 parity

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
      return { userId: payload.userId, workspaceId: payload.workspaceId, email: payload.email };
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

/** Returns the session, or a ready-to-return 401 Response. */
export async function getSessionOr401(req: Request): Promise<
  | { ok: true; session: SessionClaims }
  | { ok: false; response: Response }
> {
  const auth = req.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!token) return { ok: false, response: unauthorized() };
  const session = await verifySession(token);
  if (!session) return { ok: false, response: unauthorized() };
  return { ok: true, session };
}
