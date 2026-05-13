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

/** One Gmail message, normalized into the fields the webhook + classifier need. */
export interface GmailMessage {
  messageId: string;
  threadId: string;
  fromEmail: string;
  subject: string;
  /** Plain-text body, HTML-stripped, RFC-2047-decoded if applicable. */
  bodyText: string;
  /** RFC 3339 internal date (server-side receive time). */
  internalDate?: Date;
}

/**
 * Slice of the Gmail History API output we actually consume. The webhook
 * uses this to discover which messages arrived between two historyIds.
 */
export interface GmailHistoryDelta {
  /** History id reached after this call — what to persist for the next poll. */
  latestHistoryId: string;
  /** Newly-arrived message ids (de-duplicated, oldest-first). */
  addedMessageIds: string[];
}

export interface GmailClient {
  /**
   * Send a single MIME message. The raw payload must already include all
   * headers (From, To, Subject, MIME, the tracking pixel HTML, the unsubscribe
   * footer); this layer doesn't compose — that's the capability's job.
   */
  send(input: GmailSendInput): Promise<GmailMessageRef>;
  /**
   * Fetch one message, normalized. Used by the Pub/Sub webhook to load the
   * inbound reply for classification. Optional on the interface so existing
   * test fakes that only set `send` keep compiling.
   */
  getMessage?(messageId: string): Promise<GmailMessage>;
  /**
   * Walk Gmail history from the last seen `startHistoryId`. Returns the set
   * of newly-arrived message ids + the new high-water mark to persist.
   * Optional — same compat reason as getMessage.
   */
  listHistory?(startHistoryId: string): Promise<GmailHistoryDelta>;
  /**
   * Renew the Gmail watch (Pub/Sub subscription). Returns the current
   * historyId to persist as the watch's `lastHistoryId` baseline. Optional —
   * the daily gmail-watch-renew cron buckets clients-without-this-method as
   * `skipped` rather than `failed`.
   */
  renewWatch?(): Promise<{ historyId: string }>;
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

/**
 * Production GmailClient — wraps the `googleapis` SDK with a freshly-refreshed
 * access token from `tokenManager.getValid`. Tests inject a fake via
 * `setGmailClientFactory`; this path runs only when no fake is installed.
 *
 * Requires at invocation time:
 *   · `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` (for token refresh + OAuth2 client)
 *   · A v2 user_tokens row for `userId` with a non-expired refresh_token
 *   · For `renewWatch`: `GMAIL_PUBSUB_TOPIC` (e.g.
 *     `projects/$PROJECT_ID/topics/gmail-pubsub`)
 *
 * Lazy-imports googleapis so test suites that never invoke a default factory
 * don't pay the ~50MB load cost.
 */
export async function defaultGmailClientFactory(userId: string): Promise<GmailClient> {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error(
      "defaultGmailClientFactory: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set. " +
        "Either configure them OR inject a fake via setGmailClientFactory(...) for tests.",
    );
  }
  const token = await tokenManager.getValid(userId);
  const { google } = await import("googleapis");

  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  oauth2.setCredentials({
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
  });
  const gmail = google.gmail({ version: "v1", auth: oauth2 });

