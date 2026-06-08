import { z } from "zod";
import {
  AnalyticsReportSchema,
  type AnalyticsReport,
  type CreatorTrack,
  type Funnel,
  type ReportFlag,
} from "@ss/contracts";
import { campaignRepo } from "@ss/db";
import { getObservabilitySink } from "@ss/observability";
import { defineCapability } from "../registry";

/**
 * analytics.compile — Phase 4 P4-C1. Pure aggregation: given a campaignId,
 * read v2_campaigns + v2_cost_ledger and return an AnalyticsReport for the
 * MC report view (P4-C5) + the analyst agent (P4-C2) to consume.
 *
 * Design choices:
 *  · No I/O the cost sink doesn't already abstract — keeps testability via
 *    `setObservabilitySink(memorySink())`. Same pattern every other
 *    capability uses (gmail.send → GmailClient seam etc).
 *  · No LLM. Anything narrative ("why did X happen?") belongs to the
 *    analyst agent, not this capability. The flags array is a
 *    deterministic precomputation so the agent can lean on the same
 *    signals the human sees.
 *  · `asOf` defaults to "now" so callers re-running the same compile get
 *    stable funnel + cost, but a different `daysToDeadline` /
 *    `generatedAt`. Lets the MC view + the analyst agent share one
 *    invocation per report.
 *
 * Scope = "read". Idempotent (no side effects). Rate-limit class = default.
 */
export const analyticsCompile = defineCapability({
  name: "analytics.compile",
  description:
    "Compile a campaign's outcome rollup (funnel, goals, reach, performance, cost, flags) from v2_campaigns + v2_cost_ledger. Pure read aggregation; no LLM. Returns an AnalyticsReport that the analyst agent + MC report view both consume.",
  scope: "read",
  idempotent: true,
  rateLimitClass: "default",
  input: z.object({
    campaignId: z.string().min(1),
    asOf: z.coerce.date().optional(),
  }),
  output: AnalyticsReportSchema,
  async handler({ campaignId, asOf }, ctx): Promise<AnalyticsReport> {
    const campaign = await campaignRepo.get(campaignId);
    if (!campaign) throw new Error(`analytics.compile: no campaign with id=${campaignId}`);
    if (campaign.brief.workspaceId !== ctx.workspaceId)
      throw new Error(`analytics.compile: campaign ${campaignId} is not in workspace ${ctx.workspaceId}`);

    const generatedAt = asOf ?? new Date();
    const spentUsd = await getObservabilitySink().sumCampaignUsd(campaignId);

    const funnel = funnelOf(campaign.tracks);
    const verifiedTracks = campaign.tracks.filter((t) => t.state === "verified" && t.content);
    const verifiedCount = verifiedTracks.length;

    const targetLivePosts = campaign.brief.goals.targetLivePosts;
    const percentOfGoal = targetLivePosts > 0 ? verifiedCount / targetLivePosts : null;
    const daysToDeadline = Math.floor(
      (campaign.brief.goals.deadline.getTime() - generatedAt.getTime()) / (1000 * 60 * 60 * 24),
    );
    const goalMet = verifiedCount >= targetLivePosts;

    const reach = reachOf(verifiedTracks);
    const performance = performanceOf(verifiedTracks);

    const budgetUsd = campaign.brief.goals.budgetUsd ?? null;
    const percentOfBudget = budgetUsd && budgetUsd > 0 ? spentUsd / budgetUsd : null;
    const costPerVerifiedPost = verifiedCount > 0 ? spentUsd / verifiedCount : null;

    const tracks = campaign.tracks.map((t) => ({
      creatorId: t.creatorId,
      state: t.state,
      lastActivityAt: t.lastActivityAt,
      threadId: t.threadId ?? null,
      performanceScore: t.content?.performanceScore ?? null,
      views: t.content?.views ?? null,
    }));

    const flags = flagsOf({
      funnel,
      verifiedCount,
      targetLivePosts,
      daysToDeadline,
      goalMet,
      percentOfBudget,
      totalTracks: campaign.tracks.length,
    });

    return AnalyticsReportSchema.parse({
      campaignId,
      brief: {
        name: campaign.brief.brandProduct.name,
        category: campaign.brief.brandProduct.category,
        deadline: campaign.brief.goals.deadline,
      },
      funnel,
      goals: { targetLivePosts, verifiedCount, percentOfGoal, daysToDeadline, goalMet },
      reach,
      performance,
      cost: { spentUsd, costPerVerifiedPost, budgetUsd, percentOfBudget },
      tracks,
      flags,
      generatedAt,
    });
  },
});

