import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CampaignBrief, ConversationTurn, OutreachDraft, ReplyClass, TikTokCreator } from "@ss/contracts";
import { approvalRepo, campaignRepo, closeMongo, Collections, getDb, workspaceRepo } from "@ss/db";
import { memorySink, setObservabilitySink } from "@ss/observability";
import {
  setCarrierClientFactory,
  setGmailClientFactory,
  setUsageStore,
  tokenManager,
  type CarrierClient,
  type GmailClient,
  type UsageStore,
} from "@ss/capabilities";
import type { ModelClient, ModelTurn } from "@ss/agents";
import type { ApprovalResolvedData, StepLike } from "../gate";
import { creatorTrackHandler, type CreatorTrackResult } from "./creator-track";

/**
 * P2-C5 integration: drives creatorTrackHandler end-to-end through every
 * branch of the reply-classification matrix with:
 *   · a fake step that captures step.run + step.sendEvent + step.waitForEvent,
 *   · a context-aware fake ModelClient that dispatches by which agent's
 *     system prompt it sees (writer vs classifier vs responder),
 *   · a fake GmailClient (setGmailClientFactory) so no Gmail OAuth needed.
 * All real capabilities (outreach.extractFacts, outreach.judge,
 * gmail.send, workspace.getPolicy, campaignRepo) hit dev-mongo.
 */

const memUsageStore: UsageStore = {
  async increment() { return 1; },
  async decrement() {},
  async getOverride() { return null; },
};

const brief: CampaignBrief = {
  workspaceId: "ws_c5",
  createdBy: "u".repeat(21),
  brandProduct: {
    name: "Hydra Serum",
    category: "skincare/serum",
    description: "수분 세럼",
    keyClaims: ["7-day hydration", "fragrance-free"],
  },
  targeting: {
    creatorCount: 1,
    minEngagementRate: 0.001,
    languages: ["ko"],
    hashtags: ["스킨케어"],
    excludeBlacklist: true,
  },
  logistics: { shipsSamples: true },
  goals: { targetLivePosts: 1, deadline: new Date("2026-08-01") },
};

const creator: TikTokCreator = {
  id: "id_@freshly",
  uniqueId: "@freshly",
  nickname: "freshly",
  signature: "k-beauty / 수분",
  verified: false,
  privateAccount: false,
  followerCount: 42_000,
  followingCount: 110,
  videoCount: 80,
  heartCount: 1_500_000,
  hashtags: ["스킨케어", "kbeauty"],
};

const recentPosts = [
  { desc: "겨울철 보습 루틴 공유합니다!", hashtags: ["스킨케어"] },
  { desc: "신상 세럼 후기. 발림성 만족.", hashtags: [] },
];

const cleanDraft: OutreachDraft = {
  subject: "Quick collab idea — your 겨울철 보습 루틴 video",
  body:
    "<p>Hi @freshly, your '겨울철 보습 루틴' video stuck with me — that's exactly the moment Hydra Serum was built for: 7-day hydration, fragrance-free.</p>" +
    "<p>Open to sending you a sample? Your own angle. Brand HQ — 12 Garosu-gil, Gangnam-gu, Seoul. unsubscribe ok.</p>",
  angle: "data_specific",
  spamScore: 1,
  groundedFacts: ["recentPostThemes[0]", "brand.keyClaims[0]"],
  judgeScores: { brand: 0.95, conversion: 1, deliverability: 1, skeptic: 1 },
};

// ── Fake step capturing all interactions ─────────────────────────────────────

interface StepLog {
  runs: string[];
  events: Array<{ name: string; data: unknown }>;
  waits: Array<{ event: string; match?: string; timeout: string }>;
}

interface FakeStepOpts {
  /** Gate resolutions, keyed by gate kind. Defaults to "approved" with the agent's recommendation. */
  approvals?: Partial<Record<string, ApprovalResolvedData["decision"]>>;
  /** Reply event payload to inject; if null, simulate a 3-day timeout. */
  reply?: { fromEmail: string; subject: string; bodyText: string; messageId: string } | null;
  /**
   * Phase 3 C6 — shipment-tracking event payload to inject when the workflow
   * hits its `await-shipment:…` wait. `null` ⇒ 14-day timeout (no carrier
   * update).
   */
  shipmentEvent?: {
    status: "delivered" | "cancelled" | "failed" | "returned" | "in_transit" | "out_for_delivery" | "shipped" | "pending" | "address_pending";
    trackingNumber: string;
  } | null;
  /**
   * Phase 3 C6 — post-detected payload to inject for the `await-post:…`
   * wait. `null` ⇒ 14-day no-post timeout.
   */
  postEvent?: {
    postId: string;
    desc: string;
    hashtags: string[];
    views: number;
    likes: number;
    comments: number;
    shares: number;
    createdAt: Date;
    matchedHashtags: string[];
  } | null;
}

