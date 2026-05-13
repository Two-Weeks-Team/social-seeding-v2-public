import { z } from "zod";
import { Collections, getDb } from "@ss/db";
import { defineCapability } from "../registry";
import { isSuppressed } from "../suppression/check";
import { getGmailClientFactory, tokenManager } from "./client";
import { calculateSpamScore, DEFAULT_MAX_SPAM_SCORE } from "./spam-score";
import { signUnsubscribeToken, unsubscribeUrl } from "./unsubscribe-token";

/**
 * gmail.send — send (or schedule) an email via the workspace's connected
 * Gmail. Port of v1 `~/social-seeding/src/app/api/email/send/route.ts` and
 * `lib/email-tracking.ts` for the actual sending path; tokenManager port +
 * GmailClient seam live in ./client.ts.
 *
 * `scope = "external_send"` — the orchestrator NEVER calls this without
 * first clearing `approveOutreachSend` / `approveReplyResponse`. The
 * capability itself enforces a second-layer guard via spam-score:
 *
 *   1. validate input
 *   2. spam-score(subject, body, from) > MAX → throw "spam_score_too_high"
 *      with the rule hits so the gate can escalate.
 *   3. idempotency check: look up v2_outbox by idempotencyKey.
 *      - already "sent"  → return cached result (no double-send on retry).
 *      - already "failed" → fall through to retry.
 *      - "scheduled" and sendAt still in future → return cached scheduled=true.
 *   4. if sendAt > now+5s → upsert v2_outbox status=scheduled, return
 *      {scheduled: true, ...}. The workflow's step.sleepUntil(sendAt) is
 *      responsible for waking and re-invoking without sendAt (idempotency
 *      key carries forward).
 *   5. compose MIME: append tracking pixel + unsubscribe footer, base64url
 *      encode, hand to the injected GmailClient.send(). Persist the result
 *      to v2_outbox status=sent.
 *
 * Tracking pixel / unsubscribe footer: appended just-before `</body>` (or at
 * tail if no body tag). v1's `processEmailContentForTracking` also wrapped
 * every link; that piece is deferred to a focused Phase-2 follow-up because
 * the open-pixel alone is sufficient signal for the demo path.
 *
 * What this is NOT:
 *  - The OAuth-connect / consent-screen flow (apps/web concern).
 *  - The reply-detection webhook (P2-C7).
 *  - The Gmail batch-send / quota dance (single-message API is fine for v2
 *    cold-outreach volumes; v1's batch path was for inbox-sync, not send).
 */

const TRACKING_PIXEL_RE = /<\/body\s*>/i;