/** Group tracks by `state` into the contract's funnel buckets. */
export function funnelOf(tracks: ReadonlyArray<CreatorTrack>): Funnel {
  const f: Funnel = {
    candidate: 0, shortlisted: 0, outreach_sent: 0, in_conversation: 0,
    agreed: 0, address_collected: 0, shipped: 0, delivered: 0,
    posted: 0, verified: 0, declined: 0, no_response: 0, flaked: 0,
  };
  for (const t of tracks) {
    // The state enum is the same set as the funnel keys — index-safe.
    (f as Record<string, number>)[t.state] = ((f as Record<string, number>)[t.state] ?? 0) + 1;
  }
  return f;
}

/** Sum verified-track engagement; weighted ER = (likes+comments+shares) / views. */
export function reachOf(
  verifiedTracks: ReadonlyArray<CreatorTrack>,
): AnalyticsReport["reach"] {
  let v = 0, l = 0, c = 0, s = 0;
  for (const t of verifiedTracks) {
    if (!t.content) continue;
    v += t.content.views;
    l += t.content.likes;
    c += t.content.comments;
    s += t.content.shares;
  }
  const weighted = v > 0 ? Math.min(1, (l + c + s) / v) : null;
  return {
    verifiedViews: v,
    verifiedLikes: l,
    verifiedComments: c,
    verifiedShares: s,
    weightedEngagementRate: weighted,
  };
}

/** Mean + median performance score across verified tracks; top performer. */
export function performanceOf(
  verifiedTracks: ReadonlyArray<CreatorTrack>,
): AnalyticsReport["performance"] {
  const scored = verifiedTracks.filter((t) => t.content).map((t) => ({
    creatorId: t.creatorId,
    score: t.content!.performanceScore,
  }));
  if (scored.length === 0) {
    return { avgPerformanceScore: null, medianPerformanceScore: null, topPerformerCreatorId: null };
  }
  const sorted = [...scored].sort((a, b) => a.score - b.score);
  const sum = sorted.reduce((acc, x) => acc + x.score, 0);
  const avg = sum / sorted.length;
  const mid = sorted.length >>> 1;
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1]!.score + sorted[mid]!.score) / 2
    : sorted[mid]!.score;
  const top = sorted[sorted.length - 1]!;
  return {
    avgPerformanceScore: Math.round(avg * 10) / 10,
    medianPerformanceScore: Math.round(median * 10) / 10,
    topPerformerCreatorId: top.creatorId,
  };
}

interface FlagsInput {
  funnel: Funnel;
  verifiedCount: number;
  targetLivePosts: number;
  daysToDeadline: number;
  goalMet: boolean;
  percentOfBudget: number | null;
  totalTracks: number;
}

/**
 * Deterministic flag rules — see `ReportFlagSchema` doc for thresholds.
 * Order in the returned array is stable (input-order, not insertion-order).
 */
export function flagsOf(x: FlagsInput): ReportFlag[] {
  const flags: ReportFlag[] = [];
  if (x.goalMet) flags.push("goal_met");
  if (x.percentOfBudget !== null && x.percentOfBudget > 1) flags.push("budget_exceeded");
  if (x.daysToDeadline < 0 && !x.goalMet) flags.push("deadline_missed");

  const replied =
    x.funnel.in_conversation +
    x.funnel.agreed +
    x.funnel.address_collected +
    x.funnel.shipped +
    x.funnel.delivered +
    x.funnel.posted +
    x.funnel.verified +
    x.funnel.declined;
  const contacted = replied + x.funnel.outreach_sent + x.funnel.no_response;
  if (contacted >= 10 && replied / contacted < 0.10) {
    flags.push("low_response_rate");
  }

  const shippedPlus =
    x.funnel.shipped + x.funnel.delivered + x.funnel.posted + x.funnel.verified + x.funnel.flaked;
  if (shippedPlus > 0 && x.funnel.flaked / shippedPlus > 0.30) {
    flags.push("high_flake_rate");
  }

  if (x.totalTracks > 0 && x.verifiedCount === 0) flags.push("no_verified_yet");

  return flags;
}
