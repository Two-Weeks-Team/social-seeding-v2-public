import { Collections, getDb } from "@ss/db";

/**
 * Injectable Gmail-client seam — same pattern as the v1 `TikTokFetcher` seam
 * in `tiktok/get-creator.ts`. Tests inject a fake; production wires in the
 * `googleapis` SDK.
 *
 * `GmailClient` is the thin surface `gmail.send` (and later `gmail.watchThread`)
 * actually depends on. We resolve it per-userId via a factory because each user
 * has their own OAuth token; the factory consults `tokenManager` to fetch a
 * fresh access token (auto-refreshing if it's near expiry) and hands back a
 * client wired to that token. The capability never sees the raw token.
 *
 * Default factory: throws a clear message until GOOGLE_CLIENT_ID/SECRET are set
 * AND `googleapis` is wired. Until then, every test path must
 * `setGmailClientFactory(fake)` — there is no live fallback. This is
 * intentional: a credential-less environment should never accidentally produce
 * an "email sent" result.
 */

export interface GmailMessageRef {
  /** The Gmail-assigned message id (server-side). */
  messageId: string;
  /** The Gmail thread id this message landed in. */
  threadId: string;
}

export interface GmailSendInput {
  /** Base64url-encoded MIME message (the same shape Gmail's API expects). */
  raw: string;
  /** Reply-into-existing-thread (omit for a new thread). */
  threadId?: string;
}

export interface GmailClient {
  /**
   * Send a single MIME message. The raw payload must already include all
   * headers (From, To, Subject, MIME, the tracking pixel HTML, the unsubscribe
   * footer); this layer doesn't compose — that's the capability's job.
   */
  send(input: GmailSendInput): Promise<GmailMessageRef>;
}

export type GmailClientFactory = (userId: string) => Promise<GmailClient>;

interface UserTokenDoc {
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  /** Either a Date (v1) or a number of ms-since-epoch (legacy). */
  expiresAt: Date | number | string;
  scope: string;
  updatedAt?: Date;
}

/** 5-minute safety margin matches v1 `TokenManager.tokenExpiryBuffer`. */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

function asDate(v: Date | number | string): Date {
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v);
  return new Date(v);
}

/**
 * Minimal v2 port of v1 `~/social-seeding/src/lib/auth/token-manager.ts`. Reads
 * the SHARED `user_tokens` collection (v1-owned, never re-typed); auto-refreshes
 * via Google's OAuth2 token endpoint when the access token is near expiry; writes
 * the refreshed pair back. We deliberately *do not* duplicate v1's
 * idMappingService / oauth_accounts fallback chain — v2 users come in through
 * Auth.js v5 which writes a Google-OAuth-id keyed row directly, so the lookup is
 * a single `findOne`.
 */
export const tokenManager = {
  isExpired(token: { expiresAt: Date | number | string }): boolean {
    return Date.now() >= asDate(token.expiresAt).getTime() - TOKEN_EXPIRY_BUFFER_MS;
  },

  async getToken(userId: string): Promise<UserTokenDoc | null> {
    const db = await getDb();
    const doc = await db
      .collection<UserTokenDoc>(Collections.SHARED_USER_TOKENS)
      .findOne({ $or: [{ userId }, { email: userId }] });
    return doc ?? null;
  },

  async saveToken(input: {
    userId: string;
    email: string;
    accessToken: string;
    refreshToken: string;
    /** seconds until expiry, as Google returns. */
    expiresIn: number;
    scope: string;
  }): Promise<UserTokenDoc> {
    const db = await getDb();
    const expiresAt = new Date(Date.now() + input.expiresIn * 1000);
    const set: UserTokenDoc = { ...input, expiresAt, updatedAt: new Date() };
    await db
      .collection<UserTokenDoc>(Collections.SHARED_USER_TOKENS)
      .updateOne(
        { $or: [{ userId: input.userId }, { email: input.email }] },
        { $set: set },
        { upsert: true },
      );
    return set;
  },

  /**
   * Exchange a refresh-token for a fresh access-token via Google. Throws if
   * GOOGLE_CLIENT_ID/SECRET aren't set, so a misconfigured prod loudly fails
   * rather than silently shipping a stale token.
   */
  async refresh(userId: string): Promise<UserTokenDoc> {
    const existing = await this.getToken(userId);
    if (!existing) throw new Error(`tokenManager.refresh: no token for userId=${userId}`);
    if (!existing.refreshToken) throw new Error(`tokenManager.refresh: refresh_token missing for ${userId}`);
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error(
        "tokenManager.refresh: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set — can't refresh access tokens",
      );
    }
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: existing.refreshToken,
      }).toString(),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`tokenManager.refresh: google returned ${res.status} ${errText}`);
    }
    const body = (await res.json()) as {
      access_token: string;
      expires_in?: number;
      refresh_token?: string;
      scope?: string;
    };
    return this.saveToken({
      userId: existing.userId,
      email: existing.email,
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? existing.refreshToken,
      expiresIn: body.expires_in ?? 3600,
      scope: body.scope ?? existing.scope,
    });
  },

  /** Get a token that is *guaranteed* fresh (refreshes if near expiry). */
  async getValid(userId: string): Promise<UserTokenDoc> {
    const t = await this.getToken(userId);
    if (!t) throw new Error(`tokenManager.getValid: no token for userId=${userId}`);
    if (!this.isExpired(t)) return t;
    return this.refresh(userId);
  },
};

export function defaultGmailClientFactory(_userId: string): Promise<GmailClient> {
  // Live wiring uses `googleapis` + the freshly-refreshed accessToken from
  // tokenManager.getValid. We don't import googleapis in this package yet
  // (heavy dep; tests don't need it) — Phase 2 follow-up will pin it and fill
  // this in. Tests must inject a fake before any code path that calls send().
  return Promise.reject(
    new Error(
      "defaultGmailClientFactory: googleapis not wired in @ss/capabilities yet — " +
        "tests should setGmailClientFactory(fake); production must complete the Phase-2 follow-up that adds googleapis + GOOGLE_CLIENT_ID/SECRET wiring.",
    ),
  );
}

let _factory: GmailClientFactory | undefined;
export function getGmailClientFactory(): GmailClientFactory {
  return (_factory ??= defaultGmailClientFactory);
}
/** Pass `undefined` to reset to the default (googleapis-backed) factory. */
export function setGmailClientFactory(f: GmailClientFactory | undefined): void {
  _factory = f;
}
