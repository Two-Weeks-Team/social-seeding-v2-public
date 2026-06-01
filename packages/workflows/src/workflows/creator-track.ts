import type { z } from "zod";
import {
  type ConversationTurn,
  type GateConfig,
  type OutreachDraft,
  type OutreachFacts,
  type Shipment,
  type ShipmentProduct,
  CreatorTrackStartEvent,
  Events,
  GmailReplyReceivedEvent,
  ShipmentTrackingUpdatedEvent,
  TikTokPostDetectedEvent,
  isTerminalShipmentStatus,
} from "@ss/contracts";
import { campaignRepo, workspaceRepo } from "@ss/db";
import { avgViewsOf, invokeCapability } from "@ss/capabilities";
import {
  conversationAgent,
  conversationResponderAgent,
  contentVerifyAgent,
  logisticsAgent,
  needsResponseDraft,
  outreachWriterAgent,
  runAgent,
  type AgentRunContext,
  type ContentVerifyOutput,
  type ModelClient,
} from "@ss/agents";
import { startTrace } from "@ss/observability";
import { gate, type StepLike } from "../gate";
import { pauseCheck } from "../pause";
import { inngest } from "../client";

/**
 * creator-track — per-creator child workflow spawned by brand-campaign once
 * a shortlist track is confirmed. Owns one creator's journey for the Phase-2
 * outreach + reply slice:
 *
 *   1. Load brief + creator + recentPosts from the event payload.
 *   2. Resolve workspace policy.
 *   3. outreach.extractFacts → if !hasMinimumContext, terminate writer_escalated.
 *   4. runAgent(outreachWriterAgent) → draft + judge scores. If the agent
 *      escalates, terminate writer_escalated.
 *   5. gate(approveOutreachSend) on the draft. If rejected, terminate
 *      outreach_rejected.
 *   6. invokeCapability("gmail.send", ...) with idempotencyKey
 *      = `${campaignId}:${creatorId}:outreach`. State → outreach_sent.
 *   7. step.waitForEvent("gmail/reply.received", { match: "data.threadId",
 *      timeout: "3d" }). On timeout → state = no_response, terminate.
 *   8. runAgent(conversationAgent) to classify.
 *   9. Branch on classification (carries the v2 reply-handling discipline —
 *      see also @ss/agents conversation × responder golden set):
 *        · declined / unsubscribe / not_now / out_of_office / unrelated →
 *          terminal; no reply drafted.
 *        · negotiating → terminal "in_conversation"; the workflow surfaces an
 *          approveReplyResponse approval with `needsHumanReason` so MC can
 *          show the verbatim rate counter-offer for the human to handle.
 *        · interested + shippingAddress → state="agreed"; terminate (Phase-3
 *          shipment workflow takes over).
 *        · interested (no address) / needs_info → runAgent(responder) →
 *          gate(approveReplyResponse) → gmail.send (idempotencyKey:
 *          `…:reply:${incomingMessageId}`). state stays in_conversation; the
 *          workflow exits (multi-turn back-and-forth is a Phase-2.5 follow-up).
 *
 * Notes / Phase-2 scope:
 *   · No follow-up nudges yet — one outbound + at most one reply round-trip.
 *     A 3-day timeout closes the track as no_response. Multi-touch follow-ups
 *     ship in P2.5 (port v1 cold-mail/followup.ts).
 *   · The default Gmail factory throws (P2-C2 doc) so live runs need
 *     `googleapis` wired AND a real OAuth token. Tests inject a fake via
 *     setGmailClientFactory().
 *   · creator.email is optional on the event payload — when absent, the track
 *     terminates as `no_email`. P5 CRM enrichment fills that gap.
 */

type CreatorTrackEventData = z.infer<typeof CreatorTrackStartEvent.shape.data>;
type GmailReplyData = z.infer<typeof GmailReplyReceivedEvent.shape.data>;
type ShipmentTrackingData = z.infer<typeof ShipmentTrackingUpdatedEvent.shape.data>;
type PostDetectedData = z.infer<typeof TikTokPostDetectedEvent.shape.data>;

