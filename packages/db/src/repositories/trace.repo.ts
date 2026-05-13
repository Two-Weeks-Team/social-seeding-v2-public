import { Collections } from "../collections";
import { getDb } from "../client";

/**
 * v2_agent_traces reader. The collection's writer is the observability sink
 * (mongoSink in @ss/observability), which persists one doc per workflow run
 * (or per agent invocation) with a flat `spans[]` field — { id, parentId?,
 * name, kind, startedAt, endedAt?, attrs, error? }.
 *
 * Web reads (W3 activity timeline) only need recent runs for a campaignId,
 * descending by startedAt.
 */

export interface PersistedTraceDoc {
  _id?: unknown;
  runId: string;
  campaignId: string;
  startedAt: Date;
  endedAt: Date;
  spans: PersistedSpan[];
}

export interface PersistedSpan {
  id: string;
  parentId?: string;
  name: string;
  kind: "workflow" | "stage" | "agent" | "tool" | "llm";
  startedAt: number;
  endedAt?: number;
  attrs: Record<string, unknown>;
  error?: string;
}

export const traceRepo = {
  async listByCampaign(campaignId: string, limit = 20): Promise<PersistedTraceDoc[]> {
    const db = await getDb();
    return (await db
      .collection(Collections.V2_AGENT_TRACES)
      .find({ campaignId })
      .sort({ startedAt: -1 })
      .limit(limit)
      .toArray()) as unknown as PersistedTraceDoc[];
  },
};
