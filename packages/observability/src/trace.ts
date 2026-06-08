import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { getObservabilitySink } from "./sink";

/**
 * Per-run trace. Agentic systems fail silently; this makes every agent call,
 * tool call and LLM call visible. One trace per campaign workflow run; spans
 * nest (workflow → stage → agent → tool/LLM).
 *
 * Sink is configurable via AGENT_TRACE_SINK (mongo | stdout). The mongo sink
 * writes one TraceDoc per run to Collections.V2_AGENT_TRACES (see ./sink.ts).
 */
export interface TraceSpan {
  id: string;
  parentId?: string;
  name: string;
  kind: "workflow" | "stage" | "agent" | "tool" | "llm";
  startedAt: number;
  endedAt?: number;
  attrs: Record<string, unknown>;
  error?: string;
}

export interface RunTrace {
  runId: string;
  campaignId: string;
  spans: TraceSpan[];
  span<T>(name: string, kind: TraceSpan["kind"], attrs: Record<string, unknown>, fn: (span: TraceSpan) => Promise<T>): Promise<T>;
  flush(): Promise<void>;
}

export function startTrace(campaignId: string, runId = randomUUID()): RunTrace {
  const spans: TraceSpan[] = [];
  // AsyncLocalStorage carries the current parent span id PER async context, so
  // concurrent spans (e.g. a Promise.all vetting fan-out) become SIBLINGS, not a
  // pathological nest. A single shared stack would mis-parent parallel spans
  // (each push before any pop → each sees the previous as parent → runaway depth).
  const parentCtx = new AsyncLocalStorage<string | undefined>();

  async function span<T>(
    name: string,
    kind: TraceSpan["kind"],
    attrs: Record<string, unknown>,
    fn: (span: TraceSpan) => Promise<T>,
  ): Promise<T> {
    const s: TraceSpan = { id: randomUUID(), parentId: parentCtx.getStore(), name, kind, startedAt: Date.now(), attrs };
    spans.push(s);
    return parentCtx.run(s.id, async () => {
      try {
        return await fn(s);
      } catch (err) {
        s.error = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        s.endedAt = Date.now();
      }
    });
  }

  async function flush(): Promise<void> {
    if ((process.env.AGENT_TRACE_SINK ?? "mongo") === "stdout") {
      process.stdout.write(JSON.stringify({ runId, campaignId, spans }) + "\n");
      return;
    }
    const startTimes = spans.map((s) => s.startedAt);
    const endTimes = spans.map((s) => s.endedAt ?? s.startedAt);
    const startedAt = new Date(startTimes.length ? Math.min(...startTimes) : Date.now());
    const endedAt = new Date(endTimes.length ? Math.max(...endTimes) : startedAt.getTime());
    await getObservabilitySink().appendTrace({ runId, campaignId, startedAt, endedAt, spans });
  }

  return { runId, campaignId, spans, span, flush };
}