export type CreatorTrackTerminalState =
  | "no_email"
  | "writer_escalated"
  | "outreach_rejected"
  // Outreach + reply legs (Phase 2).
  | "outreach_sent" // sent + waiting (timeout path returns no_response)
  | "no_response"
  | "declined" // includes unsubscribe + not_now (collapses to a single terminal "no")
  | "in_conversation"
  // Shipping leg (Phase 3 C6).
  | "shipment_rejected" // approveShipment gate said no
  | "shipment_failed" // carrier-side terminal failure (returned / failed / cancelled)
  | "shipped" // shipment created + handed off; awaiting carrier delivery
  | "delivered" // carrier confirmed delivery; awaiting creator post
  // Content-review leg (Phase 3 C6).
  | "verified" // contentVerifyAgent → matches=true, terminal good
  | "flaked"; // 14d-no-post OR contentVerifyAgent → matches=false

export interface CreatorTrackResult {
  campaignId: string;
  creatorId: string;
  terminalState: CreatorTrackTerminalState;
  reason?: string;
  /** Gmail thread id once an outreach send succeeded. */
  threadId?: string;
  /** The classifier's verdict if we got a reply. */
  classification?: ConversationTurn["classification"];
  /** Once a shipment was created, the v2_shipments row id. */
  shipmentId?: string;
  /** Once a post was matched + verified, the post id. */
  postId?: string;
  /** Content-verify scorecard if we got that far. */
  contentVerdict?: ContentVerifyOutput;
}

export interface CreatorTrackArgs {
  event: { data: CreatorTrackEventData };
  step: StepLike;
}

export interface CreatorTrackDeps {
  /** Injected for tests; default = Anthropic-backed defaultModelClient. */
  modelClient?: ModelClient;
  /** Public base URL plumbed into gmail.send for the tracking pixel + unsub link. */
  publicBaseUrl?: string;
  /**
   * Per-track product manifest. Phase 3 demo: every track in a campaign
   * ships the same SKU; this is hard-coded here. Phase 4+ will source it
   * from the campaign brief's `logistics.sampleSku` resolved through a
   * product catalog.
   */
  products?: ShipmentProduct[];
}

const REPLY_TIMEOUT = "3d";
/**
 * Deadline on each shipping / content-review wait. Matches v1's
 * 14-day-no-post heuristic + gives carriers enough room for international
 * shipping (typical 7-10 days from Seoul → SE Asia / EU).
 */
const SHIPMENT_TIMEOUT = "14d";
const CONTENT_TIMEOUT = "14d";

/** Default product manifest when the caller didn't provide one. */
const DEFAULT_DEMO_PRODUCT: ShipmentProduct = {
  sku: "DEMO-SAMPLE",
  name: "Demo sample",
  valueUsdCents: 0,
  weightGrams: 50,
};

function gateConfigFor(gates: Record<string, GateConfig>, key: keyof typeof gates): GateConfig {
  return gates[key] ?? { mode: "always_ask" };
}

async function patchTrack(
  campaignId: string,
  creatorId: string,
  state: NonNullable<Parameters<typeof campaignRepo.upsertTrack>[1]["state"]>,
  patch: Partial<Parameters<typeof campaignRepo.upsertTrack>[1]> = {},
): Promise<void> {
  // Stage derivation: track.stage = "content_review" once we're inside the
  // P3 content-review leg (state in {delivered, verified, posted, flaked}),
  // "shipping" once in the shipping leg, otherwise "outreach" carrying
  // forward Phase 2's default. The MC reads track.stage to bucket tracks
  // in the campaign canvas + the stage bar.
  const stage =
    state === "verified" || state === "posted" || state === "flaked"
      ? "content_review"
      : state === "delivered" || state === "shipped" || state === "address_collected"
        ? "shipping"
        : "outreach";
  await campaignRepo.upsertTrack(campaignId, {
    creatorId,
    stage,
    state,
    lastActivityAt: new Date(),
    emailsSent: patch.emailsSent ?? 0,
    ...(patch.threadId ? { threadId: patch.threadId } : {}),
    ...(patch.pendingApprovalId ? { pendingApprovalId: patch.pendingApprovalId } : {}),
    ...(patch.content ? { content: patch.content } : {}),
  });
}

