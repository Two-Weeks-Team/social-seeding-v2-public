/**
 * DEMO-ONLY (local, uncommitted helper): seed v2_messages with the REAL two-way
 * campaign email history from v1's unified `emails` collection, fetched through
 * the same backend.socialseed.ing pipeline the avatars came from
 * (POST /api/v1/emails/aggregate, read-only $match by campaignData.campaignId).
 *
 * Replaces the earlier synthetic 5-creator seed with the authentic conversation:
 * outbound outreach/shipping/follow-ups + real inbound creator replies, grouped
 * by the real threadId. Maps each email to a v2 creator handle (influencerData →
 * "¡Hola <handle>!" subject → creator-email local-part) and writes them onto the
 * displayed wooriliu campaign so /threads + /campaigns/[id]/threads are complete.
 *
 * Backend creds read at runtime from v1 (~/social-seeding/.env.local) — none embedded.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27027/instarsearch \
 *   V1_CAMPAIGN_ID=68a2caf0044d2ccb1c135a14 V2_CAMPAIGN_ID=6a1f6ffd6dcae518cfc59ad2 \
 *   WORKSPACE_ID=ws_wooriliu_2nd \
 *   pnpm exec tsx scripts/demo/seed-threads-from-backend.ts
 */
import { readFileSync } from "node:fs";
import os from "node:os";

function parseEnvFile(p: string): Record<string, string> {
  const o: Record<string, string> = {};
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] && !line.trimStart().startsWith("#")) o[m[1]] = (m[2] ?? "").trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* ignore */
  }
  return o;
}

const v1EnvPath = process.env.V1_ENV_PATH ?? `${os.homedir()}/social-seeding/.env.local`;
const v1 = parseEnvFile(v1EnvPath);
const EMAIL = process.env.BACKEND_DASHBOARD_EMAIL || v1.BACKEND_DASHBOARD_EMAIL;
const PASSWORD = process.env.BACKEND_DASHBOARD_PASSWORD || v1.BACKEND_DASHBOARD_PASSWORD;
const BASE = (process.env.SS_BACKEND_URL || v1.BACKEND_URL || "https://backend.socialseed.ing").replace(/\/+$/, "");
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27027/instarsearch";

const V1_CAMPAIGN_ID = process.env.V1_CAMPAIGN_ID ?? "68a2caf0044d2ccb1c135a14";
const V2_CAMPAIGN_ID = process.env.V2_CAMPAIGN_ID ?? "6a1f6ffd6dcae518cfc59ad2";
const WORKSPACE_ID = process.env.WORKSPACE_ID ?? "ws_wooriliu_2nd";
// Contact redaction is ON by default — pass --no-redact only for a private local run.
const REDACT = !process.argv.includes("--no-redact");

if (!EMAIL || !PASSWORD) {
  console.error(`[seed-threads] missing backend creds (looked in ${v1EnvPath})`);
  process.exit(1);
}

interface RawEmail {
  _id?: unknown;
  messageId?: string;
  threadId?: string;
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  htmlContent?: string;
  snippet?: string;
  status?: string;
  direction?: string;
  sentAt?: string;
  date?: string;
  createdAt?: string;
  influencerData?: { uniqueId?: string; username?: string; displayName?: string; email?: string };
}

function emailAddr(s: string | undefined): string {
  const m = String(s ?? "").match(/<([^>]+)>/);
  return (m ? m[1]! : (s ?? "")).trim().toLowerCase();
}
function isBrandAddr(a: string): boolean {
  return /@2weeks\.co$/i.test(a) || a === "";
}
function safeCp(cp: number): string {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}
/** Decode the HTML entities these emails actually carry (incl. numeric emoji). */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => safeCp(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => safeCp(parseInt(n, 16)))
    .replace(/&amp;/g, "&"); // last, so "&amp;lt;" → "&lt;" → "<" never double-decodes
}
/**
 * Cut a reply's HTML at the start of the quoted previous message(s). Replies
 * carry the whole prior thread inline (Gmail `gmail_quote` / `<blockquote>`,
 * Outlook `appendonsend` / `divRplyFwdMsg`); the new text sits before it.
 */
