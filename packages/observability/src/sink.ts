/**
 * Where traces, cost entries and budget queries land. Default = MongoDB (the
 * `v2_*` collections via `@ss/db`); tests inject `memorySink()` so observability
 * unit tests run without a database. Same injectable-seam shape `@ss/agents`
 * uses for its `ModelClient`.
 */
import { Collections, getDb } from "@ss/db";
import type { CostEntry } from "./cost";
import type { TraceSpan } from "./trace";

/** Persisted shape of one run's trace (Collections.V2_AGENT_TRACES). `startedAt` is a Date for the TTL index. */
export interface TraceDoc {
  runId: string;
  campaignId: string;
  startedAt: Date;
  endedAt: Date;
  spans: TraceSpan[];
}

export interface ObservabilitySink {
  appendTrace(doc: TraceDoc): Promise<void>;
  appendCost(entry: CostEntry): Promise<void>;
  /** total USD recorded for a campaign — backs `assertWithinBudget` */
  sumCampaignUsd(campaignId: string): Promise<number>;
}

/** The production sink — writes to the v2_* collections (additive only). */
export function mongoSink(): ObservabilitySink {
  return {
    async appendTrace(doc) {
      const db = await getDb();
      await db.collection(Collections.V2_AGENT_TRACES).insertOne(doc);
    },
    async appendCost(entry) {
      const db = await getDb();
      // store `at` as a Date so the TTL index from scripts/init-indexes.ts applies
      await db.collection(Collections.V2_COST_LEDGER).insertOne({ ...entry, at: new Date(entry.at) });
    },
    async sumCampaignUsd(campaignId) {
      const db = await getDb();
      const rows = await db
        .collection(Collections.V2_COST_LEDGER)
        .aggregate<{ usd: number }>([{ $match: { campaignId } }, { $group: { _id: null, usd: { $sum: "$usd" } } }])
        .toArray();
      return rows[0]?.usd ?? 0;
    },
  };
}

/** An in-memory sink for tests; exposes what it captured. */
export function memorySink(): ObservabilitySink & { traces: TraceDoc[]; costs: CostEntry[] } {
  const traces: TraceDoc[] = [];
  const costs: CostEntry[] = [];
  return {
    traces,
    costs,
    async appendTrace(doc) {
      traces.push(doc);
    },
    async appendCost(entry) {
      costs.push(entry);
    },
    async sumCampaignUsd(campaignId) {
      return costs.filter((c) => c.campaignId === campaignId).reduce((sum, c) => sum + c.usd, 0);
    },
  };
}

let _sink: ObservabilitySink | undefined;
export function getObservabilitySink(): ObservabilitySink {
  return (_sink ??= mongoSink());
}
/** Pass `undefined` to reset to the default (mongo) sink. */
export function setObservabilitySink(sink: ObservabilitySink | undefined): void {
  _sink = sink;
}

// ── cost soft-cap alerts (port of v1 services/cost-alert.service: notify once per threshold crossing) ──

export interface CostAlert {
  campaignId: string;
  workspaceId: string;
  thresholdUsd: number;
  totalUsd: number;
}
export type CostAlertSink = (alert: CostAlert) => void | Promise<void>;

let _alertSink: CostAlertSink = (a) => {
  // default: log. The actual alert email (v1 cost-alert.service) gets wired via apps/web's mailer in a later slice.
  console.warn(
    `[cost-alert] campaign ${a.campaignId} (workspace ${a.workspaceId}) crossed $${a.thresholdUsd} — total $${a.totalUsd.toFixed(2)}`,
  );
};
export function getCostAlertSink(): CostAlertSink {
  return _alertSink;
}
export function setCostAlertSink(sink: CostAlertSink): void {
  _alertSink = sink;
}

/** Parse COST_ALERT_THRESHOLDS ("50,100,200") → ascending positive numbers. */
export function costAlertThresholds(): number[] {
  return (process.env.COST_ALERT_THRESHOLDS ?? "50,100,200")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
}