export async function creatorTrackHandler(
  { event, step }: CreatorTrackArgs,
  deps: CreatorTrackDeps = {},
): Promise<CreatorTrackResult> {
  const { campaignId, brief, creator, creatorEmail, recentPosts } = event.data;
  const creatorId = creator.id;
  const workspaceId = brief.workspaceId;

  // ── No email → can't send anything. Terminate cleanly. ───────────────────
  if (!creatorEmail) {
    await step.run("no-email-mark", async () =>
      patchTrack(campaignId, creatorId, "no_response"),
    );
    return { campaignId, creatorId, terminalState: "no_email", reason: "creator has no resolvable email" };
  }

  // ── Load workspace policy (gates + voice + budget) ───────────────────────
  const policy = await step.run("plan", async () => workspaceRepo.getPolicy(workspaceId));

  const trace = startTrace(campaignId);
  const agentCtx: AgentRunContext = {
    // campaignId is load-bearing: gmail.send writes it on v2_outbox so the
    // Pub/Sub webhook can join replies back to (campaign, creator), AND the
    // unsubscribe footer's HMAC token uses it as `cid` so /unsubscribe knows
    // which campaign to look up. Codex review P1#1.
    capabilityCtx: { workspaceId, userId: brief.createdBy, campaignId, rateLimitClass: "default" },
    trace,
    campaignBudgetUsd: policy.budgets.maxUsdPerCampaign,
    ...(deps.modelClient ? { model: deps.modelClient } : {}),
  };

  // ── Extract facts up-front. The writer also calls extractFacts internally,
  //    but doing it here makes the OutreachFacts available to the responder
  //    later without re-deriving. Cheap (pure, no LLM).
  const facts = (await step.run("extract-facts", async () =>
    invokeCapability(
      "outreach.extractFacts",
      { brief, creator, recentPosts },
      agentCtx.capabilityCtx,
    ),
  )) as OutreachFacts;
  if (!facts.hasMinimumContext) {
    await patchTrack(campaignId, creatorId, "no_response");
    return {
      campaignId,
      creatorId,
      terminalState: "writer_escalated",
      reason: "no signature and no recent posts — insufficient context for a personalized draft",
    };
  }

  // ── Stage: write the outreach draft via the writer agent (tournament) ───
  const draftOutcome = await step.run("draft-outreach", async () =>
    runAgent(
      outreachWriterAgent,
      {
        brief,
        creator,
        recentPosts,
        // Pass the already-computed facts so the writer doesn't have to
        // call extractFacts again (carry-over lesson 2026-05-14: Opus
        // sometimes refuses to call it and escalates).
        facts,
        voiceNotes: policy.voice.toneNotes,
        signatureBlock: policy.voice.signatureBlock,
        bannedPhrases: policy.voice.bannedPhrases,
      },
      agentCtx,
    ),
  );
  if (draftOutcome.kind !== "ok") {
    await patchTrack(campaignId, creatorId, "no_response");
    return {
      campaignId,
      creatorId,
      terminalState: "writer_escalated",
      reason: draftOutcome.reason,
    };
  }

  // ── Gate: approveOutreachSend ────────────────────────────────────────────
  const sendResolution = await gate<OutreachDraft>(
    step,
    gateConfigFor(policy.gates as unknown as Record<string, GateConfig>, "approveOutreachSend"),
    {
      campaignId,
      workspaceId,
      kind: "outreach_send",
      recommendation: draftOutcome.value,
      rationale: `tournament winner (angle: ${draftOutcome.value.angle}). spamScore=${draftOutcome.value.spamScore.toFixed(1)}; judgeScores=${JSON.stringify(draftOutcome.value.judgeScores ?? {})}.`,
    },
  );
  if (sendResolution.decision === "rejected") {
    await patchTrack(campaignId, creatorId, "declined");
    return { campaignId, creatorId, terminalState: "outreach_rejected" };
  }
  const finalDraft = sendResolution.payload;

  // ── Pause/cancel check before the load-bearing external send ───────────
  // Carry-over (P6.5): if the operator clicked "일시정지" on /campaigns/[id],
  // pauseCheck parks the workflow on waitForEvent('campaign/resumed') until
  // the operator hits "재개". If they cancelled instead, pauseCheck throws
  // CampaignTerminalError so this step exits without sending.
  await pauseCheck(step, campaignId);

  // ── Send the outreach via gmail.send (idempotencyKey scopes retries) ────
  const sendResult = (await step.run("send-outreach", async () =>
    invokeCapability(
      "gmail.send",
      {
        to: creatorEmail,
        subject: finalDraft.subject,
        bodyHtml: finalDraft.body,
        creatorTrackId: `${campaignId}:${creatorId}`,
        idempotencyKey: `${campaignId}:${creatorId}:outreach`,
        publicBaseUrl: deps.publicBaseUrl ?? process.env.PUBLIC_APP_URL ?? "https://app.example.com",
        fromName: policy.voice.signatureBlock ? undefined : undefined,
      },
      agentCtx.capabilityCtx,
    ),
  )) as { messageId: string; threadId: string; scheduled: boolean; spamScore: number };

  await step.run("outreach-sent-mark", async () =>
    patchTrack(campaignId, creatorId, "outreach_sent", {
      emailsSent: 1,
      threadId: sendResult.threadId,
    }),
  );

  // ── Wait for a reply (3-day timeout). ─────────────────────────────────────
  // Inngest `match` correlates by extracting `event.data.<path>` from BOTH
  // the trigger event (CreatorTrackStart) AND the awaited event. The trigger
  // has no `threadId`, so we cannot match on it — codex review P1#2.
  // Instead drop `match` entirely and use a self-contained `if` expression
  // that pins the await to this specific (campaign, creator, thread) tuple
  // by literal substitution.
  //
  // CRITICAL: use `async.data.X` for awaited-event fields, NOT
  // `event.data.X`. In waitForEvent.if, `event` is the TRIGGER event and
  // gets pre-evaluated by the SDK at wait-creation time (so
  // `event.data.threadId` substitutes to null, making the wait never
  // match). `async` refers to the incoming awaited event and is
  // evaluated when each candidate event arrives.
  // Live-demo lesson 2026-05-14 (P2 codex P1#2 second-pass).
  const reply = await step.waitForEvent<GmailReplyData>(`await-reply:${campaignId}:${creatorId}`, {
    event: Events.GmailReplyReceived,
    timeout: REPLY_TIMEOUT,
    if: `async.data.campaignId == "${campaignId}" && async.data.creatorId == "${creatorId}" && async.data.threadId == "${sendResult.threadId}"`,
  });
  if (!reply) {
    await patchTrack(campaignId, creatorId, "no_response", {
      emailsSent: 1,
      threadId: sendResult.threadId,
    });
    return {
      campaignId,
      creatorId,
      terminalState: "no_response",
      threadId: sendResult.threadId,
    };
  }

  // ── Classify the reply. Haiku, no tools. ────────────────────────────────
  const classifyOutcome = await step.run("classify-reply", async () =>
    runAgent(
      conversationAgent,
      {
        threadId: reply.data.threadId,
        creatorId,
        incomingMessage: {
          messageId: reply.data.messageId,
          fromEmail: reply.data.fromEmail,
          subject: reply.data.subject,
          bodyText: reply.data.bodyText,
        },
        threadHistory: [
          { role: "us" as const, subject: finalDraft.subject, bodyText: finalDraft.body },
        ],
        creatorHandle: creator.uniqueId.replace(/^@/, ""),
      },
      agentCtx,
    ),
  );

  if (classifyOutcome.kind !== "ok") {
    await patchTrack(campaignId, creatorId, "in_conversation", {
      emailsSent: 1,
      threadId: sendResult.threadId,
    });
    return {
      campaignId,
      creatorId,
      terminalState: "in_conversation",
      threadId: sendResult.threadId,
      reason: `classifier escalated: ${classifyOutcome.reason}`,
    };
  }
  const turn = classifyOutcome.value;

  // ── Terminal branches that don't draft a reply ──────────────────────────
  if (
    turn.classification === "declined" ||
    turn.classification === "unsubscribe" ||
    turn.classification === "not_now" ||
    turn.classification === "out_of_office" ||
    turn.classification === "unrelated"
  ) {
    const state = turn.classification === "declined" || turn.classification === "unsubscribe" ? "declined" : "no_response";
    // unsubscribe ⇒ honor the request at the workspace level: every future
    // campaign in this workspace should refuse to mail this address.
    // gmail.send's pre-send check reads the same list. Codex review P1#3.
    if (turn.classification === "unsubscribe") {
      await step.run("suppression-from-reply", async () =>
        invokeCapability(
          "suppression.add",
          {
            email: reply.data.fromEmail,
            reason: "unsubscribed",
            source: `reply.unsubscribe (${reply.data.messageId})`,
            campaignId,
            creatorId,
          },
          agentCtx.capabilityCtx,
        ),
      );
    }
    await patchTrack(campaignId, creatorId, state, {
      emailsSent: 1,
      threadId: sendResult.threadId,
    });
    return {
      campaignId,
      creatorId,
      terminalState: state,
      classification: turn.classification,
      threadId: sendResult.threadId,
    };
  }

  // negotiating → ALWAYS escalates. We pass `{ mode: "always_ask" }` literally
  // instead of policy.gates.approveReplyResponse — codex review P2#7 —
  // otherwise an operator with the policy set to `auto` would skip the human
  // review even though the contract (and the classifier's tone) say a rate
  // counter-offer must reach a human.
  if (turn.classification === "negotiating") {
    await step.run("escalate-negotiating", async () =>
      gate(step, { mode: "always_ask" }, {
        campaignId,
        workspaceId,
        kind: "reply_response",
        recommendation: turn,
        rationale:
          turn.needsHumanReason ??
          `Creator counter-offered (proposedRateUsd=${turn.extracted.proposedRateUsd ?? "?"}). Negotiating replies always escalate to a human.`,
      }),
    );
    await patchTrack(campaignId, creatorId, "in_conversation", {
      emailsSent: 1,
      threadId: sendResult.threadId,
    });
    return {
      campaignId,
      creatorId,
      terminalState: "in_conversation",
      classification: "negotiating",
      threadId: sendResult.threadId,
    };
  }

  // interested + shippingAddress → Phase 3 shipping + content-review legs.
  if (turn.classification === "interested" && turn.extracted.shippingAddress) {
    return runShippingAndContentReview({
      step,
      agentCtx,
      campaignId,
      creatorId,
      creatorTrackId: `${campaignId}:${creatorId}`,
      brief,
      policy,
      rawAddress: turn.extracted.shippingAddress,
      products: deps.products ?? [DEFAULT_DEMO_PRODUCT],
      threadId: sendResult.threadId,
      classification: turn.classification,
      // Codex review P3-full P1#3: the approveShipment gate's `followerCountGte`
      // predicate needs `followerCount` on the recommendation payload, otherwise
      // an `auto_unless` policy silently auto-approves every shipment.
      creator: {
        id: creator.id,
        uniqueId: creator.uniqueId,
        followerCount: creator.followerCount,
      },
      recentPosts,
    });
  }

  // interested (no address) / needs_info → draft a reply via the Opus
  // responder, gate on approveReplyResponse, send. State stays in_conversation.
  if (!needsResponseDraft(turn)) {
    // Defensive — shouldn't reach here given the branches above, but if a new
    // ReplyClass slips in, default to in_conversation rather than silently
    // skipping a response.
    await patchTrack(campaignId, creatorId, "in_conversation", {
      emailsSent: 1,
      threadId: sendResult.threadId,
    });
    return {
      campaignId,
      creatorId,
      terminalState: "in_conversation",
      classification: turn.classification,
      threadId: sendResult.threadId,
    };
  }

  const responseOutcome = await step.run("draft-response", async () =>
    runAgent(
      conversationResponderAgent,
      {
        turn,
        facts,
        threadHistory: [
          { role: "us" as const, subject: finalDraft.subject, bodyText: finalDraft.body },
          {
            role: "them" as const,
            subject: reply.data.subject,
            bodyText: reply.data.bodyText,
          },
        ],
        voiceNotes: policy.voice.toneNotes,
        signatureBlock: policy.voice.signatureBlock,
        bannedPhrases: policy.voice.bannedPhrases,
      },
      agentCtx,
    ),
  );
  if (responseOutcome.kind !== "ok") {
    await patchTrack(campaignId, creatorId, "in_conversation", {
      emailsSent: 1,
      threadId: sendResult.threadId,
    });
    return {
      campaignId,
      creatorId,
      terminalState: "in_conversation",
      classification: turn.classification,
      threadId: sendResult.threadId,
      reason: `responder escalated: ${responseOutcome.reason}`,
    };
  }
  const draftedReply = responseOutcome.value;

  // gate(approveReplyResponse) — auto, auto_unless, or always_ask
  const replyResolution = await gate<{ subject: string; body: string; deliverabilityScore?: number }>(
    step,
    gateConfigFor(policy.gates as unknown as Record<string, GateConfig>, "approveReplyResponse"),
    {
      campaignId,
      workspaceId,
      kind: "reply_response",
      recommendation: draftedReply,
      rationale: `responder draft for classification=${turn.classification}. deliverabilityScore=${draftedReply.deliverabilityScore?.toFixed(2) ?? "n/a"}.`,
    },
  );
  if (replyResolution.decision === "rejected") {
    await patchTrack(campaignId, creatorId, "in_conversation", {
      emailsSent: 1,
      threadId: sendResult.threadId,
    });
    return {
      campaignId,
      creatorId,
      terminalState: "in_conversation",
      classification: turn.classification,
      threadId: sendResult.threadId,
      reason: "reply_response rejected",
    };
  }
  const finalReply = replyResolution.payload;

  // Send the reply. idempotencyKey carries the inbound messageId so a webhook
  // replay never produces two replies for the same inbound.
  // P6.5 pause check before the reply send (same posture as the outreach send).
  await pauseCheck(step, campaignId);
  await step.run("send-reply", async () =>
    invokeCapability(
      "gmail.send",
      {
        to: reply.data.fromEmail,
        subject: finalReply.subject,
        bodyHtml: finalReply.body,
        creatorTrackId: `${campaignId}:${creatorId}`,
        threadId: sendResult.threadId,
        idempotencyKey: `${campaignId}:${creatorId}:reply:${reply.data.messageId}`,
        publicBaseUrl: deps.publicBaseUrl ?? process.env.PUBLIC_APP_URL ?? "https://app.example.com",
      },
      agentCtx.capabilityCtx,
    ),
  );

  await patchTrack(campaignId, creatorId, "in_conversation", {
    emailsSent: 2,
    threadId: sendResult.threadId,
  });

  return {
    campaignId,
    creatorId,
    terminalState: "in_conversation",
    classification: turn.classification,
    threadId: sendResult.threadId,
  };
}

