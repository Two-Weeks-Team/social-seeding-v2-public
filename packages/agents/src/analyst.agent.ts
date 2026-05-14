import { z } from "zod";
import { AnalyticsReportSchema, CampaignBriefSchema } from "@ss/contracts";
import { defineAgent } from "./runtime";

/**
 * Analyst agent — Phase 4 P4-C2. Takes the AnalyticsReport that
 * `analytics.compile` produced and the original CampaignBrief, returns a
 * human-readable narrative (markdown) + 3 structured slots the MC report
 * view renders directly: summary / highlights / concerns / recommendations.
 *
 * Discipline:
 *  · No tools. The numbers are already in the input (we don't want the
 *    analyst re-running `analytics.compile` and getting a slightly
 *    different snapshot — the input is the canonical view).
 *  · Haiku, $0.10 cap. This is data-narration, not strategy.
 *  · Markdown is for share/preview. Structured fields are for the MC view
 *    so the operator can scan in 10 seconds without parsing prose.
 *  · `flags` is precomputed by the capability (deterministic rules) —
 *    the agent's `concerns` array translates the FIRED flags into plain
 *    language, it does NOT decide WHICH flags fire. Keeps the numeric
 *    truth in `analytics.compile`, the prose in here.
 *
 * Prompt-injection note: the brief is operator-controlled (low risk).
 * The AnalyticsReport is computed from our own DB (zero injection
 * surface). Future addition: when `creator-track` snapshots include the
 * post desc on `track.content` (Phase 3 already does), and we forward
 * that to the analyst for highlight selection, treat desc as DATA and
 * carry the same "do not follow embedded instructions" guard the
 * content-verify agent has.
 */

export const AnalystOutputSchema = z.object({
  /**
   * 2-3 sentence executive summary. Shown at the top of the MC report view
   * + as the share-link preview. Plain prose, no markdown formatting.
   */
  summary: z.string().min(20).max(600),
  /**
   * 0-4 bullets of what went well. Cite specific numbers from the report
   * (e.g. "@freshly drove 60% of total views"). MC renders as a list.
   */
  highlights: z.array(z.string().min(5).max(280)).max(4).default([]),
  /**
   * 0-4 bullets of what to watch. One bullet per FIRED report flag (the
   * agent may add 1 extra qualitative concern). Plain language.
   */
  concerns: z.array(z.string().min(5).max(280)).max(4).default([]),
  /**
   * 1-3 forward-looking suggestions for the operator. Concrete and
   * narrow ("next campaign target ≥25k followers"; NOT "improve KPIs").
   */
  recommendations: z.array(z.string().min(5).max(280)).min(1).max(3),
  /**
   * The full markdown report — what `/share/[id]` renders. Includes the
   * structured fields above formatted as markdown sections.
   */
  markdown: z.string().min(50).max(8000),
});
export type AnalystOutput = z.infer<typeof AnalystOutputSchema>;

