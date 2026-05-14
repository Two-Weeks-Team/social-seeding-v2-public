import {
  Events,
  type ConversationTurn,
  type Lead,
  type LeadCampaignBrief,
  type OutreachDraft,
} from "@ss/contracts";
import { leadRepo, workspaceRepo } from "@ss/db";
import {
  invokeCapability,
  type GmailClientFactory,
} from "@ss/capabilities";
import {
  conversationAgent,
  conversationResponderAgent,
  leadOutreachWriterAgent,
  runAgent,
  type AgentRunContext,
  type ModelClient,
} from "@ss/agents";
import { startTrace } from "@ss/observability";
import { gate, type StepLike } from "../gate";
import type { GateConfig } from "@ss/contracts";
import { inngest } from "../client";

/**
 * lead-track — Phase 5 P5-C3 child workflow. One per researched lead.
 * Mirrors creator-track's outreach + reply loop but B2B-flavored: no
 * shipping leg, no content-review leg, no per-track sample policy.
 *
 * Pipeline:
 *   1. plan + writer       — load policy; runAgent(leadOutreachWriterAgent)
 *                            with the lead + research + brief
 *   2. gate(approveOutreachSend)  — Phase-2 gate reused (same policy
 *                                   knob: spamScoreGte / followerCountGte
 *                                   doesn't apply for B2B; spam-score
 *                                   still does)
 *   3. gmail.send          — idempotencyKey scoped to (leadCampaignId,
 *                            leadId, "outreach"). Outbox tracks delivery.
 *   4. waitForEvent(reply) — 3-day timeout (same as creator-track). If
 *                            timeout: state = 'no_response'.
 *   5. classify            — runAgent(conversationAgent)
 *   6. branch:
 *        · interested / needs_info → runAgent(conversationResponderAgent)
 *          → gate(approveReplyResponse) → gmail.send the response →
 *          state = 'in_conversation'
 *        · negotiating → always_ask gate (Phase 2 P2#7 fix carries over)
 *        · declined / unsubscribe → state = 'declined'; suppression.add
 *          when unsubscribe
 *        · not_now / out_of_office / unrelated → state = 'no_response'
 */

export interface LeadTrackDeps {
  modelClient?: ModelClient;
  gmailClientFactory?: GmailClientFactory;
  /**
   * Required by gmail.send for the unsubscribe + tracking-pixel URLs.
   * Falls back to PUBLIC_APP_URL env var, then localhost for tests.
   */
  publicBaseUrl?: string;
}

function resolvePublicBaseUrl(deps: LeadTrackDeps): string {
  return deps.publicBaseUrl ?? process.env.PUBLIC_APP_URL ?? "http://localhost:3000";
}

export interface LeadTrackArgs {
  event: {
    data: {
      leadCampaignId: string;
      workspaceId: string;
      brief: LeadCampaignBrief;
      lead: Lead;
    };
  };
  step: StepLike;
}

export type LeadTrackResult = {
  leadCampaignId: string;
  leadId: string;
  terminalState: Lead["stage"];
  threadId?: string;
  reason?: string;
  classification?: ConversationTurn["classification"];
};

/** Same alias the gate config uses. */
type GateMap = Record<string, GateConfig>;

function gateConfigFor(map: GateMap, name: string): GateConfig {
  return map[name] ?? { mode: "always_ask" };
}

const REPLY_TIMEOUT = "3d";