/**
 * Phase 3 C6 — the shipping + content-review legs. Called from the
 * `interested + shippingAddress` branch of the classification matrix once
 * the creator has agreed and shared an address.
 *
 *   1. state="address_collected"; gate(approveShipment) on the (rawAddress,
 *      brand, productManifest) tuple. Rejected → terminal shipment_rejected.
 *   2. step.run("create-shipment") → runAgent(logisticsAgent) which parses
 *      the address + invokes shipment.create. Escalation
 *      ("address_unparseable") → terminal shipment_rejected.
 *   3. state="shipped"; wait for `shipment/tracking.updated` (14d timeout)
 *      pinned to (campaignId, creatorId). Producer is the carrier-poller
 *      (Phase-3.5 follow-up); tests inject the event directly.
 *   4. Branch on the carrier's reported status:
 *        · delivered            → state="delivered"; proceed to content review.
 *        · cancelled / failed   → terminal shipment_failed.
 *   5. state="delivered"; wait for `tiktok/post.detected` (14d timeout).
 *      Timeout → terminal flaked.
 *   6. runAgent(contentVerifyAgent) on the detected post:
 *        · matches=true → state="verified", terminal verified.
 *        · matches=false → terminal flaked (with rationale).
 *
 * Gates honored at the workflow level:
 *   · approveShipment (Phase-2 placeholder → real producer in Phase-3 C6).
 *
 * The Phase-2 gate() helper drives policy mode (always_ask / auto /
 * auto_unless) and surfaces the v2_approvals row when human review is
 * required.
 */