function fakeStep(opts: FakeStepOpts): { step: StepLike; log: StepLog } {
  const log: StepLog = { runs: [], events: [], waits: [] };
  /** Most recently `step.run("approval:create:<kind>")` — drives per-kind approval decisions. */
  let lastApprovalKind: string | undefined;
  const step: StepLike = {
    async run(name, fn) {
      log.runs.push(name);
      if (name.startsWith("approval:create:")) {
        lastApprovalKind = name.replace("approval:create:", "");
      }
      return fn();
    },
    async sendEvent(_stepName, payload) {
      const arr = Array.isArray(payload) ? payload : [payload];
      for (const p of arr) log.events.push(p);
      return { ids: arr.map((_, i) => `evt_${log.events.length - arr.length + i}`) };
    },
    async waitForEvent<T = ApprovalResolvedData>(stepName: string, optsArg: { event: string; match?: string; timeout: string }) {
      log.waits.push({ event: optsArg.event, match: optsArg.match, timeout: optsArg.timeout });
      // approvals resolve based on the kind of the most recent
      // step.run("approval:create:<kind>") — gate() always pairs them.
      if (stepName.startsWith("await-approval:")) {
        const approvalId = stepName.replace("await-approval:", "");
        const decision = (opts.approvals?.[lastApprovalKind ?? ""] ?? "approved") as ApprovalResolvedData["decision"];
        const data: ApprovalResolvedData = { approvalId, campaignId: "", decision };
        return { data: data as unknown as T };
      }
      // gmail reply wait
      if (stepName.startsWith("await-reply:")) {
        if (!opts.reply) return null;
        const data = {
          campaignId: "",
          creatorId: creator.id,
          threadId: "thread_test_1",
          messageId: opts.reply.messageId,
          fromEmail: opts.reply.fromEmail,
          subject: opts.reply.subject,
          bodyText: opts.reply.bodyText,
        };
        return { data: data as unknown as T };
      }
      // Phase 3 C6 — shipment tracking wait
      if (stepName.startsWith("await-shipment:")) {
        if (!opts.shipmentEvent) return null;
        const data = {
          campaignId,
          creatorTrackId: `${campaignId}:${creator.id}`,
          creatorId: creator.id,
          shipmentId: "ship_test_1",
          status: opts.shipmentEvent.status,
          trackingNumber: opts.shipmentEvent.trackingNumber,
        };
        return { data: data as unknown as T };
      }
      // Phase 3 C6 — post-detected wait
      if (stepName.startsWith("await-post:")) {
        if (!opts.postEvent) return null;
        const data = {
          campaignId,
          creatorTrackId: `${campaignId}:${creator.id}`,
          creatorId: creator.id,
          ...opts.postEvent,
        };
        return { data: data as unknown as T };
      }
      return null;
    },
  };
  return { step, log };
}

// ── Fake CarrierClient: returns a fixed tracking number ─────────────────────

function fakeCarrier(): CarrierClient {
  let n = 0;
  return {
    async createShipment() {
      n++;
      return { trackingNumber: `YT${String(n).padStart(8, "0")}` };
    },
    async trackShipment() { return { events: [] }; },
  };
}

// ── Fake GmailClient: deterministic message+thread ids ───────────────────────

function fakeGmail(): GmailClient & { calls: Array<{ raw: string; threadId?: string }> } {
  const calls: Array<{ raw: string; threadId?: string }> = [];
  return {
    calls,
    async send({ raw, threadId }) {
      calls.push({ raw, threadId });
      return {
        messageId: `gmail_msg_${calls.length}`,
        threadId: threadId ?? "thread_test_1",
      };
    },
  };
}

// ── Fake ModelClient: dispatches by system-prompt content ────────────────────

