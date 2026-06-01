/**
 * campaign-autopilot — the single autonomous flow that connects campaign
 * stages 3→6 (outreach → shipping → content_review → performance), the gap
 * brand-campaign leaves open (it exits at `outreach` after creator-track
 * fan-out). Each stage transition runs through the `approveStageAdvance`
 * gate (auto by default), and each externally-consequential stage runs
 * through its required HITL gate:
 *
 *   stage 3 outreach        — approveOutreachSend (auto_unless: spammy draft)
 *     → advance (approveStageAdvance)
 *   stage 4 shipping        — approveShipment   (always_ask; timeout=abandon)
 *     → advance
 *   stage 5 content_review  — approveContent    (always_ask; timeout=auto_proceed)
 *     → advance
 *   stage 6 performance     — analytics.compile → AnalyticsReport
 *
 * A required gate that resolves `rejected` (human said no, or an `abandon`
 * timeout) halts the flow at that stage — the irreversible action never
 * fires. `auto_proceed` timeouts (content_review) carry on with the agent's
 * own evaluation. So the loop is autonomous but never blocked forever and
 * never ships/spends without a cleared (or explicitly waived) gate.
 *
 * Pure handler — production binds a real Inngest step + the analytics.compile
 * capability; tests inject a fake step + an in-memory compile.
 */
import {
  AnalyticsReportSchema,
  CampaignSchema,
  Events,
  WorkspacePolicySchema,
  type AnalyticsReport,
  type Campaign,
  type CampaignStage,
  type CreatorTrack,
  type WorkspacePolicy,
} from "@ss/contracts";
import { campaignRepo, workspaceRepo } from "@ss/db";
import { invokeCapability } from "@ss/capabilities";
import { gate, type GateDecision, type GateKind, type StepLike } from "../gate";
import { inngest } from "../client";

/** The four back-half stages, in order. */
const BACK_HALF: CampaignStage[] = ["outreach", "shipping", "content_review", "performance"];

export interface AutopilotGateEvent {
  stage: CampaignStage;
  kind: GateKind;
  decision: GateDecision;
  timedOut?: boolean;
}

export type AutopilotResult =
  | {
      kind: "completed";
      campaignId: string;
      stagesCompleted: CampaignStage[];
      gateLog: AutopilotGateEvent[];
      report: AnalyticsReport;
    }
  | {
      kind: "halted";
      campaignId: string;
      stagesCompleted: CampaignStage[];
      gateLog: AutopilotGateEvent[];
      haltedAt: CampaignStage;
      reason: string;
    };

export interface AutopilotDeps {
  /** Defaults to invokeCapability("analytics.compile"). Tests inject an in-memory compile. */
  compile?: (campaignId: string, asOf: Date | undefined, workspaceId: string, userId: string) => Promise<AnalyticsReport>;
}

export interface AutopilotArgs {
  /** Campaign already at stage='outreach' with its tracks loaded. */
  campaign: Campaign;
  policy: WorkspacePolicy;
  step: StepLike;
  asOf?: Date;
}

async function defaultCompile(
  campaignId: string,
  asOf: Date | undefined,
  workspaceId: string,
  userId: string,
): Promise<AnalyticsReport> {
  const raw = await invokeCapability(
    "analytics.compile",
    { campaignId, ...(asOf ? { asOf } : {}) },
    { workspaceId, userId, rateLimitClass: "default" },
  );
  return AnalyticsReportSchema.parse(raw);
}

function countByState(tracks: ReadonlyArray<CreatorTrack>, states: ReadonlyArray<CreatorTrack["state"]>): number {
  const set = new Set(states);
  return tracks.filter((t) => set.has(t.state)).length;
}

/**
 * Run one `approveStageAdvance` transition. With the default policy this is
 * `auto` (instant). Returns false if the transition was rejected (the flow
 * should halt).
 */
