/**
 * gate() — the WF2 policy-gate helper. Wraps a checkpoint in the workflow:
 * if the workspace's GateConfig says "auto" (or "auto_unless" without a
 * predicate hit) the gate returns the agent's recommendation immediately;
 * otherwise it creates a v2_approvals row and parks on step.waitForEvent
 * until the human (or another agent) resolves it via apps/web's
 * POST /api/approvals/[id]/resolve (Chunk 4).
 *
 * This is what makes the brand-campaign workflow safe: every external action
 * either has a human in the loop or a policy that explicitly waived it.
 */
import type { GateConfig } from "@ss/contracts";
import { approvalRepo } from "@ss/db";

export type GateDecision = "approved" | "edited" | "rejected";

export interface GateResolution<P> {
  decision: GateDecision;
  payload: P;
}

export type GateKind = "shortlist" | "outreach_send" | "reply_response" | "shipment" | "stage_advance";

export interface GateOpts<P> {
  campaignId: string;
  workspaceId: string;
  kind: GateKind;
  recommendation: P;
  rationale: string;
}

/** Shape of the resolved-approval event payload (subset of Events.ApprovalResolved). */
export interface ApprovalResolvedData {
  approvalId: string;
  campaignId: string;
  decision: GateDecision;
  editedPayload?: unknown;
}

/**
 * Minimal step surface gate() needs. The real Inngest step is structurally
 * assignable to this (Inngest's step has more methods + richer return types).
 *
 * `waitForEvent` is generic so creator-track (which awaits GmailReplyReceived)
 * can reuse the same StepLike as the approvals path. Default `T` keeps the
 * gate() call sites untouched.
 */
export interface StepLike {
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sendEvent(name: string, payload: { name: string; data: unknown } | Array<{ name: string; data: unknown }>): Promise<unknown>;
  waitForEvent<T = ApprovalResolvedData>(
    name: string,
    /** Either `match` or `if` (or both) — Inngest requires at least one. */
    opts: { event: string; timeout: string; match?: string; if?: string },
  ): Promise<{ data: T } | null>;
}

export class ApprovalTimeoutError extends Error {
  constructor(readonly approvalId: string, readonly kind: GateKind) {
    super(`approval ${approvalId} (${kind}) timed out`);
    this.name = "ApprovalTimeoutError";
  }
}

/**
 * Evaluate an auto_unless predicate against a recommendation. Returns true if
 * the human SHOULD be asked (any predicate matched). For array recommendations
 * (e.g. a shortlist of candidates) the predicate is OR'd across elements —
 * any single concerning candidate trips the gate.
 */
export function evaluatePredicate(
  escalateIf: NonNullable<GateConfig["escalateIf"]>,
  recommendation: unknown,
): boolean {
  if (recommendation === null || recommendation === undefined) return false;

  if (Array.isArray(recommendation)) {
    for (const item of recommendation) {
      if (evaluateOne(escalateIf, item)) return true;
    }
    return false;
  }
  return evaluateOne(escalateIf, recommendation);
}

function evaluateOne(escalateIf: NonNullable<GateConfig["escalateIf"]>, rec: unknown): boolean {
  if (!rec || typeof rec !== "object") return false;
  const r = rec as Record<string, unknown> & {
    fitScore?: number;
    followerCount?: number;
    spamScore?: number;
    proposedRateUsd?: number;
    replyClass?: string;
    creator?: { followerCount?: number };
  };

  if (escalateIf.fitScoreLt !== undefined && typeof r.fitScore === "number" && r.fitScore < escalateIf.fitScoreLt) {
    return true;
  }
  // followerCount can be at the top level or nested in `creator` (for candidate-shaped recs)
  const followerCount = typeof r.followerCount === "number" ? r.followerCount : r.creator?.followerCount;
  if (escalateIf.followerCountGte !== undefined && typeof followerCount === "number" && followerCount >= escalateIf.followerCountGte) {
    return true;
  }
  if (escalateIf.spamScoreGte !== undefined && typeof r.spamScore === "number" && r.spamScore >= escalateIf.spamScoreGte) {
    return true;
  }
  if (escalateIf.proposedRateUsdGte !== undefined && typeof r.proposedRateUsd === "number" && r.proposedRateUsd >= escalateIf.proposedRateUsdGte) {
    return true;
  }
  if (escalateIf.replyClassIn !== undefined && typeof r.replyClass === "string" && escalateIf.replyClassIn.includes(r.replyClass)) {
    return true;
  }
  return false;
}

export async function gate<P>(
  step: StepLike,
  gateConfig: GateConfig,
  opts: GateOpts<P>,
): Promise<GateResolution<P>> {
  // ── fast paths: policy says "auto" (or "auto_unless" without escalation) ──
  if (gateConfig.mode === "auto") {
    return { decision: "approved", payload: opts.recommendation };
  }
  if (gateConfig.mode === "auto_unless") {
    const shouldEscalate = gateConfig.escalateIf
      ? evaluatePredicate(gateConfig.escalateIf, opts.recommendation)
      : false;
    if (!shouldEscalate) return { decision: "approved", payload: opts.recommendation };
  }

  // ── always_ask, or auto_unless with predicate hit: create approval, wait ──
  const approvalId = await step.run(`approval:create:${opts.kind}`, async () => {
    const a = await approvalRepo.create({
      workspaceId: opts.workspaceId,
      campaignId: opts.campaignId,
      kind: opts.kind,
      recommendation: opts.recommendation as unknown,
      rationale: opts.rationale,
    });
    return a.id;
  });

  await step.sendEvent(`approval-inbox:${opts.kind}`, {
    name: "approval/created",
    data: { approvalId, campaignId: opts.campaignId, workspaceId: opts.workspaceId, kind: opts.kind },
  });

  // Use an `if` expression instead of `match: "data.approvalId"` — the
  // trigger event (e.g. CreatorTrackStart, CampaignSubmitted) has no
  // `data.approvalId`, so Inngest's match semantics compare undefined →
  // never satisfied. Live-demo lesson 2026-05-14 (same root cause as
  // P2 codex P1#2 for creator-track's reply wait).
  //
  // CRITICAL: in waitForEvent.if, `event` = the TRIGGER event (pre-
  // evaluated by the SDK before storing the expression!) and `async` =
  // the incoming awaited event. Using `event.data.approvalId` makes the
  // SDK substitute null at wait-creation time, producing a literal
  // `null == "<id>"` stored expression that never matches. Always use
  // `async.data.X` for fields from the awaited event.
  // (Live-demo lesson 2026-05-14, second iteration.)
  const resolved = await step.waitForEvent(`await-approval:${approvalId}`, {
    event: "approval/resolved",
    if: `async.data.approvalId == "${approvalId}"`,
    timeout: "7d",
  });

  if (!resolved) throw new ApprovalTimeoutError(approvalId, opts.kind);

  return {
    decision: resolved.data.decision,
    payload: (resolved.data.editedPayload ?? opts.recommendation) as P,
  };
}