function stripQuotedHtml(h: string): string {
  const markers = [
    /<div[^>]*class="[^"]*gmail_quote/i,
    /<blockquote/i,
    /<div[^>]*id="appendonsend"/i,
    /<div[^>]*id="divRplyFwdMsg"/i,
    /<hr[^>]*id="[^"]*(?:stopSpelling|Mailcontroller)/i,
  ];
  let cut = h.length;
  for (const re of markers) {
    const m = h.match(re);
    if (m && m.index !== undefined && m.index < cut) cut = m.index;
  }
  return h.slice(0, cut);
}
/** Plain-text fallback quote trim (Outlook localized headers, "On … wrote:", `____` divider, mobile signatures). */
function stripQuotedText(t: string): string {
  const markers = [
    /\n_{10,}\s*\n?/,
    /\n(?:On|El|Le|Am)\b.{0,90}?\b(?:wrote|escribió|escribio|a écrit|schrieb):/i,
    /\n(?:From|De|Von|Da):[^\n]*\n[^\n]*(?:Sent|Enviado|Envoyé|Gesendet|Date):/i,
    /\n?(?:Obtener|Get) Outlook (?:para|for)\b/i,
  ];
  let cut = t.length;
  for (const re of markers) {
    const m = t.match(re);
    if (m && m.index !== undefined && m.index < cut) cut = m.index;
  }
  return t.slice(0, cut).trim();
}
/** HTML → readable plain text: line breaks preserved, bullets per line, entities decoded. */
function htmlToText(h: string): string {
  const t = h
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(t)
    .replace(/[ \t\u00a0]+/g, " ") // collapse spaces/tabs but NOT newlines
    .replace(/\s*•\s*/g, "\n• ") // each • bullet on its own line
    .replace(/ *\n */g, "\n") // trim spaces hugging newlines
    .replace(/\n{3,}/g, "\n\n") // at most one blank line
    .trim();
}
function bodyOf(e: RawEmail): string {
  // htmlContent is the structured source here (body is often empty); strip the
  // quoted reply chain, then convert to readable text. Fall back to body/snippet.
  const html = (e.htmlContent ?? "").trim();
  if (html) {
    const text = stripQuotedText(htmlToText(stripQuotedHtml(html)));
    if (text.length > 1) return text;
  }
  const b = (e.body ?? "").trim();
  if (b) {
    const text = /<[a-z][\s\S]*>/i.test(b) ? htmlToText(stripQuotedHtml(b)) : decodeEntities(b);
    return stripQuotedText(text);
  }
  return (e.snippet ?? "").trim();
}
/**
 * Contact-detail redaction (default ON). The judge demo shows these REAL pilot
 * conversations read-only; creator privacy requires stripping contact channels
 * (emails / phones / shipping-address lines) while keeping the conversational
 * substance verbatim. The labels are deliberately visible — an honest editorial
 * mark, not silent substitution — and the policy is documented in
 * scripts/demo/submission/HONEST-SCOPE.md.
 */
