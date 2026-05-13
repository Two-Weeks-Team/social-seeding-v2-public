import { afterEach, describe, expect, it } from "vitest";
import { assertWithinBudget, BudgetExceededError, recordCost, startTrace, type CostEntry } from "./index";
import { type CostAlert, memorySink, setCostAlertSink, setObservabilitySink } from "./sink";

/**
 * P0-4 proof: the cost ledger backs assertWithinBudget, soft-cap alerts fire
 * once per threshold crossed, and trace.flush() writes a TraceDoc to the sink.
 * Uses an in-memory sink — no database.
 */

const ENV_THRESHOLDS = process.env.COST_ALERT_THRESHOLDS;
const ENV_SINK = process.env.AGENT_TRACE_SINK;

afterEach(() => {
  setObservabilitySink(undefined); // back to the mongo default
  setCostAlertSink(() => undefined);
  if (ENV_THRESHOLDS === undefined) delete process.env.COST_ALERT_THRESHOLDS;
  else process.env.COST_ALERT_THRESHOLDS = ENV_THRESHOLDS;
  if (ENV_SINK === undefined) delete process.env.AGENT_TRACE_SINK;
  else process.env.AGENT_TRACE_SINK = ENV_SINK;
});

function costEntry(campaignId: string, usd: number, workspaceId = "ws"): CostEntry {
  return { campaignId, workspaceId, agent: "a", model: "claude-haiku-4-5", inputTokens: 10, outputTokens: 5, usd, at: Date.now() };
}

describe("@ss/observability cost ledger", () => {
  it("sums recorded cost and enforces the per-campaign cap", async () => {
    setObservabilitySink(memorySink());
    await recordCost(costEntry("c1", 3));
    await recordCost(costEntry("c1", 4));
    await expect(assertWithinBudget("c1", 10)).resolves.toBeUndefined();
    await expect(assertWithinBudget("c1", 5)).rejects.toBeInstanceOf(BudgetExceededError);
    // a different campaign is unaffected
    await expect(assertWithinBudget("c-other", 0.01)).resolves.toBeUndefined();
  });

  it("fires a cost alert exactly once per threshold the running total crosses", async () => {
    process.env.COST_ALERT_THRESHOLDS = "5,10";
    setObservabilitySink(memorySink());
    const alerts: CostAlert[] = [];
    setCostAlertSink((a) => {
      alerts.push(a);
    });
    await recordCost(costEntry("c2", 3)); // total 3 — no crossing
    await recordCost(costEntry("c2", 4)); // total 7 — crosses 5
    await recordCost(costEntry("c2", 4)); // total 11 — crosses 10
    await recordCost(costEntry("c2", 1)); // total 12 — no new crossing
    expect(alerts.map((a) => a.thresholdUsd)).toEqual([5, 10]);
    expect(alerts[1]?.totalUsd).toBe(11);
  });
});

describe("@ss/observability trace", () => {
  it("flush() writes one TraceDoc (with a Date startedAt) to the sink in mongo mode", async () => {
    delete process.env.AGENT_TRACE_SINK; // default = "mongo"
    const sink = memorySink();
    setObservabilitySink(sink);
    const trace = startTrace("c3");
    await trace.span("plan", "stage", { i: 1 }, async () => {
      await trace.span("agent:echo", "agent", {}, async () => "done");
    });
    await trace.flush();
    expect(sink.traces).toHaveLength(1);
    const doc = sink.traces[0];
    expect(doc?.campaignId).toBe("c3");
    expect(doc?.spans.map((s) => s.name)).toEqual(["plan", "agent:echo"]);
    expect(doc?.spans[1]?.parentId).toBe(doc?.spans[0]?.id);
    expect(doc?.startedAt).toBeInstanceOf(Date);
    expect(doc?.endedAt).toBeInstanceOf(Date);
  });

  it("flush() writes nothing to the sink in stdout mode", async () => {
    process.env.AGENT_TRACE_SINK = "stdout";
    const sink = memorySink();
    setObservabilitySink(sink);
    const trace = startTrace("c4");
    await trace.span("noop", "workflow", {}, async () => undefined);
    await trace.flush();
    expect(sink.traces).toHaveLength(0);
  });
});