export async function leadTrackHandler(
  { event, step }: LeadTrackArgs,
  deps: LeadTrackDeps = {},
): Promise<LeadTrackResult> {
  const { leadCampaignId, workspaceId, brief, lead } = event.data;
  const leadId = lead.id;

  // No contact email → can't outreach. Terminal `no_email`-equivalent.
  if (!lead.contactEmail) {
    await leadRepo.patchStage(leadId, "flaked", { notes: "no_contact_email" });
    return { leadCampaignId, leadId, terminalState: "flaked", reason: "no_contact_email" };
  }
  // No research → workflow contract violated. Caller should not have
  // fanned out. Treat as fatal but resilient.
  if (!lead.research) {
    await leadRepo.patchStage(leadId, "flaked", { notes: "no_research" });
    return { leadCampaignId, leadId, terminalState: "flaked", reason: "no_research_on_lead" };
  }

  // Load policy. The brand-side gates (approveOutreachSend, etc.) apply
  // to lead-campaigns too — same workspace, same autonomy posture.
  const policy = await step.run("plan", async () => workspaceRepo.getPolicy(workspaceId));
  const trace = startTrace(leadCampaignId);
  const agentCtx: AgentRunContext = {
    capabilityCtx: { workspaceId, userId: brief.createdBy, campaignId: leadCampaignId, rateLimitClass: "default" },
    trace,
    campaignBudgetUsd: policy.budgets.maxUsdPerCampaign,
    ...(deps.modelClient ? { model: deps.modelClient } : {}),
  };

  // ── 1. writer ─────────────────────────────────────────────────────────────
  const draftOutcome = await step.run("draft-outreach", async () =>
    runAgent(
      leadOutreachWriterAgent,
      {
        brief,
        research: lead.research!,
        lead: {
          companyName: lead.companyName,
          ...(lead.companyNameEn ? { companyNameEn: lead.companyNameEn } : {}),
          country: lead.country,
          ...(lead.homepageUrl ? { homepageUrl: lead.homepageUrl } : {}),
          contactEmail: lead.contactEmail,
        },
        signatureBlock: policy.voice.signatureBlock,
        bannedPhrases: policy.voice.bannedPhrases,
      },
      agentCtx,
    ),
  );
  if (draftOutcome.kind !== "ok") {
    await leadRepo.patchStage(leadId, "flaked", { notes: `writer_escalated: ${draftOutcome.reason}` });
    return { leadCampaignId, leadId, terminalState: "flaked", reason: `writer_escalated: ${draftOutcome.reason}` };
  }
  const draft: OutreachDraft = draftOutcome.value;

  // ── 2. gate(approveOutreachSend) ─────────────────────────────────────────
  const gateResolution = await gate(
    step,
    gateConfigFor(policy.gates as unknown as Record<string, GateConfig>, "approveOutreachSend"),
    {
      campaignId: leadCampaignId,
      workspaceId,
      kind: "outreach_send",
      recommendation: draft,
      rationale: `Cold-sales outreach to ${lead.companyName} (${lead.contactEmail}). Spam score: ${draft.spamScore}.`,
    },
  );
  if (gateResolution.decision === "rejected") {
    await leadRepo.patchStage(leadId, "declined", { notes: "outreach_rejected_by_human" });
    return { leadCampaignId, leadId, terminalState: "declined", reason: "outreach_gate_rejected" };
  }
  const approvedDraft = gateResolution.payload;

  // ── 3. gmail.send ────────────────────────────────────────────────────────
  // P5 codex review P1#1: gmail.send's input schema requires
  // `creatorTrackId` + `publicBaseUrl` (it uses both to compose the
  // unsubscribe + tracking-pixel URLs). The creatorTrackId slot is the
  // outbox dedupe key; for B2B leads we use `${leadCampaignId}:${leadId}`
  // to mirror the brand-side `${campaignId}:${creatorId}` shape and
  // avoid collisions across campaign types.
  const publicBaseUrl = resolvePublicBaseUrl(deps);
  const creatorTrackId = `${leadCampaignId}:${leadId}`;
  const sendResult = (await step.run("send-outreach", async () =>
    invokeCapability(
      "gmail.send",
      {
        to: lead.contactEmail!,
        subject: approvedDraft.subject,
        bodyHtml: approvedDraft.body,
        creatorTrackId,
        idempotencyKey: `${creatorTrackId}:outreach`,
        publicBaseUrl,
      },
      // ctx carries campaignId — gmail.send writes it to v2_outbox so
      // the Pub/Sub webhook can resolve a thread back to (campaign,
      // creator/lead) at reply time.
      { ...agentCtx.capabilityCtx, campaignId: leadCampaignId },
    ),
  )) as { messageId: string; threadId: string; scheduled: boolean; spamScore: number };
  await leadRepo.patchStage(leadId, "outreach_sent", { threadId: sendResult.threadId });

  // ── 4. wait for reply (3d) ───────────────────────────────────────────────
  const reply = await step.waitForEvent<{
    campaignId: string;
    creatorId: string;
    threadId: string;
    fromEmail: string;
    subject: string;
    bodyText: string;
  }>(`await-reply:${leadCampaignId}:${leadId}`, {
    event: Events.GmailReplyReceived,
    timeout: REPLY_TIMEOUT,
    if:
      `event.data.campaignId == "${leadCampaignId}" && ` +
      `event.data.creatorId == "${leadId}" && ` +
      `event.data.threadId == "${sendResult.threadId}"`,
  });
  if (!reply) {
    await leadRepo.patchStage(leadId, "no_response", { notes: "3d_timeout" });
    return { leadCampaignId, leadId, terminalState: "no_response", threadId: sendResult.threadId };
  }

  // ── 5. classify ──────────────────────────────────────────────────────────
  const classifyOutcome = await step.run("classify-reply", async () =>
    runAgent(
      conversationAgent,
      {
        threadId: sendResult.threadId,
        creatorId: leadId,
        incomingMessage: {
          messageId: `${leadId}:${reply.data.fromEmail}:${Date.now()}`,
          fromEmail: reply.data.fromEmail,
          subject: reply.data.subject,
          bodyText: reply.data.bodyText,
        },
        threadHistory: [
          { role: "us" as const, subject: approvedDraft.subject, bodyText: approvedDraft.body },
        ],
        creatorHandle: lead.companyName,
      },
      agentCtx,
    ),
  );
  if (classifyOutcome.kind !== "ok") {
    await leadRepo.patchStage(leadId, "flaked", { notes: `classifier_escalated: ${classifyOutcome.reason}` });
    return { leadCampaignId, leadId, terminalState: "flaked", reason: `classifier_escalated: ${classifyOutcome.reason}` };
  }
  const turn: ConversationTurn = classifyOutcome.value;

  // ── 6. branch on classification ──────────────────────────────────────────
  switch (turn.classification) {
    case "declined":
    case "unsubscribe": {
      // Suppression for unsubscribe — same path as creator-track.
      if (turn.classification === "unsubscribe") {
        await step.run("suppression-from-reply", async () =>
          invokeCapability(
            "suppression.add",
            { workspaceId, email: reply.data.fromEmail, reason: "unsubscribed", source: "reply" },
            agentCtx.capabilityCtx,
          ),
        );
      }
      await leadRepo.patchStage(leadId, "declined", { threadId: sendResult.threadId });
      return {
        leadCampaignId, leadId, terminalState: "declined",
        threadId: sendResult.threadId, classification: turn.classification,
      };
    }
    case "not_now":
    case "out_of_office":
    case "unrelated": {
      await leadRepo.patchStage(leadId, "no_response", { threadId: sendResult.threadId });
      return {
        leadCampaignId, leadId, terminalState: "no_response",
        threadId: sendResult.threadId, classification: turn.classification,
      };
    }
    case "negotiating": {
      // Always escalate — sales negotiation goes through a human.
      // Same posture as creator-track for `negotiating`.
      await step.run("escalate-negotiating", async () =>
        gate(step, { mode: "always_ask" }, {
          campaignId: leadCampaignId, workspaceId, kind: "reply_response",
          recommendation: turn,
          rationale:
            turn.needsHumanReason ??
            `Lead counter-offered or is asking for non-standard terms. Sales negotiation always escalates.`,
        }),
      );
      await leadRepo.patchStage(leadId, "in_conversation", { threadId: sendResult.threadId });
      return {
        leadCampaignId, leadId, terminalState: "in_conversation",
        threadId: sendResult.threadId, classification: "negotiating",
      };
    }
    case "interested":
    case "needs_info": {
      // Draft a response via the Phase-2 responder agent, run through
      // the reply gate, send. Mirrors creator-track's needs_info path.
      const responderOutcome = await step.run("draft-response", async () =>
        runAgent(
          conversationResponderAgent,
          {
            turn,
            // Synthesize an OutreachFacts shaped for the lead. The
            // responder's prompt reads `brand` + (lightly) `creator`;
            // for B2B the "creator" slot is the lead company.
            facts: {
              creator: {
                uniqueId: lead.companyName,
                nickname: lead.companyName,
                signature: lead.research?.pitch ?? "",
                topHashtags: [],
                recentPostThemes: [],
                followerCount: 0,
              },
              brand: {
                name: brief.ourProduct.name,
                category: "B2B SaaS",
                description: brief.ourProduct.pitchSummary,
                keyClaims: brief.ourProduct.keyClaims,
              },
              logistics: { shipsSamples: false },
              hasMinimumContext: true,
            },
            threadHistory: [
              { role: "us" as const, subject: approvedDraft.subject, bodyText: approvedDraft.body },
              { role: "them" as const, subject: reply.data.subject, bodyText: reply.data.bodyText },
            ],
            voiceNotes: brief.outreach.toneNotes,
            signatureBlock: policy.voice.signatureBlock,
            bannedPhrases: policy.voice.bannedPhrases,
          },
          agentCtx,
        ),
      );
      if (responderOutcome.kind !== "ok") {
        await leadRepo.patchStage(leadId, "in_conversation", {
          threadId: sendResult.threadId, notes: `responder_escalated: ${responderOutcome.reason}`,
        });
        return {
          leadCampaignId, leadId, terminalState: "in_conversation",
          threadId: sendResult.threadId, classification: turn.classification,
          reason: `responder_escalated: ${responderOutcome.reason}`,
        };
      }
      const responder = responderOutcome.value;
      const replyGate = await gate(
        step,
        gateConfigFor(policy.gates as unknown as Record<string, GateConfig>, "approveReplyResponse"),
        {
          campaignId: leadCampaignId, workspaceId, kind: "reply_response",
          recommendation: responder,
          rationale: `Drafted response to lead's ${turn.classification} reply. Deliverability self-check: ${(responder.deliverabilityScore ?? 0).toFixed(2)}.`,
        },
      );
      if (replyGate.decision !== "rejected") {
        const approved = replyGate.payload;
        await step.run("send-reply", async () =>
          invokeCapability(
            "gmail.send",
            {
              to: reply.data.fromEmail,
              subject: approved.subject,
              bodyHtml: approved.body,
              threadId: sendResult.threadId,
              creatorTrackId,
              idempotencyKey: `${creatorTrackId}:reply:${reply.data.fromEmail}`,
              publicBaseUrl,
            },
            { ...agentCtx.capabilityCtx, campaignId: leadCampaignId },
          ),
        );
      }
      // Mark as 'agreed' on `interested`; 'in_conversation' for `needs_info`.
      const newStage: Lead["stage"] = turn.classification === "interested" ? "agreed" : "in_conversation";
      await leadRepo.patchStage(leadId, newStage, { threadId: sendResult.threadId });
      return {
        leadCampaignId, leadId, terminalState: newStage,
        threadId: sendResult.threadId, classification: turn.classification,
      };
    }
  }
  // Exhaustiveness — TS narrows the cases above.
  const _exhaust: never = turn.classification;
  void _exhaust;
  await leadRepo.patchStage(leadId, "in_conversation", { threadId: sendResult.threadId });
  return { leadCampaignId, leadId, terminalState: "in_conversation", threadId: sendResult.threadId };
}

export const leadTrack = inngest.createFunction(
  { id: "lead-track", cancelOn: [{ event: Events.CampaignCancelled, match: "data.campaignId" }] },
  { event: Events.LeadTrackStart },
  ({ event, step }) =>
    leadTrackHandler({
      event: { data: event.data as LeadTrackArgs["event"]["data"] },
      step: step as unknown as StepLike,
    }),
);