function redactContacts(s: string): string {
  let out = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email removed — creator privacy]");
  // phone-ish: separator-joined digit runs that contain >= 9 digits (e.g. +52 …).
  // Date(+time) stamps ("2026-05-22 15", "22/05/2026 15.30") clear that digit bar
  // with only allowed separators — never treat a pure date-shaped match as a phone.
  const DATEISH =
    /^\s*(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})(?:[\s.]\d{1,2}(?:[:.]\d{2}){0,2})?\s*$/;
  out = out.replace(/\+?\d[\d\s().-]{7,}\d/g, (m) => {
    if (DATEISH.test(m)) return m;
    const digits = m.replace(/\D/g, "");
    return digits.length >= 9 ? "[phone removed — creator privacy]" : m;
  });
  // Address-looking LINES → drop the whole line. Two tiers so prose survives:
  //  · STRONG es-MX markers suffice alone (calle / colonia / C.P. … — these don't
  //    occur in normal prose);
  //  · en/number patterns must look like an actual street / unit / city-ZIP line,
  //    so "campaign #123", "test suite" or "an apt description" are NOT redacted.
  const ADDR_STRONG =
    /\b(calle|av(?:enida)?\.|col(?:onia)?\.|c\.?p\.?\s*\d{4,5}|c[oó]digo postal|direcci[oó]n|alcald[ií]a|delegaci[oó]n|cdmx|ciudad de m[eé]xico|estado de m[eé]xico)\b/i;
  const ADDR_STREET =
    /\b\d{1,5}\s+[A-Za-zÀ-ÿ.'-]+(?:\s+[A-Za-zÀ-ÿ.'-]+){0,3}\s+(?:st(?:reet)?|ave(?:nue)?|r(?:oa)?d|blvd|boulevard|dr(?:ive)?|lane|ln|court|ct|way|place|pl)\.?\b/i;
  const ADDR_UNIT = /\b(?:apt|apartment|suite|unit|depto|departamento|interior|int)\.?\s*#?\s*\d{1,5}\b/i;
  const ADDR_CITYZIP = /\b[A-Z][A-Za-zÀ-ÿ]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/;
  out = out
    .split("\n")
    .map((line) =>
      ADDR_STRONG.test(line) || ADDR_STREET.test(line) || ADDR_UNIT.test(line) || ADDR_CITYZIP.test(line)
        ? "[shipping address removed — creator privacy]"
        : line,
    )
    .join("\n")
    .replace(/(\[shipping address removed — creator privacy\]\n?){2,}/g, "[shipping address removed — creator privacy]\n");
  return out;
}
function whenOf(e: RawEmail): Date {
  const v = e.sentAt ?? e.date ?? e.createdAt;
  const d = v ? new Date(v) : new Date(0);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}
function isOutbound(e: RawEmail): boolean {
  if (e.status === "sent") return true;
  if (e.status === "received") return false;
  return e.direction !== "inbound" && e.direction !== "received";
}
function creatorEmailOf(e: RawEmail): string {
  const from = emailAddr(e.from);
  const to = emailAddr(e.to);
  return isOutbound(e) ? to : from;
}
function subjectHandle(subject: string | undefined): string | null {
  const m = String(subject ?? "").match(/¡Hola\s+([A-Za-z0-9_.]+)\s*!/);
  return m ? m[1]!.toLowerCase() : null;
}