interface ShippingArgs {
  step: StepLike;
  agentCtx: AgentRunContext;
  campaignId: string;
  creatorId: string;
  creatorTrackId: string;
  brief: CreatorTrackEventData["brief"];
  policy: Awaited<ReturnType<typeof workspaceRepo.getPolicy>>;
  rawAddress: string;
  products: ShipmentProduct[];
  threadId: string;
  classification: ConversationTurn["classification"];
  /**
   * Creator metadata required for the approveShipment gate's `followerCountGte`
   * predicate. Codex review P3-full P1#3: without this, an `auto_unless`
   * policy with a follower threshold has nothing to evaluate against, so the
   * gate silently auto-approves every shipment.
   */
  creator: { id: string; uniqueId: string; followerCount: number };
  /** Creator's recent posts — used as the content-verify baseline (avgViews). */
  recentPosts: CreatorTrackEventData["recentPosts"];
}

async function runShippingAndContentReview(args: ShippingArgs): Promise<CreatorTrackResult> {
  const {
    step,
    agentCtx,
    campaignId,
    creatorId,
    creatorTrackId,
    brief,
    policy,
    rawAddress,
    products,
    threadId,
    classification,
    recentPosts,
  } = args;

  // ── 1. address_collected → approveShipment gate ─────────────────────────
  await patchTrack(campaignId, creatorId, "address_collected", {
    emailsSent: 1,
    threadId,
  });

  const gateResolution = await gate(
    step,
    gateConfigFor(policy.gates as unknown as Record<string, GateConfig>, "approveShipment"),
    {
      campaignId,
      workspaceId: brief.workspaceId,
      kind: "shipment",
      // Codex review P3-full P1#3: `followerCount` is required by the
      // `followerCountGte` predicate on `auto_unless` policies. `creatorId` +
      // `creatorHandle` are also bundled so MC's approval inbox can render
      // who-is-this without an extra fetch.
      recommendation: {
        rawAddress,
        brand: brief.brandProduct.name,
        products,
        creatorId: args.creator.id,
        creatorHandle: args.creator.uniqueId,
        followerCount: args.creator.followerCount,
      },
      rationale: `Creator @${args.creator.uniqueId} (${args.creator.followerCount.toLocaleString()} followers) agreed. About to ship ${products.length} item(s) to: "${rawAddress.slice(0, 120)}".`,
    },
  );
  if (gateResolution.decision === "rejected") {
    await patchTrack(campaignId, creatorId, "declined", {
      emailsSent: 1,
      threadId,
    });
    return {
      campaignId,
      creatorId,
      terminalState: "shipment_rejected",
      classification,
      threadId,
    };
  }

  // ── 2. runAgent(logistics) → shipment.create ────────────────────────────
  const logisticsOutcome = await step.run("create-shipment", async () =>
    runAgent(
      logisticsAgent,
      {
        brief,
        creatorTrackId,
        creatorId,
        rawAddress,
        products,
      },
      agentCtx,
    ),
  );
  if (logisticsOutcome.kind !== "ok") {
    await patchTrack(campaignId, creatorId, "declined", {
      emailsSent: 1,
      threadId,
    });
    return {
      campaignId,
      creatorId,
      terminalState: "shipment_rejected",
      classification,
      threadId,
      reason: `logistics agent escalated: ${logisticsOutcome.reason}`,
    };
  }
  const shipment: Shipment = logisticsOutcome.value;

  // ── 3. state="shipped"; wait for carrier-side terminal status ──────────
  await patchTrack(campaignId, creatorId, "shipped", {
    emailsSent: 1,
    threadId,
  });

  // Pin the wait to this specific (campaignId, creatorId, shipmentId) tuple
  // AND filter to TERMINAL statuses only (delivered / cancelled / failed /
  // returned). Codex review P3-full P1#2: without the status filter, an
  // in-flight event (in_transit / out_for_delivery) would resolve the wait
  // and the workflow would exit at terminalState='shipped' — missing the
  // eventual 'delivered' that arrives later. The shipment-tracking-poller
  // (P3 codex P1#1 producer) also only emits on status flips, so in
  // practice this filter is belt + suspenders; but the workflow side is
  // the load-bearing guarantee.
  // Use `async.data.X` (the awaited event); `event.data.X` refers to the
  // trigger event and gets pre-evaluated by the SDK at wait-creation time
  // (live-demo lesson 2026-05-14).
  const TERMINAL_STATUS_CLAUSE =
    `(async.data.status == "delivered" || async.data.status == "cancelled" || ` +
    `async.data.status == "failed" || async.data.status == "returned")`;
  const trackingEvent = await step.waitForEvent<ShipmentTrackingData>(
    `await-shipment:${campaignId}:${creatorId}`,
    {
      event: Events.ShipmentTrackingUpdated,
      timeout: SHIPMENT_TIMEOUT,
      if:
        `async.data.campaignId == "${campaignId}" && ` +
        `async.data.creatorId == "${creatorId}" && ` +
        `async.data.shipmentId == "${shipment.id}" && ` +
        TERMINAL_STATUS_CLAUSE,
    },
  );
  if (!trackingEvent) {
    // No TERMINAL carrier update in 14d. The shipment row may have advanced
    // through in_transit etc. (the carrier-poller is updating v2_shipments
    // every 12h independently); the workflow just never observed a
    // terminal flip. Surface for human review via MC's shipment view.
    return {
      campaignId,
      creatorId,
      terminalState: "shipped",
      classification,
      threadId,
      shipmentId: shipment.id,
      reason: `no terminal carrier status within ${SHIPMENT_TIMEOUT}`,
    };
  }
  // Defensive: belt + suspenders. The `if` expression already filters to
  // terminal statuses, but if Inngest's filter parser diverges or a test
  // injects a non-terminal event, refuse to advance prematurely.
  if (!isTerminalShipmentStatus(trackingEvent.data.status)) {
    return {
      campaignId,
      creatorId,
      terminalState: "shipped",
      classification,
      threadId,
      shipmentId: shipment.id,
      reason: `non-terminal status='${trackingEvent.data.status}' slipped past the if-filter — investigate`,
    };
  }

  if (trackingEvent.data.status === "delivered") {
    await patchTrack(campaignId, creatorId, "delivered", {
      emailsSent: 1,
      threadId,
    });
    // Fall through to content-review leg below.
  } else {
    // cancelled / failed / returned — all carrier-side terminal failures.
    // The workflow exits as 'shipment_failed' and MC's shipment view
    // surfaces the row for operator triage (manual re-ship via new track).
    await patchTrack(campaignId, creatorId, "declined", {
      emailsSent: 1,
      threadId,
    });
    return {
      campaignId,
      creatorId,
      terminalState: "shipment_failed",
      classification,
      threadId,
      shipmentId: shipment.id,
      reason: `carrier final status='${trackingEvent.data.status}'`,
    };
  }

  // ── 4. content_review wait + verify ─────────────────────────────────────
  // `async.data.X` for awaited-event fields (live-demo lesson 2026-05-14).
  const postEvent = await step.waitForEvent<PostDetectedData>(
    `await-post:${campaignId}:${creatorId}`,
    {
      event: Events.TikTokPostDetected,
      timeout: CONTENT_TIMEOUT,
      if: `async.data.campaignId == "${campaignId}" && async.data.creatorId == "${creatorId}"`,
    },
  );
  if (!postEvent) {
    await patchTrack(campaignId, creatorId, "flaked", {
      emailsSent: 1,
      threadId,
    });
    return {
      campaignId,
      creatorId,
      terminalState: "flaked",
      classification,
      threadId,
      shipmentId: shipment.id,
      reason: `no post detected within ${CONTENT_TIMEOUT}`,
    };
  }

  const verifyOutcome = await step.run("verify-content", async () =>
    runAgent(
      contentVerifyAgent,
      {
        brief,
        post: {
          postId: postEvent.data.postId,
          desc: postEvent.data.desc,
          hashtags: postEvent.data.hashtags,
          views: postEvent.data.views,
          likes: postEvent.data.likes,
          comments: postEvent.data.comments,
          shares: postEvent.data.shares,
          createdAt: postEvent.data.createdAt,
          matchedHashtags: postEvent.data.matchedHashtags,
        },
        // Real baseline (#29 P0-B): the creator's own typical reach, so the
        // verify agent scores "campaign post vs their norm" instead of vs 0.
        // Falls back to 0 only when recentPosts is genuinely empty.
        baselineAvgViews: avgViewsOf(recentPosts),
        competitorNames: [], // brief has no competitor field yet — keep []; no false "competitor mention" claims.
      },
      agentCtx,
    ),
  );
  if (verifyOutcome.kind !== "ok") {
    await patchTrack(campaignId, creatorId, "flaked", {
      emailsSent: 1,
      threadId,
    });
    return {
      campaignId,
      creatorId,
      terminalState: "flaked",
      classification,
      threadId,
      shipmentId: shipment.id,
      postId: postEvent.data.postId,
      reason: `content-verify escalated: ${verifyOutcome.reason}`,
    };
  }
  const verdict = verifyOutcome.value;
  // Snapshot the verdict + engagement on the track so /campaigns/[id]/posts
  // can render it without re-reading the trace. Phase-3 content view depends
  // on this; Phase-4 analyst will compose it with ranking.score.
  const contentSnapshot = {
    postId: postEvent.data.postId,
    matches: verdict.matches,
    mentionsBrand: verdict.mentionsBrand,
    performanceScore: verdict.performanceScore,
    flags: verdict.flags,
    views: postEvent.data.views,
    likes: postEvent.data.likes,
    comments: postEvent.data.comments,
    shares: postEvent.data.shares,
    detectedAt: postEvent.data.createdAt,
  };

  if (verdict.matches) {
    await patchTrack(campaignId, creatorId, "verified", {
      emailsSent: 1,
      threadId,
      content: contentSnapshot,
    });
    return {
      campaignId,
      creatorId,
      terminalState: "verified",
      classification,
      threadId,
      shipmentId: shipment.id,
      postId: postEvent.data.postId,
      contentVerdict: verdict,
    };
  }

  // matches=false → flaked (with rationale + snapshot for MC review)
  await patchTrack(campaignId, creatorId, "flaked", {
    emailsSent: 1,
    threadId,
    content: contentSnapshot,
  });
  return {
    campaignId,
    creatorId,
    terminalState: "flaked",
    classification,
    threadId,
    shipmentId: shipment.id,
    postId: postEvent.data.postId,
    contentVerdict: verdict,
    reason: verdict.rationale,
  };
}

export const creatorTrack = inngest.createFunction(
  { id: "creator-track", cancelOn: [{ event: Events.CampaignCancelled, match: "data.campaignId" }] },
  { event: Events.CreatorTrackStart },
  ({ event, step }) => creatorTrackHandler({ event, step: step as unknown as StepLike }),
);