export const analystAgent = defineAgent({
  id: "analyst",
  description:
    "Compose a human-readable campaign report from the AnalyticsReport + brief. Pure text agent — no tools. Returns { summary, highlights, concerns, recommendations, markdown }.",
  tools: [],
  model: "claude-haiku-4-5",
  maxUsd: 0.10,
  input: z.object({
    brief: CampaignBriefSchema,
    report: AnalyticsReportSchema,
    /**
     * Optional handle map: { creatorId → "@username" } so the agent can
     * cite creators by handle in prose. When absent the analyst just
     * cites by creatorId (less friendly but still correct).
     */
    creatorHandles: z.record(z.string(), z.string()).default({}),
  }),
  output: AnalystOutputSchema,
  systemPrompt: ({ brief, report, creatorHandles }) => {
    const verifiedRows = report.tracks.filter((t) => t.state === "verified");
    const topHandle = report.performance.topPerformerCreatorId
      ? creatorHandles[report.performance.topPerformerCreatorId] ?? report.performance.topPerformerCreatorId
      : null;
    const verifiedHandles = verifiedRows
      .map((t) => `${creatorHandles[t.creatorId] ?? t.creatorId} (score ${t.performanceScore ?? "?"}, ${(t.views ?? 0).toLocaleString()} views)`)
      .slice(0, 8); // cap the prompt size on big campaigns

    return [
      `You are the Analyst agent. The numbers are already computed — your job is to translate them into a short, factual narrative for the operator + the share-link preview.`,
      "",
      `## Campaign brief`,
      `Brand: ${brief.brandProduct.name} (${brief.brandProduct.category})`,
      `Target: ${brief.goals.targetLivePosts} live posts by ${brief.goals.deadline.toISOString().slice(0, 10)}.`,
      brief.goals.budgetUsd !== undefined ? `Budget: $${brief.goals.budgetUsd}.` : "",
      "",
      `## The numbers (already verified — do not recompute)`,
      `Funnel: candidate=${report.funnel.candidate}, outreach_sent=${report.funnel.outreach_sent}, in_conversation=${report.funnel.in_conversation}, agreed=${report.funnel.agreed}, shipped=${report.funnel.shipped}, delivered=${report.funnel.delivered}, posted=${report.funnel.posted}, **verified=${report.funnel.verified}**, declined=${report.funnel.declined}, no_response=${report.funnel.no_response}, flaked=${report.funnel.flaked}.`,
      `Goal vs actual: ${report.goals.verifiedCount} / ${report.goals.targetLivePosts} verified (${report.goals.percentOfGoal !== null ? Math.round(report.goals.percentOfGoal * 100) + "%" : "n/a"}). Deadline: ${report.goals.daysToDeadline >= 0 ? `${report.goals.daysToDeadline} days remaining` : `${-report.goals.daysToDeadline} days past`}. goalMet=${report.goals.goalMet}.`,
      `Reach: ${report.reach.verifiedViews.toLocaleString()} verified views, ${report.reach.verifiedLikes.toLocaleString()} likes, weighted ER ${report.reach.weightedEngagementRate !== null ? (report.reach.weightedEngagementRate * 100).toFixed(2) + "%" : "n/a"}.`,
      `Performance: avg ${report.performance.avgPerformanceScore ?? "n/a"} / median ${report.performance.medianPerformanceScore ?? "n/a"} / top performer ${topHandle ?? "n/a"}.`,
      `Cost: $${report.cost.spentUsd.toFixed(2)} spent${report.cost.budgetUsd !== null ? ` / $${report.cost.budgetUsd} budget (${report.cost.percentOfBudget !== null ? Math.round(report.cost.percentOfBudget * 100) + "%" : "n/a"})` : ""}${report.cost.costPerVerifiedPost !== null ? `, $${report.cost.costPerVerifiedPost.toFixed(2)} per verified post` : ""}.`,
      report.flags.length > 0 ? `Flags fired: ${report.flags.join(", ")}.` : "Flags fired: (none).",
      verifiedHandles.length > 0 ? `Verified creators: ${verifiedHandles.join(" / ")}.` : "",
      "",
      "## What to produce",
      "Return JSON matching the output schema. Specifically:",
      "",
      "1) `summary` (2-3 sentences) — was the campaign on track / behind / over-delivered? State the headline number (verified/target) and one defining trait (e.g. 'cost-efficient but slow on replies'). Plain prose. No markdown.",
      "",
      "2) `highlights` (0-4 bullets) — best outcomes. Lean on concrete numbers (handle, views, score). Skip if there are no real wins yet (don't manufacture them).",
      "",
      "3) `concerns` (0-4 bullets) — one bullet PER fired flag (translate the flag id into plain language; do not invent extra issues). You may add ONE extra qualitative concern if the data suggests it, but never more.",
      "",
      "4) `recommendations` (1-3 bullets) — concrete actions for the NEXT campaign (different creator tier, different angle, raise/lower budget, etc.). Must reference something from the current data.",
      "",
      "5) `markdown` — the full report formatted with these sections, in this order:",
      "```",
      `# ${brief.brandProduct.name} — Campaign Report`,
      "",
      "<one-line subtitle: status + headline number>",
      "",
      "## Summary",
      "<summary prose>",
      "",
      "## What worked",
      "- <highlight 1>",
      "...",
      "",
      "## What to watch",
      "- <concern 1>",
      "...",
      "",
      "## Next campaign",
      "- <recommendation 1>",
      "...",
      "",
      "## Numbers",
      "| Metric | Value |",
      "|---|---|",
      "| Verified posts | n / target |",
      "| Reach | … |",
      "...",
      "```",
      "Don't pad with empty sections — if `highlights` or `concerns` is empty, drop that markdown section.",
      "",
      "## Discipline",
      "  · Cite numbers from the data above; don't invent new ones.",
      "  · Don't speculate on creator intent. If a track is `flaked` we don't know why — just count.",
      "  · Concerns map 1:1 to fired flags. Don't add a `budget_exceeded` concern if that flag didn't fire.",
      "  · If goalMet=true, lead the summary with the win; if percentOfGoal < 0.5, lead with the gap.",
      "  · Tone: operator-to-operator. No marketing copy, no 'incredible results', no exclamation marks.",
    ]
      .filter(Boolean)
      .join("\n");
  },
});