interface OutboxDoc {
  idempotencyKey: string;
  workspaceId: string;
  userId: string;
  campaignId?: string;
  to: string;
  subject: string;
  /**
   * `pending` = atomic claim taken (codex review P2#5), no send attempted yet.
   * `scheduled` = sendAt in future; workflow will drain via step.sleepUntil.
   * `sent` = Gmail accepted; `messageId`/`threadId` populated.
   * `failed` = pre-check refusal or send threw; `lastError` populated.
   */
  status: "pending" | "scheduled" | "sent" | "failed";
  sendAt?: Date;
  /** Gmail-assigned ids once sent. */
  messageId?: string;
  threadId?: string;
  /** Spam-score snapshot at send time (traceability). */
  spamScore?: number;
  /** Last error if status="failed". */
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

function appendTrackingPixel(html: string, trackingId: string, baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const url = `${trimmed}/api/email/track?tid=${encodeURIComponent(trackingId)}`;
  const pixel = `<img src="${url}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />`;
  if (TRACKING_PIXEL_RE.test(html)) {
    return html.replace(TRACKING_PIXEL_RE, `${pixel}</body>`);
  }
  return `${html}${pixel}`;
}

function appendUnsubscribeFooter(html: string, url: string): string {
  const footer =
    `<hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />` +
    `<p style="font-size:11px;color:#888;line-height:1.4;margin:0;">` +
    `If this isn't relevant, you can <a href="${url}" style="color:#888;text-decoration:underline;">unsubscribe</a>.` +
    `</p>`;
  if (TRACKING_PIXEL_RE.test(html)) {
    return html.replace(TRACKING_PIXEL_RE, `${footer}</body>`);
  }
  return `${html}${footer}`;
}

/**
 * RFC 2822 multipart/alternative MIME message, base64url-encoded (what the
 * Gmail API expects on the `raw` field). UTF-8 subject + From-name → RFC 2047
 * encoded-word when they contain non-ASCII; plain-text alt body is the HTML
 * stripped of tags (best-effort, matches v1).
 */
function buildMime(args: {
  fromHeader: string;
  to: string;
  subject: string;
  bodyHtml: string;
  threadId?: string;
}): string {
  const { fromHeader, to, subject, bodyHtml, threadId } = args;
  const boundary = `----b_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const messageId = `${Date.now()}.${Math.random().toString(36).slice(2)}@mail.gmail.com`;
  const subjectHeader = /[^\u0020-\u007E]/.test(subject)
    ? `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`
    : subject;
  const plainText = bodyHtml.replace(/<[^>]*>/g, "").replace(/\n\s*\n/g, "\n").trim();
  const lines = [
    "MIME-Version: 1.0",
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: ${subjectHeader}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}>`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(plainText, "utf8").toString("base64"),
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(bodyHtml, "utf8").toString("base64"),
    "",
    `--${boundary}--`,
  ];
  // Including threadId in the MIME isn't required (Gmail accepts it on the
  // send envelope), but we still want Message-ID for trace correlation.
  void threadId;
  return Buffer.from(lines.join("\r\n"), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export const gmailSend = defineCapability({
  name: "gmail.send",
  description:
    "Send or schedule a single outreach email via the workspace's connected Gmail. Composes MIME, attaches a tracking pixel + unsubscribe footer, pre-checks spam-score, and dedupes retries by idempotencyKey via v2_outbox. External — gated by policy.",
  scope: "external_send",
  idempotent: false,
  rateLimitClass: "gmail_send",
  input: z.object({
    to: z.string().email(),
    subject: z.string().min(1),
    bodyHtml: z.string().min(1),
    /** required for the unsubscribe footer URL (per-creator scope). */
    creatorTrackId: z.string().min(1),
    threadId: z.string().optional(),
    sendAt: z.coerce.date().optional(),
    idempotencyKey: z.string().min(8),
    /**
     * Overrides the workspace policy's MAX. Cold-mail tournament uses the
     * default; one-off reply-response sends with a known higher score (e.g.
     * a CAN-SPAM-required forwarding notice) can opt in.
     */
    maxSpamScore: z.number().int().min(0).max(10).optional(),
    /**
     * Public origin to use when composing tracking + unsubscribe URLs. The
     * workflow layer resolves this from workspace policy; the capability
     * never invents it.
     */
    publicBaseUrl: z.string().url(),
    /**
     * Optional From header — display name. The OAuth-connected email always
     * wins as the address; this only sets the friendly name.
     */
    fromName: z.string().optional(),
  }),
  output: z.object({
    messageId: z.string(),
    threadId: z.string(),
    scheduled: z.boolean(),
    spamScore: z.number(),
  }),
  async handler(input, ctx) {
    const db = await getDb();
    const outbox = db.collection<OutboxDoc>(Collections.V2_OUTBOX);
    const now = new Date();

    // 1. atomic idempotency claim (codex review P2#5). Race window: two
    //    workers both reach this concurrently with the same key. Mongo's
    //    unique index on idempotencyKey lets exactly one win the insert;
    //    the other gets E11000 and we read the existing row to decide.
    const baseDoc: OutboxDoc = {
      idempotencyKey: input.idempotencyKey,
      status: "pending",
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      ...(ctx.campaignId ? { campaignId: ctx.campaignId } : {}),
      to: input.to,
      subject: input.subject,
      createdAt: now,
      updatedAt: now,
    };
    let wonClaim = false;
    try {
      await outbox.insertOne(baseDoc);
      wonClaim = true;
    } catch (err: unknown) {
      // Mongo duplicate-key (E11000) = another worker has the row.
      const code = (err as { code?: unknown })?.code;
      if (code !== 11000) throw err;
    }

    if (!wonClaim) {
      const existing = await outbox.findOne({ idempotencyKey: input.idempotencyKey });
      // Settled = sent: return cached, regardless of what the current call asked.
      if (existing?.status === "sent" && existing.messageId && existing.threadId) {
        return {
          messageId: existing.messageId,
          threadId: existing.threadId,
          scheduled: false,
          spamScore: existing.spamScore ?? 0,
        };
      }
      // Both sides asking for scheduling — confirm the existing scheduled row.
      // A drain call (no sendAt, or sendAt in past) on a scheduled row falls
      // through to retry instead — that's how the workflow's
      // step.sleepUntil(sendAt) hands off to the actual send.
      if (
        input.sendAt &&
        input.sendAt.getTime() > Date.now() + 5_000 &&
        existing?.status === "scheduled"
      ) {
        return { messageId: "", threadId: "", scheduled: true, spamScore: existing.spamScore ?? 0 };
      }
      // Fresh claim in-flight by another worker.
      if (
        existing?.status === "pending" &&
        existing.updatedAt &&
        Date.now() - existing.updatedAt.getTime() < 30_000
      ) {
        throw new Error(
          `gmail.send: concurrent_send (another worker is processing idempotencyKey=${input.idempotencyKey})`,
        );
      }
      // Drain a scheduled-now / stale-pending / previously-failed row — we
      // own it from here. Clear sendAt so the scheduled branch below doesn't
      // re-park it.
      await outbox.updateOne(
        { idempotencyKey: input.idempotencyKey },
        { $set: { status: "pending", updatedAt: new Date() }, $unset: { lastError: "", sendAt: "" } },
      );
    }

    // 2. suppression-list pre-check (CAN-SPAM §5). Recipient on the
    //    workspace do-not-mail list ⇒ refuse + persist failure.
    const suppression = await isSuppressed(ctx.workspaceId, input.to);
    if (suppression.suppressed) {
      const err = new Error(
        `gmail.send: recipient_suppressed (${suppression.reason ?? "unknown"}) — ${input.to}`,
      );
      await outbox.updateOne(
        { idempotencyKey: input.idempotencyKey },
        { $set: { status: "failed", lastError: err.message, updatedAt: new Date() } },
      );
      throw err;
    }

    // 3. resolve the user's Gmail address (for From: + the spam-score "from").
    const token = await tokenManager.getToken(ctx.userId);
    const fromEmail = token?.email;
    if (!fromEmail) {
      throw new Error(
        `gmail.send: no Gmail token for userId=${ctx.userId} — the user hasn't connected Gmail.`,
      );
    }

    // 4. scheduled send — the workflow's step.sleepUntil(sendAt) re-invokes
    //    without sendAt to actually drain.
    if (input.sendAt && input.sendAt.getTime() > now.getTime() + 5_000) {
      await outbox.updateOne(
        { idempotencyKey: input.idempotencyKey },
        {
          $set: {
            status: "scheduled",
            sendAt: input.sendAt,
            updatedAt: now,
          },
          $unset: { lastError: "" },
        },
      );
      return { messageId: "", threadId: "", scheduled: true, spamScore: 0 };
    }

    // 5. compose body (tracking pixel + unsub footer). Tracking pixel id =
    //    idempotencyKey so MC can correlate the open back to this row.
    const trackingId = input.idempotencyKey;
    const unsubToken = signUnsubscribeToken(input.creatorTrackId, ctx.campaignId ?? "no-campaign");
    const unsubLink = unsubscribeUrl(input.publicBaseUrl, unsubToken);
    let html = appendUnsubscribeFooter(input.bodyHtml, unsubLink);
    html = appendTrackingPixel(html, trackingId, input.publicBaseUrl);

    // 5b. spam-score on the COMPOSED HTML (post-footer + pixel) — codex
    //     review P2#6. Scoring the pre-footer body unfairly tripped the
    //     `noUnsubscribe` rule on otherwise clean drafts since gmail.send
    //     always adds the footer; this fix lets the agent-authored body
    //     stand on its own content rules.
    const spam = calculateSpamScore(input.subject, html, fromEmail);
    const maxAllowed = input.maxSpamScore ?? DEFAULT_MAX_SPAM_SCORE;
    if (spam.score > maxAllowed) {
      const err = new Error(
        `gmail.send: spam_score_too_high (${spam.score} > ${maxAllowed}) — ` +
          `rules: ${spam.triggered.map((h) => h.ruleId).join(", ")}`,
      );
      await outbox.updateOne(
        { idempotencyKey: input.idempotencyKey },
        {
          $set: {
            status: "failed",
            spamScore: spam.score,
            lastError: err.message,
            updatedAt: new Date(),
          },
        },
      );
      throw err;
    }

    // 5. compose From header (RFC 2047 if non-ASCII display name)
    let fromHeader = fromEmail;
    const displayName = input.fromName?.trim();
    if (displayName && displayName !== fromEmail) {
      const encodedName = /[^\u0020-\u007E]/.test(displayName)
        ? `=?UTF-8?B?${Buffer.from(displayName, "utf8").toString("base64")}?=`
        : `"${displayName}"`;
      fromHeader = `${encodedName} <${fromEmail}>`;
    }

    const raw = buildMime({
      fromHeader,
      to: input.to,
      subject: input.subject,
      bodyHtml: html,
      threadId: input.threadId,
    });

    // 6. send via the injected (or default) GmailClient. The default factory
    //    refuses to operate without GOOGLE_CLIENT_ID + the wired googleapis
    //    SDK, so credential-less runs fail loudly here.
    const factory = getGmailClientFactory();
    const client = await factory(ctx.userId);
    let sent;
    try {
      sent = await client.send({ raw, threadId: input.threadId });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await outbox.updateOne(
        { idempotencyKey: input.idempotencyKey },
        {
          $set: {
            status: "failed",
            spamScore: spam.score,
            lastError: msg,
            updatedAt: new Date(),
          },
        },
      );
      throw err;
    }

    // 7. persist success — the claim-row exists already (step 1), so this
    //    is a plain update; no upsert needed.
    await outbox.updateOne(
      { idempotencyKey: input.idempotencyKey },
      {
        $set: {
          status: "sent",
          messageId: sent.messageId,
          threadId: sent.threadId,
          spamScore: spam.score,
          updatedAt: new Date(),
        },
        $unset: { lastError: "", sendAt: "" },
      },
    );

    return {
      messageId: sent.messageId,
      threadId: sent.threadId,
      scheduled: false,
      spamScore: spam.score,
    };
  },
});
