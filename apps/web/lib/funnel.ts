import type { AnalyticsReport } from "@ss/contracts";

/**
 * Cumulative funnel — shared by the campaign detail "Conversion funnel" card and
 * the /performance "Funnel — stage conversion" chart.
 *
 * A funnel chart must be CUMULATIVE ("reached this stage or further"), not a
 * current-state snapshot — otherwise a verified track (counted only in
 * `verified`) makes Verified exceed Posted/Delivered. Map each lifecycle or
 * terminal state to the furthest stage it reached, then count tracks
 * at-or-beyond each stage so the funnel is monotonically non-increasing.
 * (Extracted from the performance page so the detail card can't regress back
 * to raw state buckets.)
 */
export const LIFECYCLE = [
  "candidate", "shortlisted", "outreach_sent", "in_conversation", "agreed",
  "address_collected", "shipped", "delivered", "posted", "verified",
] as const;

const REACHED_AT: Record<string, (typeof LIFECYCLE)[number]> = {
  candidate: "candidate", shortlisted: "shortlisted",
  outreach_sent: "outreach_sent", no_response: "outreach_sent",
  in_conversation: "in_conversation", declined: "in_conversation",
  agreed: "agreed", address_collected: "address_collected",
  shipped: "shipped", flaked: "shipped",
  delivered: "delivered", posted: "posted", verified: "verified",
};

export function reachedFunnel(fn: AnalyticsReport["funnel"]): Record<string, number> {
  const out: Record<string, number> = {};
  LIFECYCLE.forEach((stage, si) => {
    let n = 0;
    for (const [state, count] of Object.entries(fn)) {
      const ri = LIFECYCLE.indexOf(REACHED_AT[state] ?? (state as (typeof LIFECYCLE)[number]));
      if (ri >= si) n += count;
    }
    out[stage] = n;
  });
  return out;
}
