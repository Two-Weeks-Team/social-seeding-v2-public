/**
 * Token/cost accounting. Every LLM call appends a CostEntry; the orchestrator
 * checks `assertWithinBudget` against the workspace policy before invoking an
 * agent. Soft caps emit alerts (carried from v1 `cost-alert.service`); the
 * per-campaign hard cap throws.
 */
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

export async function recordCost(_entry: CostEntry): Promise<void> {
  // TODO(phase-0): append to Collections.V2_COST_LEDGER; emit alerts at COST_ALERT_THRESHOLDS.
}

export async function assertWithinBudget(_campaignId: string, _capUsd: number): Promise<void> {
  // TODO(phase-0): sum V2_COST_LEDGER for campaign; throw BudgetExceededError if over.
}
