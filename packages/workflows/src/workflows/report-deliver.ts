import { randomBytes } from "node:crypto";
import {
  AnalyticsReportSchema,
  Events,
  type AnalyticsReport,
  type Report,
  type ReportTrigger,
} from "@ss/contracts";
import { campaignRepo, reportRepo } from "@ss/db";
import { invokeCapability } from "@ss/capabilities";
import {
  analystAgent,
  runAgent,
  type AgentRunContext,
  type ModelClient,
} from "@ss/agents";
import { startTrace } from "@ss/observability";
import { inngest } from "../client";
import type { StepLike } from "../gate";

/**
 * report-deliver — Phase 4 P4-C3 workflow. Triggered by
 * `report/deliver.request` (cron, brand-campaign stage transition, or MC
 * manual). Pipeline:
 *
 *   1. load-campaign       — campaignRepo.get; bail if missing
 *   2. compile-analytics   — invokeCapability("analytics.compile")
 *   3. analyst-narrative   — runAgent(analystAgent); escalate clean if it bails
 *   4. persist-report      — reportRepo.create (newest-first via index)
 *   5. emit                — report/delivered with the headline numbers
 *
 * Append-only: re-running on the same campaign produces a fresh row (audit
 * trail), it does NOT mutate the previous one. The MC report view picks up
 * `latestForCampaign`; the report timeline scrolls history.
 *
 * shareToken: a 24-byte random URL-safe string stored on the row. P4-C5's
 * `/share/[id]?t=<token>` will compare against this for the public preview.
 * Random (not HMAC-signed) is deliberate — the constant-time-compare
 * happens server-side; rotation is a delete + regenerate, no key rollover.
 */

export interface ReportDeliverDeps {
  /** Injected by tests; default = Anthropic-backed defaultModelClient (analyst agent). */
  modelClient?: ModelClient;
  /**
   * Optional override of the random-share-token generator. Tests pin it for
   * deterministic output assertions.
   */
  generateShareToken?: () => string;
}

export interface ReportDeliverArgs {
  event: {
    data: {
      campaignId: string;
      trigger: ReportTrigger;
      asOf?: Date;
      notes?: string;
    };
  };
  step: StepLike;
}

export type ReportDeliverResult =
  | {
      kind: "delivered";
      campaignId: string;
      reportId: string;
      analytics: AnalyticsReport;
    }
  | { kind: "missing_campaign"; campaignId: string };

/**
 * P4 codex review P2#3 — analyst-escalation now throws so Inngest's
 * built-in retry/backoff kicks in. Codifying the failure shape (vs a
 * silent "returned analyst_escalated") so campaign-progression doesn't
 * leave a stage='performance' campaign stuck at status='running' forever
 * when the analyst can't narrate the data.
 */
export class AnalystEscalatedError extends Error {
  constructor(readonly campaignId: string, readonly originalReason: string) {
    super(`analyst escalated for campaign ${campaignId}: ${originalReason}`);
    this.name = "AnalystEscalatedError";
  }
}

function defaultShareToken(): string {
  return randomBytes(24).toString("base64url");
}

export async function reportDeliverHandler(
  { event, step }: ReportDeliverArgs,
  deps: ReportDeliverDeps = {},
): Promise<ReportDeliverResult> {
  const { campaignId, trigger } = event.data;
  const asOf = event.data.asOf;
  const notes = event.data.notes ?? "";

  // ── 1. Load campaign for workspaceId + brief (analyst input) ──────────────
  const campaign = await step.run("load-campaign", async () => {
    return campaignRepo.get(campaignId);
  });
  if (!campaign) return { kind: "missing_campaign", campaignId };

  const workspaceId = campaign.brief.workspaceId;
  const trace = startTrace(campaignId);
  const agentCtx: AgentRunContext = {
    capabilityCtx: {
      workspaceId,
      userId: campaign.brief.createdBy,
      campaignId,
      rateLimitClass: "default",
    },
    trace,
    ...(deps.modelClient ? { model: deps.modelClient } : {}),
  };

  // ── 2. Compile analytics ──────────────────────────────────────────────────
  const analytics = (await step.run("compile-analytics", async () =>
    invokeCapability(
      "analytics.compile",
      { campaignId, ...(asOf ? { asOf } : {}) },
      agentCtx.capabilityCtx,
    ),
  )) as AnalyticsReport;

  // Defense in depth: the capability's output is Zod-validated at the
  // boundary, but the workflow is the consumer that decides "fit to ship."
  // If a future change breaks the shape, we fail here loudly, before the
  // analyst agent gets bad data.
  const parsed = AnalyticsReportSchema.safeParse(analytics);
  if (!parsed.success) {
    throw new Error(
      `report-deliver: analytics.compile returned a shape that doesn't match AnalyticsReportSchema — ${parsed.error.message}`,
    );
  }

  // ── 3. Analyst narrative ──────────────────────────────────────────────────
  const narrativeOutcome = await step.run("analyst-narrative", async () =>
    runAgent(
      analystAgent,
      {
        brief: campaign.brief,
        report: parsed.data,
        // Phase 4 follow-up: resolve creatorId → @handle via creatorRepo for
        // every verified track so the agent cites by handle. Skipping for
        // C3 keeps the workflow free of TikTok-handle lookups; the agent
        // falls back to creatorId, which is correct but less friendly.
        creatorHandles: {},
      },
      agentCtx,
    ),
  );
  if (narrativeOutcome.kind !== "ok") {
    // P4 codex review P2#3: throw instead of returning a "soft" result.
    // Inngest's default retry policy (3 attempts with exponential backoff)
    // will replay the workflow. Persistent failures dead-letter to the
    // Inngest dashboard so the operator can see + manually re-run via
    // MC's "🔄 새 리포트 생성" button. Without this, campaign-progression
    // sees stage='performance' but no report row, sits there forever.
    throw new AnalystEscalatedError(campaignId, narrativeOutcome.reason);
  }

  // ── 4. Persist report ─────────────────────────────────────────────────────
  const generateShareToken = deps.generateShareToken ?? defaultShareToken;
  const generatedAt = parsed.data.generatedAt;
  const report: Report = await step.run("persist-report", async () =>
    reportRepo.create({
      campaignId,
      workspaceId,
      trigger,
      analytics: parsed.data,
      narrative: narrativeOutcome.value,
      shareToken: generateShareToken(),
      analystCostUsd: narrativeOutcome.usd,
      notes,
      generatedAt,
    }),
  );

  // ── 5. Emit report/delivered ──────────────────────────────────────────────
  await step.sendEvent(`report-delivered:${campaignId}`, {
    name: Events.ReportDelivered,
    data: {
      campaignId,
      workspaceId,
      reportId: report.id,
      trigger,
      verifiedCount: parsed.data.goals.verifiedCount,
      targetLivePosts: parsed.data.goals.targetLivePosts,
      flagsCount: parsed.data.flags.length,
      generatedAt,
    },
  });

  return {
    kind: "delivered",
    campaignId,
    reportId: report.id,
    analytics: parsed.data,
  };
}

/**
 * Inngest function — triggered by `report/deliver.request` (cron / brand-
 * campaign / MC). Concurrency limited per-campaign to avoid two crons
 * racing on a slow analyst call.
 */
export const reportDeliver = inngest.createFunction(
  {
    id: "report-deliver",
    concurrency: { key: "event.data.campaignId", limit: 1 },
  },
  { event: Events.ReportDeliverRequest },
  ({ event, step }) =>
    reportDeliverHandler({
      event: { data: event.data as ReportDeliverArgs["event"]["data"] },
      step: step as unknown as StepLike,
    }),
);