function dispatchingModel(args: {
  draft?: OutreachDraft;
  writerEscalateReason?: string;
  classification: ReplyClass | null; // null = classifier never asked (timeout)
  extracted?: ConversationTurn["extracted"];
  needsHumanReason?: string;
  responder?: { subject: string; body: string } | { escalate: string };
  /** Phase 3 C6 — drives the logistics agent's two-step (extractFacts→answer). */
  logistics?: {
    parsedAddress: {
      recipientName: string; phone: string; line1: string; line2: string;
      city: string; region: string; postalCode: string; countryCode: string;
    };
    escalate?: string;
  };
  /** Phase 3 C6 — content-verify is pure-text (no tools). */
  contentVerdict?: {
    matches: boolean; mentionsBrand: boolean; performanceScore: number;
    flags: string[]; rationale: string;
  };
}): ModelClient {
  let writerStep = 0;
  let responderStep = 0;
  let logisticsStep = 0;
  return {
    complete: async ({ system, messages }) => {
      // Writer agent — recognized by "Outreach Writer agent" in the prompt.
      if (system.includes("Outreach Writer")) {
        if (args.writerEscalateReason !== undefined) {
          return {
            kind: "text",
            text: JSON.stringify({ escalate: args.writerEscalateReason }),
            inputTokens: 80, outputTokens: 10,
          };
        }
        // Step 1: call outreach.extractFacts; Step 2..5: 4 judges on cleanDraft;
        // Step 6: return the final draft.
        const at = writerStep++;
        if (at === 0) {
          return {
            kind: "tool_use", toolUseId: "ef",
            toolName: "outreach.extractFacts",
            toolInput: { brief, creator, recentPosts },
            inputTokens: 80, outputTokens: 10,
          } satisfies ModelTurn;
        }
        if (at <= 4) {
          const judges = ["brand", "conversion", "deliverability", "skeptic"] as const;
          // pull facts back out of the last tool-result turn
          let facts: unknown = {};
          const last = messages[messages.length - 1];
          if (last?.content?.startsWith("Tool result for outreach.extractFacts")) {
            try {
              facts = JSON.parse(last.content.slice(last.content.indexOf("\n") + 1));
            } catch { /* tolerate */ }
          }
          return {
            kind: "tool_use", toolUseId: `j${at}`,
            toolName: "outreach.judge",
            toolInput: {
              judge: judges[at - 1],
              draft: args.draft ?? cleanDraft,
              facts,
              bannedPhrases: [],
            },
            inputTokens: 60, outputTokens: 10,
          } satisfies ModelTurn;
        }
        const d = args.draft ?? cleanDraft;
        return {
          kind: "text",
          text: JSON.stringify(d),
          inputTokens: 80, outputTokens: 220,
        };
      }

      // Classifier agent — recognized by "Conversation agent" / "classify".
      if (system.includes("You classify an inbound reply")) {
        if (args.classification === null) {
          throw new Error("dispatchingModel: classifier was unexpectedly invoked");
        }
        return {
          kind: "text",
          text: JSON.stringify({
            threadId: "thread_test_1",
            creatorId: creator.id,
            incomingMessageId: "msg_in",
            classification: args.classification,
            extracted: args.extracted ?? {},
            ...(args.needsHumanReason ? { needsHumanReason: args.needsHumanReason } : {}),
          }),
          inputTokens: 200, outputTokens: 80,
        };
      }

      // Responder agent — recognized by "Conversation Responder".
      if (system.includes("Conversation Responder")) {
        if (!args.responder) {
          throw new Error("dispatchingModel: responder asked but no script provided");
        }
        if ("escalate" in args.responder) {
          return {
            kind: "text",
            text: JSON.stringify({ escalate: args.responder.escalate }),
            inputTokens: 60, outputTokens: 10,
          };
        }
        const at = responderStep++;
        if (at === 0) {
          return {
            kind: "tool_use", toolUseId: "rj",
            toolName: "outreach.judge",
            toolInput: { judge: "deliverability", draft: args.responder, facts: {}, bannedPhrases: [] },
            inputTokens: 60, outputTokens: 10,
          } satisfies ModelTurn;
        }
        return {
          kind: "text",
          text: JSON.stringify({ ...args.responder, deliverabilityScore: 0.95 }),
          inputTokens: 80, outputTokens: 200,
        };
      }

      // Logistics agent — recognized by "Logistics agent" in the prompt.
      if (system.includes("Logistics agent")) {
        if (!args.logistics) {
          throw new Error("dispatchingModel: logistics asked but no script provided");
        }
        if (args.logistics.escalate) {
          return {
            kind: "text",
            text: JSON.stringify({ escalate: args.logistics.escalate }),
            inputTokens: 60, outputTokens: 10,
          };
        }
        const at = logisticsStep++;
        if (at === 0) {
          return {
            kind: "tool_use", toolUseId: "ship",
            toolName: "shipment.create",
            toolInput: {
              // Note: campaignId intentionally omitted (codex review P2#3 —
              // ctx provides the trusted value).
              creatorTrackId: `${campaignId}:${creator.id}`,
              creatorId: creator.id,
              carrier: "yuntrack",
              shippingAddress: args.logistics.parsedAddress,
              products: [{ sku: "DEMO-SAMPLE", name: "Demo sample", valueUsdCents: 0, weightGrams: 50 }],
              reference: "",
              notes: "",
            },
            inputTokens: 60, outputTokens: 10,
          } satisfies ModelTurn;
        }
        // Echo the shipment.create result.
        const last = messages[messages.length - 1];
        const jsonPart = last?.content?.startsWith("Tool result for shipment.create")
          ? last.content.slice(last.content.indexOf("\n") + 1)
          : "{}";
        return { kind: "text", text: jsonPart, inputTokens: 60, outputTokens: 200 };
      }

      // Content-verify agent — recognized by "Content-Verify agent".
      if (system.includes("Content-Verify agent")) {
        if (!args.contentVerdict) {
          throw new Error("dispatchingModel: contentVerify asked but no verdict provided");
        }
        return {
          kind: "text",
          text: JSON.stringify(args.contentVerdict),
          inputTokens: 200, outputTokens: 80,
        };
      }

      throw new Error(`dispatchingModel: unknown agent in system prompt: ${system.slice(0, 120)}`);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

let originalSecret: string | undefined;
let campaignId: string;

beforeAll(async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI not set — start scripts/dev-mongo first");
  }
  originalSecret = process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET;
  process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = "test_secret_at_least_16_chars_xxxxx";
  // Phase 3 shipment.create idempotency needs the unique index on
  // creatorTrackId; the production scripts/init-indexes.ts creates it.
  const db = await getDb();
  await db
    .collection(Collections.V2_SHIPMENTS)
    .createIndex({ creatorTrackId: 1 }, { unique: true })
    .catch(() => undefined);
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.V2_CAMPAIGNS).deleteMany({});
  await db.collection(Collections.V2_APPROVALS).deleteMany({});
  await db.collection(Collections.V2_WORKSPACE_POLICIES).deleteMany({});
  await db.collection(Collections.V2_OUTBOX).deleteMany({});
  await db.collection(Collections.V2_SUPPRESSION_LIST).deleteMany({});
  await db.collection(Collections.V2_SHIPMENTS).deleteMany({});
  await db.collection(Collections.SHARED_USER_TOKENS).deleteMany({});

  // Seed a campaign so patchTrack works.
  const c = await campaignRepo.create({ brief, status: "running", stage: "outreach", tracks: [] });
  campaignId = c.id;

  // Seed an OAuth token for the sender so gmail.send can resolve fromEmail.
  await tokenManager.saveToken({
    userId: brief.createdBy,
    email: "outreach@brand.example",
    accessToken: "at_fresh",
    refreshToken: "rt",
    expiresIn: 3600,
    scope: "https://www.googleapis.com/auth/gmail.send",
  });

  // Auto-approve every gate by default; per-test can override.
  setObservabilitySink(memorySink());
  setUsageStore(memUsageStore);
});

