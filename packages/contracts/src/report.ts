import { z } from "zod";
import { AnalyticsReportSchema } from "./analytics";

/**
 * Report — Phase 4 P4-C3 persisted artifact. Combines the analytics snapshot
 * (deterministic) with the analyst agent's narrative (LLM). One row per
 * report delivery; campaigns accumulate them over time so MC can show a
 * timeline of "what changed since last week."
 *
 * The MC report view (P4-C5) renders `narrative.markdown` directly; the
 * `analytics` block backs the charts/tables. `/share/[id]` is a public
 * (HMAC-token-gated) view that shows the same markdown without operator
 * affordances.
 */

/**
 * Subset of AnalystOutput we persist on the row. Mirrors the analyst
 * agent's output verbatim (kept here, not imported from @ss/agents, to
 * preserve the @ss/contracts → no-@ss-deps rule).
 */
export const ReportNarrativeSchema = z.object({
  summary: z.string().min(20).max(600),
  highlights: z.array(z.string().min(5).max(280)).max(4).default([]),
  concerns: z.array(z.string().min(5).max(280)).max(4).default([]),
  recommendations: z.array(z.string().min(5).max(280)).min(1).max(3),
  markdown: z.string().min(50).max(8000),
});
export type ReportNarrative = z.infer<typeof ReportNarrativeSchema>;

/**
 * What triggered this delivery. Drives MC's report list filters
 * ("scheduled" vs "manual export").
 */
export const ReportTriggerSchema = z.enum([
  "cron", // weekly cron walked running campaigns + emitted request
  "stage_transition", // brand-campaign hit performance stage on this campaign
  "manual", // operator clicked "Generate report" in MC
]);
export type ReportTrigger = z.infer<typeof ReportTriggerSchema>;

export const ReportSchema = z.object({
  id: z.string(),
  campaignId: z.string(),
  workspaceId: z.string(),
  trigger: ReportTriggerSchema,
  analytics: AnalyticsReportSchema,
  narrative: ReportNarrativeSchema,
  /**
   * Short HMAC-signed share token (P4-C5 will wire `/share/[id]?t=…` against
   * this). Stored verbatim so the operator can re-display / revoke.
   * Empty when sharing is disabled at the workspace level.
   */
  shareToken: z.string().default(""),
  /** USD cost of the analyst-agent call that produced `narrative`. */
  analystCostUsd: z.number().nonnegative().default(0),
  /** Optional operator note attached at generation time. */
  notes: z.string().default(""),
  generatedAt: z.coerce.date(),
});
export type Report = z.infer<typeof ReportSchema>;