async function main(): Promise<void> {
  // 1) backend login + aggregate (read-only) the real campaign emails.
  const lr = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    signal: AbortSignal.timeout(15_000),
  });
  const ld = (await lr.json()) as { api_key?: string };
  if (!ld.api_key) throw new Error(`backend login failed (${lr.status})`);

  const pipeline = [
    { $match: { "campaignData.campaignId": V1_CAMPAIGN_ID, status: { $ne: "failed" } } },
    { $sort: { sentAt: 1 } },
  ];
  const ar = await fetch(`${BASE}/api/v1/emails/aggregate`, {
    method: "POST",
    headers: { "X-API-Key": ld.api_key, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ pipeline }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!ar.ok) throw new Error(`aggregate returned ${ar.status}`);
  const aggBody = (await ar.json()) as RawEmail[] | { data?: RawEmail[]; results?: RawEmail[] };
  const emails: RawEmail[] = Array.isArray(aggBody) ? aggBody : (aggBody.data ?? aggBody.results ?? []);
  console.log(`[seed-threads] fetched ${emails.length} real emails for campaign ${V1_CAMPAIGN_ID}`);

  // 2) DB: known creator handles (a thread is only kept if it maps to one, so
  //    every rendered thread has a real avatar + links from the campaign detail).
  const { getDb, Collections, closeMongo } = await import("../../packages/db/src/index.ts");
  const db = await getDb();
  const accounts = await db
    .collection(Collections.SHARED_TIKTOK_ACCOUNTS)
    .find({}, { projection: { uniqueId: 1 } })
    .toArray();
  const knownHandles = new Set(accounts.map((a) => String(a.uniqueId).toLowerCase()).filter(Boolean));

  // creator-email -> handle, from the campaign export (recovers handles the
  // unified emails collection doesn't carry on influencerData).
  const emailToHandle = new Map<string, string>();
  try {
    const fixture = JSON.parse(readFileSync("fixtures/wooriliu-2nd/raw.json", "utf8")) as {
      campaign_influencers?: Array<{ uniqueId?: string; influencerEmail?: string; externalEmails?: string[] }>;
    };
    for (const ci of fixture.campaign_influencers ?? []) {
      const h = (ci.uniqueId ?? "").toLowerCase();
      if (!h) continue;
      for (const e of [ci.influencerEmail, ...(ci.externalEmails ?? [])].filter(Boolean)) {
        emailToHandle.set(String(e).toLowerCase(), h);
      }
    }
  } catch {
    /* fixture optional */
  }

  // 3) Group by threadId, derive one creator handle per thread.
  const byThread = new Map<string, RawEmail[]>();
  for (const e of emails) {
    const tid = e.threadId || e.messageId;
    if (!tid) continue;
    (byThread.get(tid) ?? byThread.set(tid, []).get(tid)!).push(e);
  }

  const docs: Record<string, unknown>[] = [];
  let threadsKept = 0;
  let threadsDropped = 0;
  for (const [threadId, msgs] of byThread) {
    msgs.sort((a, b) => whenOf(a).getTime() - whenOf(b).getTime());
    // candidate handles across the thread
    const candidates: string[] = [];
    for (const e of msgs) {
      const id = e.influencerData ?? {};
      const c = (id.uniqueId || id.username || subjectHandle(e.subject) || "").toString().toLowerCase().trim();
      if (c) candidates.push(c);
    }
    // creator email (non-brand party) — also a mapping source via the export.
    const creatorEmail = msgs.map(creatorEmailOf).find((a) => a && !isBrandAddr(a)) ?? "";
    if (creatorEmail && emailToHandle.has(creatorEmail)) candidates.unshift(emailToHandle.get(creatorEmail)!);
    if (creatorEmail) candidates.push(creatorEmail.split("@")[0]!.toLowerCase()); // local-part may equal the handle

    // Keep ONLY threads that resolve to a real TikTok handle (clean: avatar + links).
    const handle = candidates.map((c) => c.replace(/^@/, "")).find((c) => knownHandles.has(c));
    if (!handle) {
      threadsDropped++;
      continue;
    }
    threadsKept++;
    for (const e of msgs) {
      const rawBody = bodyOf(e);
      const body = REDACT ? redactContacts(rawBody) : rawBody;
      const rawSubject = (e.subject ?? "").trim();
      const subject = REDACT ? redactContacts(rawSubject) : rawSubject;
      docs.push({
        workspaceId: WORKSPACE_ID,
        campaignId: V2_CAMPAIGN_ID,
        creatorId: handle,
        threadId,
        direction: isOutbound(e) ? "outbound" : "inbound",
        subject: subject || "(제목 없음)",
        body: body || "(본문 없음)",
        sentAt: whenOf(e),
        classification: null,
        agentGenerated: isOutbound(e),
        messageId: e.messageId ?? null,
      });
    }
  }

  // 4) Replace the synthetic seed for THIS campaign only.
  const col = db.collection(Collections.V2_MESSAGES);
  const del = await col.deleteMany({ campaignId: V2_CAMPAIGN_ID });
  const ins = docs.length ? await col.insertMany(docs) : { insertedCount: 0 };
  const distinctCreators = new Set(docs.map((d) => d.creatorId)).size;
  console.log(
    `[seed-threads] threads kept ${threadsKept}, dropped(internal) ${threadsDropped} | ` +
      `deleted ${del.deletedCount} old, inserted ${ins.insertedCount} msgs across ${distinctCreators} creators`,
  );
  await closeMongo();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