async function advance(
  step: StepLike,
  policy: WorkspacePolicy,
  campaign: Campaign,
  from: CampaignStage,
  to: CampaignStage,
  gateLog: AutopilotGateEvent[],
): Promise<boolean> {
  const res = await gate(step, policy.gates.approveStageAdvance, {
    campaignId: campaign.id,
    workspaceId: campaign.brief.workspaceId,
    kind: "stage_advance",
    recommendation: { from, to },
    rationale: `advance ${from} → ${to}`,
  });
  gateLog.push({ stage: to, kind: "stage_advance", decision: res.decision, timedOut: res.timedOut });
  if (res.decision === "rejected") return false;
  await step.run(`advance:${from}->${to}`, async () => campaignRepo.patchStage(campaign.id, to));
  return true;
}

export async function campaignAutopilotHandler(
  { campaign, policy, step, asOf }: AutopilotArgs,
  deps: AutopilotDeps = {},
): Promise<AutopilotResult> {
  const compile = deps.compile ?? defaultCompile;
  const gateLog: AutopilotGateEvent[] = [];
  const stagesCompleted: CampaignStage[] = [];
  const { tracks } = campaign;

  // ── budget / contract release (required HITL) — gates ALL downstream spend ──
  // Runs before outreach: nothing external (outreach send, shipment) commits
  // budget until this clears. abandon-timeout halts the whole run (no spend).
  const budgetUsd = campaign.brief.goals.budgetUsd ?? policy.budgets.maxUsdPerCampaign;
  const budget = await gate(step, policy.gates.approveBudget, {
    campaignId: campaign.id,
    workspaceId: campaign.brief.workspaceId,
    kind: "budget",
    recommendation: { budgetUsd, maxUsdPerCampaign: policy.budgets.maxUsdPerCampaign },
    rationale: `release $${budgetUsd} campaign budget before committing outreach/shipping spend`,
  });
  gateLog.push({ stage: "outreach", kind: "budget", decision: budget.decision, timedOut: budget.timedOut });
  if (budget.decision === "rejected") {
    return { kind: "halted", campaignId: campaign.id, stagesCompleted, gateLog, haltedAt: "outreach", reason: budget.timedOut ? "budget timed out (abandon)" : "budget rejected" };
  }

  // ── stage 3: outreach ─────────────────────────────────────────────────
  const contacted = countByState(tracks, [
    "outreach_sent", "in_conversation", "agreed", "address_collected",
    "shipped", "delivered", "posted", "verified",
  ]);
  const outreach = await gate(step, policy.gates.approveOutreachSend, {
    campaignId: campaign.id,
    workspaceId: campaign.brief.workspaceId,
    kind: "outreach_send",
    // spamScore=0 so the default auto_unless predicate (spamScoreGte:5) doesn't escalate.
    recommendation: { batchSize: contacted, spamScore: 0 },
    rationale: `${contacted} creators contacted in the outreach batch`,
  });
  gateLog.push({ stage: "outreach", kind: "outreach_send", decision: outreach.decision, timedOut: outreach.timedOut });
  if (outreach.decision === "rejected") {
    return { kind: "halted", campaignId: campaign.id, stagesCompleted, gateLog, haltedAt: "outreach", reason: "outreach rejected" };
  }
  stagesCompleted.push("outreach");
  if (!(await advance(step, policy, campaign, "outreach", "shipping", gateLog))) {
    return { kind: "halted", campaignId: campaign.id, stagesCompleted, gateLog, haltedAt: "outreach", reason: "stage_advance rejected" };
  }

  // ── stage 4: shipping (required HITL) ─────────────────────────────────
  const toShip = tracks.filter((t) => ["shipped", "delivered", "agreed", "address_collected"].includes(t.state));
  const shipment = await gate(step, policy.gates.approveShipment, {
    campaignId: campaign.id,
    workspaceId: campaign.brief.workspaceId,
    kind: "shipment",
    recommendation: { shipments: toShip.map((t) => ({ creatorId: t.creatorId })) },
    rationale: `${toShip.length} samples queued for shipment`,
  });
  gateLog.push({ stage: "shipping", kind: "shipment", decision: shipment.decision, timedOut: shipment.timedOut });
  if (shipment.decision === "rejected") {
    return { kind: "halted", campaignId: campaign.id, stagesCompleted, gateLog, haltedAt: "shipping", reason: shipment.timedOut ? "shipment timed out (abandon)" : "shipment rejected" };
  }
  stagesCompleted.push("shipping");
  if (!(await advance(step, policy, campaign, "shipping", "content_review", gateLog))) {
    return { kind: "halted", campaignId: campaign.id, stagesCompleted, gateLog, haltedAt: "shipping", reason: "stage_advance rejected" };
  }

  // ── stage 5: content_review (required HITL) ───────────────────────────
  const verifiedPosts = tracks.filter((t) => t.state === "verified" && t.content);
  const content = await gate(step, policy.gates.approveContent, {
    campaignId: campaign.id,
    workspaceId: campaign.brief.workspaceId,
    kind: "content_review",
    recommendation: {
      posts: verifiedPosts.map((t) => ({
        creatorId: t.creatorId,
        postId: t.content?.postId,
        views: t.content?.views ?? 0,
        performanceScore: t.content?.performanceScore ?? 0,
      })),
    },
    rationale: `${verifiedPosts.length} verified posts pending final sign-off`,
  });
  gateLog.push({ stage: "content_review", kind: "content_review", decision: content.decision, timedOut: content.timedOut });
  if (content.decision === "rejected") {
    return { kind: "halted", campaignId: campaign.id, stagesCompleted, gateLog, haltedAt: "content_review", reason: content.timedOut ? "content timed out (abandon)" : "content rejected" };
  }
  stagesCompleted.push("content_review");
  if (!(await advance(step, policy, campaign, "content_review", "performance", gateLog))) {
    return { kind: "halted", campaignId: campaign.id, stagesCompleted, gateLog, haltedAt: "content_review", reason: "stage_advance rejected" };
  }

  // ── stage 6: performance — auto-complete the analysis the human stalled ──
  const report = await step.run("compile-performance", async () =>
    compile(campaign.id, asOf, campaign.brief.workspaceId, campaign.brief.createdBy),
  );
  await step.run("mark-completed", async () => campaignRepo.patchStage(campaign.id, "performance", "completed"));
  stagesCompleted.push("performance");

  return { kind: "completed", campaignId: campaign.id, stagesCompleted, gateLog, report };
}