  return {
    async send(input) {
      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw: input.raw, ...(input.threadId ? { threadId: input.threadId } : {}) },
      });
      const messageId = res.data.id;
      const threadId = res.data.threadId;
      if (!messageId || !threadId) {
        throw new Error("Gmail send: response missing id/threadId");
      }
      return { messageId, threadId };
    },

    async getMessage(messageId) {
      const res = await gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
      });
      return normalizeGmailMessage(res.data);
    },

    async listHistory(startHistoryId) {
      // history.list pages by historyId; we walk all pages so the high-water
      // mark advances atomically (one call, one new state) — Gmail returns at
      // most ~500 events per page.
      const added: string[] = [];
      let latest = startHistoryId;
      let pageToken: string | undefined;
      do {
        const res = await gmail.users.history.list({
          userId: "me",
          startHistoryId,
          historyTypes: ["messageAdded"],
          ...(pageToken ? { pageToken } : {}),
        });
        const history = res.data.history ?? [];
        for (const h of history) {
          for (const m of h.messagesAdded ?? []) {
            const id = m.message?.id;
            if (id) added.push(id);
          }
        }
        if (res.data.historyId) latest = res.data.historyId;
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
      return {
        latestHistoryId: latest,
        addedMessageIds: [...new Set(added)],
      };
    },

    async renewWatch() {
      const topic = process.env.GMAIL_PUBSUB_TOPIC;
      if (!topic) {
        throw new Error("renewWatch: GMAIL_PUBSUB_TOPIC is not set");
      }
      const res = await gmail.users.watch({
        userId: "me",
        requestBody: {
          topicName: topic,
          labelIds: ["INBOX"],
          labelFilterAction: "include",
        },
      });
      const historyId = res.data.historyId;
      if (!historyId) throw new Error("renewWatch: gmail.users.watch returned no historyId");
      return { historyId };
    },
  };
}

/**
 * Minimal slice of the Gmail API message shape we read in getMessage —
 * keeps us off `gmail_v1.Schema$Message` so the @ss/capabilities types
 * don't leak the full googleapis surface into consumers.
 */
interface GmailApiHeader { name?: string | null; value?: string | null }
interface GmailApiPart {
  mimeType?: string | null;
  headers?: GmailApiHeader[] | null;
  body?: { data?: string | null } | null;
  parts?: GmailApiPart[] | null;
}
interface GmailApiMessage {
  id?: string | null;
  threadId?: string | null;
  internalDate?: string | null;
  payload?: GmailApiPart | null;
}

function findHeader(headers: GmailApiHeader[] | null | undefined, name: string): string {
  if (!headers) return "";
  const lower = name.toLowerCase();
  for (const h of headers) {
    if ((h.name ?? "").toLowerCase() === lower) return h.value ?? "";
  }
  return "";
}

function decodeBase64Url(s: string): string {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/**
 * Recursive find of a text/plain body anywhere in the MIME tree. Falls back to
 * text/html stripped of tags + whitespace-normalized when no text/plain part
 * exists (some senders only ship HTML).
 */
function extractTextBody(part: GmailApiPart): string {
  function findByMime(p: GmailApiPart, mime: string): string | null {
    if (p.mimeType === mime && p.body?.data) return decodeBase64Url(p.body.data);
    for (const c of p.parts ?? []) {
      const r = findByMime(c, mime);
      if (r) return r;
    }
    return null;
  }
  const plain = findByMime(part, "text/plain");
  if (plain) return plain;
  const html = findByMime(part, "text/html");
  if (html) return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return "";
}

/** Exposed for tests of the parsing logic; @ss/capabilities consumers use GmailClient.getMessage. */
export function normalizeGmailMessage(msg: GmailApiMessage): GmailMessage {
  if (!msg.id || !msg.threadId) {
    throw new Error("normalizeGmailMessage: response missing id/threadId");
  }
  const headers = msg.payload?.headers ?? [];
  const from = findHeader(headers, "From");
  const subject = findHeader(headers, "Subject");
  // Strip a `"Name" <addr@example.com>` envelope down to just the address.
  const angle = from.match(/<([^>]+)>/);
  const fromEmail = angle?.[1] ?? from.trim();
  const bodyText = msg.payload ? extractTextBody(msg.payload) : "";
  return {
    messageId: msg.id,
    threadId: msg.threadId,
    fromEmail,
    subject,
    bodyText,
    ...(msg.internalDate ? { internalDate: new Date(Number(msg.internalDate)) } : {}),
  };
}

let _factory: GmailClientFactory | undefined;
export function getGmailClientFactory(): GmailClientFactory {
  return (_factory ??= defaultGmailClientFactory);
}
/** Pass `undefined` to reset to the default (googleapis-backed) factory. */
export function setGmailClientFactory(f: GmailClientFactory | undefined): void {
  _factory = f;
}
