import { randomUUID } from "node:crypto";

/**
 * Per-run trace. Agentic systems fail silently; this makes every agent call,
 * tool call and LLM call visible. One trace per campaign workflow run; spans
 * nest (workflow → stage → agent → tool/LLM).
 *
 * Sink is configurable via AGENT_TRACE_SINK (mongo | stdout). The mongo sink
 * writes to Collections.V2_AGENT_TRACES. Stubbed flush below.
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
  const stack: string[] = [];

  async function span<T>(
    name: string,
    kind: TraceSpan["kind"],
    attrs: Record<string, unknown>,
    fn: (span: TraceSpan) => Promise<T>,
  ): Promise<T> {
    const s: TraceSpan = { id: randomUUID(), parentId: stack.at(-1), name, kind, startedAt: Date.now(), attrs };
    spans.push(s);
    stack.push(s.id);
    try {
      return await fn(s);
    } catch (err) {
      s.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      s.endedAt = Date.now();
      stack.pop();
    }
  }

  async function flush(): Promise<void> {
    if ((process.env.AGENT_TRACE_SINK ?? "mongo") === "stdout") {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ runId, campaignId, spans }));
      return;
    }
    // TODO(phase-0): write to Collections.V2_AGENT_TRACES via @ss/db.
  }

  return { runId, campaignId, spans, span, flush };
}
