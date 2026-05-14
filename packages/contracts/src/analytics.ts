import { z } from "zod";
import { CreatorTrackSchema } from "./campaign";

/**
 * Analytics report — the compiled, agent-free rollup of one campaign's
 * outcome. Phase 4 P4-C1: pure data shape; computed by
 * `analytics.compile` capability from `v2_campaigns` + `v2_cost_ledger` +
 * `v2_shipments`. The Phase 4 P4-C2 `analyst` agent will consume this to
 * draft the human-readable report; the MC report view (P4-C5) renders it
 * directly.
 *
 * Design rule: no field here requires the LLM. Anything qualitative
 * ("why did this campaign underperform?") lives on the analyst agent's
 * output, not here.
 */

/**
 * Funnel buckets — one count per `CreatorTrack.state`. Stages 1-9 are
 * forward-progressing; the bottom row is the terminal-no-result states.
 * Sum-of-all-buckets == campaign.tracks.length.
 */
export const FunnelSchema = z.object({
  // forward progression (counts are NOT cumulative — each track lives in
  // exactly one bucket determined by its current `state`)
  candidate: z.number().int().nonnegative().default(0),
  shortlisted: z.number().int().nonnegative().default(0),
  outreach_sent: z.number().int().nonnegative().default(0),
  in_conversation: z.number().int().nonnegative().default(0),
  agreed: z.number().int().nonnegative().default(0),
  address_collected: z.number().int().nonnegative().default(0),
  shipped: z.number().int().nonnegative().default(0),
  delivered: z.number().int().nonnegative().default(0),
  posted: z.number().int().nonnegative().default(0),
  verified: z.number().int().nonnegative().default(0),
  // terminal no-result
  declined: z.number().int().nonnegative().default(0),
  no_response: z.number().int().nonnegative().default(0),
  flaked: z.number().int().nonnegative().default(0),
});
export type Funnel = z.infer<typeof FunnelSchema>;

/** Goal-vs-actual block — verified-post count is the only "outcome" metric. */
export const GoalsSchema = z.object({
  targetLivePosts: z.number().int().positive(),
  verifiedCount: z.number().int().nonnegative(),
  /**
   * `verifiedCount / targetLivePosts`. Can exceed 1 (over-delivery).
   * `null` when target is 0 (impossible per the brief contract, kept for
   * type honesty).
   */
  percentOfGoal: z.number().nonnegative().nullable(),
  /** Positive = days remaining, negative = past deadline. */
  daysToDeadline: z.number(),
  /** True when verifiedCount >= targetLivePosts. */
  goalMet: z.boolean(),
});
export type Goals = z.infer<typeof GoalsSchema>;

/**
 * Reach + engagement aggregates across `state="verified"` tracks (only
 * those have a populated `.content` snapshot). Pre-verification reach
 * is intentionally NOT estimated here — analyst agent can speculate, the
 * compile capability stays grounded in observed numbers.
 */
export const ReachSchema = z.object({
  verifiedViews: z.number().int().nonnegative(),
  verifiedLikes: z.number().int().nonnegative(),
  verifiedComments: z.number().int().nonnegative(),
  verifiedShares: z.number().int().nonnegative(),
  /**
   * Weighted by views: `Σ(likes_i + comments_i + shares_i) / Σ(views_i)`.
   * `null` when verifiedViews == 0 (no posts to compute against).
   */
  weightedEngagementRate: z.number().min(0).max(1).nullable(),
});
export type Reach = z.infer<typeof ReachSchema>;

/** Performance score rollup (content-verify agent's 0-100 score, P3-C5). */
export const PerformanceSchema = z.object({
  /** Mean of `track.content.performanceScore` across verified tracks. `null` when none. */
  avgPerformanceScore: z.number().min(0).max(100).nullable(),
  /** Median. `null` when none. */
  medianPerformanceScore: z.number().min(0).max(100).nullable(),
  /** creatorId of the highest-score verified track. `null` when none. */
  topPerformerCreatorId: z.string().nullable(),
});
export type Performance = z.infer<typeof PerformanceSchema>;

export const CostSchema = z.object({
  /** Sum of v2_cost_ledger entries for this campaign. USD. */
  spentUsd: z.number().nonnegative(),
  /** `spentUsd / verifiedCount`. `null` when 0 verified (no denominator). */
  costPerVerifiedPost: z.number().nonnegative().nullable(),
  /** From `brief.goals.budgetUsd` (optional on the brief). */
  budgetUsd: z.number().nonnegative().nullable(),
  /** `spentUsd / budgetUsd`. `null` when no budget set. */
  percentOfBudget: z.number().nonnegative().nullable(),
});
export type Cost = z.infer<typeof CostSchema>;

/**
 * Per-track row — the "leaderboard" data the report view renders. Captures
 * just enough to render the row without re-deriving from the full Campaign
 * object; downstream views can re-fetch the track on click for detail.
 */
export const TrackRowSchema = z.object({
  creatorId: z.string(),
  state: CreatorTrackSchema.shape.state,
  lastActivityAt: z.coerce.date(),
  threadId: z.string().nullable(),
  /** `null` until content-verify has run. */
  performanceScore: z.number().min(0).max(100).nullable(),
  views: z.number().int().nonnegative().nullable(),
});
export type TrackRow = z.infer<typeof TrackRowSchema>;

/**
 * Flags surfaced for the analyst agent + the MC report. Pure rules:
 * computed from the same data, no judgment.
 *  · "budget_exceeded"      — percentOfBudget > 1
 *  · "deadline_missed"      — daysToDeadline < 0 && !goalMet
 *  · "low_response_rate"    — replied/(outreach_sent+replied) < 0.10 with N≥10
 *  · "high_flake_rate"      — flaked / (shipped+delivered+posted+verified+flaked) > 0.30
 *  · "no_verified_yet"      — verifiedCount == 0 && tracks.length > 0
 *  · "goal_met"             — verifiedCount ≥ targetLivePosts
 *
 * `replied` here = in_conversation + agreed + address_collected + shipped +
 * delivered + posted + verified + declined. (Anyone whose reply we classified.)
 */
export const ReportFlagSchema = z.enum([
  "budget_exceeded",
  "deadline_missed",
  "low_response_rate",
  "high_flake_rate",
  "no_verified_yet",
  "goal_met",
]);
export type ReportFlag = z.infer<typeof ReportFlagSchema>;

export const AnalyticsReportSchema = z.object({
  campaignId: z.string(),
  brief: z.object({
    name: z.string(),
    category: z.string(),
    deadline: z.coerce.date(),
  }),
  funnel: FunnelSchema,
  goals: GoalsSchema,
  reach: ReachSchema,
  performance: PerformanceSchema,
  cost: CostSchema,
  tracks: z.array(TrackRowSchema),
  flags: z.array(ReportFlagSchema).default([]),
  /** Timestamp at which this report was compiled (for caching / staleness). */
  generatedAt: z.coerce.date(),
});
export type AnalyticsReport = z.infer<typeof AnalyticsReportSchema>;