afterEach(() => {
  setObservabilitySink(undefined);
  setUsageStore(undefined);
  setGmailClientFactory(undefined);
  setCarrierClientFactory(undefined);
});

afterAll(async () => {
  if (originalSecret === undefined) delete process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET;
  else process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = originalSecret;
  await closeMongo();
});

// Build a baseline event for each test (campaignId is per-test).
function baseEvent() {
  return { data: { campaignId, brief, creator, creatorEmail: "freshly@example.com", recentPosts } };
}

async function run(modelClient: ModelClient, fake: ReturnType<typeof fakeStep>): Promise<CreatorTrackResult> {
  return creatorTrackHandler({ event: baseEvent(), step: fake.step }, {
    modelClient,
    publicBaseUrl: "https://app.example.com",
  });
}

describe("creator-track — branching matrix", () => {
  it("no creatorEmail ⇒ terminates 'no_email' immediately; no writer + no gmail.send", async () => {
    const gmail = fakeGmail();
    setGmailClientFactory(async () => gmail);
    const fake = fakeStep({ reply: null });
    const out = await creatorTrackHandler(
      { event: { data: { campaignId, brief, creator, recentPosts } }, step: fake.step },
      { modelClient: dispatchingModel({ classification: null }), publicBaseUrl: "https://app.example.com" },
    );
    expect(out.terminalState).toBe("no_email");
    expect(gmail.calls).toHaveLength(0);
    expect(fake.log.runs).not.toContain("draft-outreach");
  });

  it("happy P3 full loop: outreach → reply (interested+address) → ship → delivered → post.detected → verified", async () => {
    const gmail = fakeGmail();
    setGmailClientFactory(async () => gmail);
    setCarrierClientFactory(async () => fakeCarrier());
    const fake = fakeStep({
      reply: {
        fromEmail: "freshly@example.com",
        subject: "Re: Quick collab",
        bodyText: "보내주세요. 주소는 서울 강남구 가로수길 12, 101호 06000 입니다.",
        messageId: "msg_in_1",
      },
      shipmentEvent: { status: "delivered", trackingNumber: "YT00000001" },
      postEvent: {
        postId: "p_creator_1",
        desc: "Hydra Serum 진짜 발림성 좋아요 #스킨케어",
        hashtags: ["스킨케어"],
        views: 22_000,
        likes: 1_800,
        comments: 80,
        shares: 30,
        createdAt: new Date(),
        matchedHashtags: ["스킨케어"],
      },
    });
    const model = dispatchingModel({
      classification: "interested",
      extracted: { shippingAddress: "서울 강남구 가로수길 12, 101호 06000" },
      logistics: {
        parsedAddress: {
          recipientName: "Jiwoo", phone: "+82-10-0000-0000",
          line1: "12 Garosu-gil", line2: "Apt 101",
          city: "Seoul", region: "Gangnam-gu",
          postalCode: "06000", countryCode: "KR",
        },
      },
      contentVerdict: {
        matches: true, mentionsBrand: true, performanceScore: 82, flags: [],
        rationale: "Brand named, 1.8× baseline views, specific narrative.",
      },
    });
    const out = await run(model, fake);

    expect(out.terminalState).toBe("verified");
    expect(out.classification).toBe("interested");
    expect(out.threadId).toBe("thread_test_1");
    expect(out.shipmentId).toBeTruthy();
    expect(out.postId).toBe("p_creator_1");
    expect(out.contentVerdict?.matches).toBe(true);

    // gmail.send: outreach only (no reply drafted on the agreed/ship path).
    expect(gmail.calls).toHaveLength(1);

    // step.run sequence includes the new shipping + content steps.
    expect(fake.log.runs).toContain("create-shipment");
    expect(fake.log.runs).toContain("verify-content");
    // step.waitForEvent sequence: gmail-reply, shipment, post.
    const events = fake.log.waits.map((w) => w.event);
    expect(events).toContain("gmail/reply.received");
    expect(events).toContain("shipment/tracking.updated");
    expect(events).toContain("tiktok/post.detected");

    // Track state in Mongo: final state = verified.
    const persisted = await campaignRepo.get(campaignId);
    const track = persisted?.tracks.find((t) => t.creatorId === creator.id);
    expect(track?.state).toBe("verified");
  });

  it("interested + no address ⇒ responder drafts a follow-up; gmail.send called 2× (outreach + reply); state='in_conversation'", async () => {
    const gmail = fakeGmail();
    setGmailClientFactory(async () => gmail);
    const fake = fakeStep({
      reply: {
        fromEmail: "freshly@example.com",
        subject: "Re: Quick collab",
        bodyText: "Yes, interested! What's next?",
        messageId: "msg_in_2",
      },
    });
    const responderDraft = {
      subject: "Thanks @freshly — quick next-step question",
      body:
        "<p>Awesome, thank you! To send the sample, what's the shipping address?</p>" +
        "<p>Brand HQ: 12 Garosu-gil, Gangnam-gu, Seoul. unsubscribe link.</p>",
    };
    const model = dispatchingModel({
      classification: "interested",
      extracted: {}, // no address
      responder: responderDraft,
    });
    const out = await run(model, fake);

    expect(out.terminalState).toBe("in_conversation");
    expect(out.classification).toBe("interested");
    expect(gmail.calls).toHaveLength(2);
    expect(gmail.calls[1]!.threadId).toBe("thread_test_1"); // reply goes into the same thread

    const persisted = await campaignRepo.get(campaignId);
    const track = persisted?.tracks.find((t) => t.creatorId === creator.id);
    expect(track?.state).toBe("in_conversation");
    expect(track?.emailsSent).toBe(2);
  });

  it("needs_info ⇒ responder answers via gmail.send; state='in_conversation'", async () => {
    const gmail = fakeGmail();
    setGmailClientFactory(async () => gmail);
    const fake = fakeStep({
      reply: {
        fromEmail: "freshly@example.com",
        subject: "Re: Quick collab",
        bodyText: "혹시 영상 길이 기준이 있나요?",
        messageId: "msg_in_3",
      },
    });
    const model = dispatchingModel({
      classification: "needs_info",
      extracted: { question: "영상 길이 기준이 있나요?" },
      responder: {
        subject: "Re: 영상 길이 — your call",
        body: "<p>완전 자유입니다! 본인이 보통 만드시는 길이 그대로면 됩니다. unsubscribe ok. Address: Seoul.</p><p>다른 궁금한 점 있으시면 회신 주세요.</p>",
      },
    });
    const out = await run(model, fake);

    expect(out.terminalState).toBe("in_conversation");
    expect(out.classification).toBe("needs_info");
    expect(gmail.calls).toHaveLength(2);
  });

  it("declined ⇒ no responder, state='declined', gmail.send NOT called again", async () => {
    const gmail = fakeGmail();
    setGmailClientFactory(async () => gmail);
    const fake = fakeStep({
      reply: {
        fromEmail: "freshly@example.com",
        subject: "Re: Quick collab",
        bodyText: "관심 없습니다.",
        messageId: "msg_in_4",
      },
    });
    const model = dispatchingModel({
      classification: "declined",
      extracted: {},
      needsHumanReason: "Hard decline.",
    });
    const out = await run(model, fake);

    expect(out.terminalState).toBe("declined");
    expect(gmail.calls).toHaveLength(1); // only outreach; no reply sent
    const persisted = await campaignRepo.get(campaignId);
    const track = persisted?.tracks.find((t) => t.creatorId === creator.id);
    expect(track?.state).toBe("declined");
  });

  it("unsubscribe reply ⇒ also adds the recipient to the workspace suppression list (codex review P1#3)", async () => {
    const gmail = fakeGmail();
    setGmailClientFactory(async () => gmail);
    const fake = fakeStep({
      reply: {
        fromEmail: "freshly@example.com",
        subject: "Re: Quick collab",
        bodyText: "이메일 보내지 마세요. 수신거부 부탁드립니다.",
        messageId: "msg_in_unsub",
      },
    });
    const model = dispatchingModel({
      classification: "unsubscribe",
      extracted: {},
      needsHumanReason: "Explicit unsubscribe — add to suppression list.",
    });
    const out = await run(model, fake);
    expect(out.terminalState).toBe("declined");
    expect(out.classification).toBe("unsubscribe");

    const db = await getDb();
    const suppression = await db
      .collection(Collections.V2_SUPPRESSION_LIST)
      .findOne({ workspaceId: brief.workspaceId, email: "freshly@example.com" });
    expect(suppression).toBeTruthy();
    expect(suppression?.reason).toBe("unsubscribed");
    expect(suppression?.source).toContain("reply.unsubscribe");
  });

  it("negotiating ⇒ surfaces approveReplyResponse approval, no auto-reply, state='in_conversation'", async () => {
    const gmail = fakeGmail();
    setGmailClientFactory(async () => gmail);
    const fake = fakeStep({
      reply: {
        fromEmail: "freshly@example.com",
        subject: "Re: Quick collab",
        bodyText: "영상당 130만 원 받아요. 가능한가요?",
        messageId: "msg_in_5",
      },
    });
    const model = dispatchingModel({
      classification: "negotiating",
      extracted: { proposedRateUsd: 1000 },
      needsHumanReason: "Counter-offer USD 1000.",
    });
    const out = await run(model, fake);

    expect(out.terminalState).toBe("in_conversation");
    expect(out.classification).toBe("negotiating");
    expect(gmail.calls).toHaveLength(1);
    // an approveReplyResponse approval was created
    expect(fake.log.runs).toContain("approval:create:reply_response");
  });

  it("reply timeout (no event in 3d) ⇒ state='no_response'; classifier never invoked", async () => {
    const gmail = fakeGmail();
    setGmailClientFactory(async () => gmail);
    const fake = fakeStep({ reply: null });
    const model = dispatchingModel({ classification: null });
    const out = await run(model, fake);

    expect(out.terminalState).toBe("no_response");
    expect(out.threadId).toBe("thread_test_1");
    expect(gmail.calls).toHaveLength(1);
    // The waitForEvent surface was hit with the 3-day timeout.
    expect(fake.log.waits.some((w) => w.timeout === "3d" && w.event === "gmail/reply.received")).toBe(true);
    const persisted = await campaignRepo.get(campaignId);
    const track = persisted?.tracks.find((t) => t.creatorId === creator.id);
    expect(track?.state).toBe("no_response");
  });

  it("writer escalates ⇒ no gmail.send, no classification; terminal 'writer_escalated'", async () => {
    const gmail = fakeGmail();
    setGmailClientFactory(async () => gmail);
    const fake = fakeStep({ reply: null });
    const model = dispatchingModel({
      classification: null,
      writerEscalateReason: "insufficient_context",
    });
    const out = await run(model, fake);
    expect(out.terminalState).toBe("writer_escalated");
    expect(out.reason).toContain("insufficient_context");
    expect(gmail.calls).toHaveLength(0);
  });

  // ── Phase 3 C6 — shipping + content-review branches ────────────────────────

  it("P3: approveShipment rejected ⇒ terminal 'shipment_rejected' before logistics runs", async () => {
    const gmail = fakeGmail();
    setGmailClientFactory(async () => gmail);
    setCarrierClientFactory(async () => fakeCarrier());
    const fake = fakeStep({
      reply: {
        fromEmail: "freshly@example.com",
        subject: "Re: Quick collab",
        bodyText: "Address: 12 Garosu-gil 06000",
        messageId: "msg_in_p3a",
      },
      approvals: { shipment: "rejected" },
    });
    const model = dispatchingModel({
      classification: "interested",
      extracted: { shippingAddress: "12 Garosu-gil 06000" },
    });
    const out = await run(model, fake);
    expect(out.terminalState).toBe("shipment_rejected");
    expect(fake.log.runs).not.toContain("create-shipment");
  });

  it("P3 codex P1#3: approveShipment auto_unless + followerCountGte hit ⇒ approval created, recommendation carries followerCount", async () => {
    // Policy: auto_unless followerCount ≥ 30k. Creator's followerCount=42k ⇒ predicate fires.
    await workspaceRepo.savePolicy({
      workspaceId: brief.workspaceId,
      level: "checkpointed",
      gates: {
        approveShortlist: { mode: "always_ask" },
        approveOutreachSend: { mode: "auto" },
        approveReplyResponse: { mode: "auto" },
        approveShipment: { mode: "auto_unless", escalateIf: { followerCountGte: 30_000 } },
        approveStageAdvance: { mode: "always_ask" },
      },
      budgets: { maxUsdPerCampaign: 25, maxUsdPerWorkspaceMonthly: 200 },
      voice: { toneNotes: "", signatureBlock: "", bannedPhrases: [] },
      updatedAt: new Date(),
    });
    const gmail = fakeGmail();
    setGmailClientFactory(async () => gmail);
    setCarrierClientFactory(async () => fakeCarrier());
    const fake = fakeStep({
      reply: {
        fromEmail: "freshly@example.com",
        subject: "Re: Quick collab",
        bodyText: "Address: 12 Garosu-gil 06000",
        messageId: "msg_in_p3f",
      },
      // Approve via the fake step's gate-create path (auto-resolves to "approved").
      shipmentEvent: { status: "delivered", trackingNumber: "YT00000001" },
      postEvent: null, // we only care about the gate firing; let the post wait time out
    });
    const model = dispatchingModel({
      classification: "interested",
      extracted: { shippingAddress: "12 Garosu-gil 06000" },
      logistics: {
        parsedAddress: {
          recipientName: "Jiwoo", phone: "", line1: "12 Garosu-gil", line2: "",
          city: "Seoul", region: "", postalCode: "06000", countryCode: "KR",
        },
      },
    });
    await run(model, fake);
    // gate() created exactly one approval for kind=shipment because the
    // predicate fired (followerCount=42_000 ≥ followerCountGte=30_000).
    const db = await getDb();
    const approvalDocs = await db
      .collection(Collections.V2_APPROVALS)
      .find({ campaignId, kind: "shipment" })
      .toArray();
    expect(approvalDocs).toHaveLength(1);
    const approval = await approvalRepo.get(String(approvalDocs[0]?._id));
    expect(approval).toBeTruthy();
    // The recommendation payload must carry followerCount so the predicate
    // can evaluate; without it the gate would silently auto-approve (codex
    // review P3-full P1#3 — exactly the regression this test pins).
    const rec = approval!.recommendation as { followerCount?: number; creatorHandle?: string };
    expect(rec.followerCount).toBe(creator.followerCount);
    expect(rec.creatorHandle).toBe(creator.uniqueId);
  });

  it("P3 codex P1#3: approveShipment auto_unless + followerCountGte NOT met ⇒ no approval (gate auto-approves)", async () => {
    // Policy threshold above creator's 42k ⇒ predicate does NOT fire ⇒ no v2_approvals row.
    await workspaceRepo.savePolicy({
      workspaceId: brief.workspaceId,
      level: "checkpointed",
      gates: {
        approveShortlist: { mode: "always_ask" },
        approveOutreachSend: { mode: "auto" },
        approveReplyResponse: { mode: "auto" },
        approveShipment: { mode: "auto_unless", escalateIf: { followerCountGte: 1_000_000 } },
        approveStageAdvance: { mode: "always_ask" },
      },
      budgets: { maxUsdPerCampaign: 25, maxUsdPerWorkspaceMonthly: 200 },
      voice: { toneNotes: "", signatureBlock: "", bannedPhrases: [] },
      updatedAt: new Date(),
    });
    const gmail = fakeGmail();
    setGmailClientFactory(async () => gmail);
    setCarrierClientFactory(async () => fakeCarrier());
    const fake = fakeStep({
      reply: {
        fromEmail: "freshly@example.com",
        subject: "Re: Quick collab",
        bodyText: "Address: 12 Garosu-gil 06000",
        messageId: "msg_in_p3g",
      },
      shipmentEvent: { status: "delivered", trackingNumber: "YT00000002" },
      postEvent: null,
    });
    const model = dispatchingModel({
      classification: "interested",
      extracted: { shippingAddress: "12 Garosu-gil 06000" },
      logistics: {
        parsedAddress: {
          recipientName: "Jiwoo", phone: "", line1: "12 Garosu-gil", line2: "",
          city: "Seoul", region: "", postalCode: "06000", countryCode: "KR",
        },
      },
    });
    await run(model, fake);
    const db = await getDb();
    const approvalDocs = await db
      .collection(Collections.V2_APPROVALS)
      .find({ campaignId, kind: "shipment" })
      .toArray();
    expect(approvalDocs).toHaveLength(0);
    // The fake step's `approval:create:shipment` was therefore never run.
    expect(fake.log.runs).not.toContain("approval:create:shipment");
  });

  it("P3: logistics agent escalates address_unparseable ⇒ terminal 'shipment_rejected'", async () => {
    const gmail = fakeGmail();
    setGmailClientFactory(async () => gmail);
    setCarrierClientFactory(async () => fakeCarrier());
    const fake = fakeStep({
      reply: {
        fromEmail: "freshly@example.com",
        subject: "Re: Quick collab",
        bodyText: "Yes, here: nowhere",
        messageId: "msg_in_p3b",
      },
    });
    const model = dispatchingModel({
      classification: "interested",
      extracted: { shippingAddress: "nowhere" },
      logistics: { parsedAddress: {} as never, escalate: "address_unparseable: missing postalCode" },
    });
    const out = await run(model, fake);
    expect(out.terminalState).toBe("shipment_rejected");
    expect(out.reason).toMatch(/address_unparseable/);
  });

  it("P3: carrier reports cancelled ⇒ terminal 'shipment_failed' (no post-detect wait)", async () => {
    const gmail = fakeGmail();
    setGmailClientFactory(async () => gmail);
    setCarrierClientFactory(async () => fakeCarrier());
    const fake = fakeStep({
      reply: {
        fromEmail: "freshly@example.com",
        subject: "Re: Quick collab",
        bodyText: "Address: 12 Garosu-gil 06000",
        messageId: "msg_in_p3c",
      },
      shipmentEvent: { status: "cancelled", trackingNumber: "YT00000001" },
    });
    const model = dispatchingModel({
      classification: "interested",
      extracted: { shippingAddress: "서울 가로수길 12 06000" },
      logistics: {
        parsedAddress: {
          recipientName: "Jiwoo", phone: "", line1: "12 Garosu-gil", line2: "",
          city: "Seoul", region: "", postalCode: "06000", countryCode: "KR",
        },
      },
    });
    const out = await run(model, fake);
    expect(out.terminalState).toBe("shipment_failed");
    expect(out.shipmentId).toBeTruthy();
    // post.detected wait was never entered.
    expect(fake.log.waits.some((w) => w.event === "tiktok/post.detected")).toBe(false);
  });

  it("P3: delivered + no post within 14d ⇒ terminal 'flaked'", async () => {
    const gmail = fakeGmail();
    setGmailClientFactory(async () => gmail);
    setCarrierClientFactory(async () => fakeCarrier());
    const fake = fakeStep({
      reply: {
        fromEmail: "freshly@example.com",
        subject: "Re: Quick collab",
        bodyText: "Address: 12 Garosu-gil 06000",
        messageId: "msg_in_p3d",
      },
      shipmentEvent: { status: "delivered", trackingNumber: "YT00000001" },
      postEvent: null, // timeout
    });
    const model = dispatchingModel({
      classification: "interested",
      extracted: { shippingAddress: "서울 가로수길 12 06000" },
      logistics: {
        parsedAddress: {
          recipientName: "Jiwoo", phone: "", line1: "12 Garosu-gil", line2: "",
          city: "Seoul", region: "", postalCode: "06000", countryCode: "KR",
        },
      },
    });
    const out = await run(model, fake);
    expect(out.terminalState).toBe("flaked");
    expect(out.reason).toMatch(/no post detected/);
    expect(fake.log.runs).not.toContain("verify-content");
  });

  it("P3: post detected but content-verify matches=false ⇒ terminal 'flaked' with rationale", async () => {
    const gmail = fakeGmail();
    setGmailClientFactory(async () => gmail);
    setCarrierClientFactory(async () => fakeCarrier());
    const fake = fakeStep({
      reply: {
        fromEmail: "freshly@example.com",
        subject: "Re: Quick collab",
        bodyText: "Address: 12 Garosu-gil 06000",
        messageId: "msg_in_p3e",
      },
      shipmentEvent: { status: "delivered", trackingNumber: "YT00000001" },
      postEvent: {
        postId: "p_off_topic",
        desc: "오늘 점심 떡볶이 후기 #스킨케어",
        hashtags: ["스킨케어"],
        views: 800, likes: 20, comments: 1, shares: 0,
        createdAt: new Date(),
        matchedHashtags: ["스킨케어"],
      },
    });
    const model = dispatchingModel({
      classification: "interested",
      extracted: { shippingAddress: "서울 가로수길 12 06000" },
      logistics: {
        parsedAddress: {
          recipientName: "Jiwoo", phone: "", line1: "12 Garosu-gil", line2: "",
          city: "Seoul", region: "", postalCode: "06000", countryCode: "KR",
        },
      },
      contentVerdict: {
        matches: false, mentionsBrand: false, performanceScore: 22,
        flags: ["off_topic", "no_brand_mention"],
        rationale: "Hashtag overlap is coincidental — post is about food.",
      },
    });
    const out = await run(model, fake);
    expect(out.terminalState).toBe("flaked");
    expect(out.contentVerdict?.matches).toBe(false);
    expect(out.reason).toContain("coincidental");
  });
});