/** The full ordered set of back-half stages (exported for assertions). */
export const AUTOPILOT_STAGES = BACK_HALF;

/**
 * Production Inngest function. Triggered by `campaign/autopilot.start` once a
 * campaign has its tracks (post creator-track fan-out); loads the campaign +
 * the workspace policy, then runs the autonomous back-half. The pure handler
 * above is what the tests drive directly.
 */
export const campaignAutopilot = inngest.createFunction(
  {
    id: "campaign-autopilot",
    cancelOn: [{ event: Events.CampaignCancelled, match: "data.campaignId" }],
  },
  { event: Events.CampaignAutopilotStart },
  async ({ event, step }) => {
    const s = step as unknown as StepLike;
    const campaignId = (event.data as { campaignId: string }).campaignId;
    // step.run JSON-serializes its return (Date → string); re-parse through the
    // Zod schemas (z.coerce.date) to restore the typed Campaign / WorkspacePolicy.
    const campaignRaw = await step.run("load-campaign", async () => campaignRepo.get(campaignId));
    if (!campaignRaw) throw new Error(`campaign-autopilot: no campaign with id=${campaignId}`);
    const campaign = CampaignSchema.parse(campaignRaw);
    const policyRaw = await step.run("load-policy", async () => workspaceRepo.getPolicy(campaign.brief.workspaceId));
    const policy = WorkspacePolicySchema.parse(policyRaw);
    return campaignAutopilotHandler({ campaign, policy, step: s });
  },
);
