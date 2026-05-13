/**
 * Token/cost accounting. Every LLM call appends a CostEntry to the cost ledger;
 * the orchestrator checks `assertWithinBudget` against the workspace policy
 * before invoking an agent (and `runAgent` enforces its own per-invocation cap).
 * Soft caps emit alerts (carried from v1 `cost-alert.service`); the per-campaign
 * hard cap throws `BudgetExceededError`.
 *
 * Storage goes through the injectable observability sink (see ./sink.ts) —
 * Mongo (Collections.V2_COST_LEDGER) by default, an in-memory sink in tests.
 */
import { costAlertThresholds, getCostAlertSink, getObservabilitySink } from "./sink";

export interface CostEntry {
  campaignId: string;
  workspaceId: string;
  agent: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  at: number;
}

export class BudgetExceededError extends Error {
  constructor(
    readonly campaignId: string,
    readonly spentUsd: number,
    readonly capUsd: number,
  ) {
    super(`campaign ${campaignId} exceeded budget: $${spentUsd.toFixed(2)} > $${capUsd.toFixed(2)}`);
    this.name = "BudgetExceededError";
  }
}

export async function recordCost(entry: CostEntry): Promise<void> {
  const sink = getObservabilitySink();
  // (one extra round trip per record so we can detect threshold crossings; v1's
  //  cost-alert.service caches the running total — fine to add here later.)
  const before = await sink.sumCampaignUsd(entry.campaignId);
  await sink.appendCost(entry);
  const after = before + entry.usd;
  for (const threshold of costAlertThresholds()) {
    if (before < threshold && after >= threshold) {
      await getCostAlertSink()({ campaignId: entry.campaignId, workspaceId: entry.workspaceId, thresholdUsd: threshold, totalUsd: after });
    }
  }
}

export async function assertWithinBudget(campaignId: string, capUsd: number): Promise<void> {
  const spent = await getObservabilitySink().sumCampaignUsd(campaignId);
  if (spent > capUsd) throw new BudgetExceededError(campaignId, spent, capUsd);
}
