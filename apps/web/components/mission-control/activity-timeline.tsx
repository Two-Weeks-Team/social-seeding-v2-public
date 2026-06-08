import { cn } from "@/lib/cn";
import { spanLabelKo } from "@/lib/labels";
import type { PersistedSpan, PersistedTraceDoc } from "@ss/db";

/**
 * Activity timeline (C2 redesign) — the operator's plain-language record of what
 * the agents did. The audit flagged the old version for raw run_ UUIDs, "N spans",
 * "0ms" durations and engineering chips (model/tokens/cost). Now: humanized span
 * names, espresso dots, real timestamps (zero-duration durations hidden), and the
 * run id de-emphasized to a relative time. role="feed" a11y preserved.
 */

function fmtClock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16); // HH:MM
}

function fmtDuration(span: PersistedSpan): string | null {
  if (!span.endedAt) return "running";
  const d = span.endedAt - span.startedAt;
  if (d < 1000) return null; // hide sub-second "0ms"-looking durations
  if (d < 60_000) return `${(d / 1000).toFixed(1)}s`;
  return `${Math.round(d / 60_000)}m`;
}

function fmtRunWhen(d: Date): string {
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${d.toISOString().slice(11, 16)}`;
}

const DOT: Record<PersistedSpan["kind"], string> = {
  workflow: "bg-brand",
  stage: "bg-run",
  agent: "bg-brand-ink",
  tool: "bg-ink-3",
  llm: "bg-brand-ink",
};

interface TreeNode { span: PersistedSpan; children: TreeNode[] }

function buildTree(spans: PersistedSpan[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const s of spans) byId.set(s.id, { span: s, children: [] });
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.span.parentId ? byId.get(node.span.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortRec = (n: TreeNode): void => {
    n.children.sort((a, b) => a.span.startedAt - b.span.startedAt);
    n.children.forEach(sortRec);
  };
  roots.sort((a, b) => a.span.startedAt - b.span.startedAt);
  roots.forEach(sortRec);
  return roots;
}

function SpanRow({ node, depth }: { node: TreeNode; depth: number }) {
  const { span } = node;
  const dur = fmtDuration(span);
  return (
    <div className="relative">
      <div className="flex items-baseline gap-2.5 py-1.5" style={{ paddingLeft: depth * 18 }}>
        <span
          className={cn("inline-block w-2 h-2 rounded-full shrink-0 mt-1.5", span.error ? "bg-stop" : DOT[span.kind])}
          aria-hidden
        />
        <span className="text-[13.5px] font-medium text-ink">{spanLabelKo(span.name)}</span>
        <span className="ml-auto text-[11px] text-ink-3 mono whitespace-nowrap">
          {fmtClock(span.startedAt)}{dur ? ` · ${dur}` : ""}
        </span>
      </div>
      {span.error && (
        <div className="text-[11.5px] text-stop mb-1" style={{ paddingLeft: depth * 18 + 18 }}>
          Issue: {span.error}
        </div>
      )}
      {node.children.map((c) => <SpanRow key={c.span.id} node={c} depth={depth + 1} />)}
    </div>
  );
}

export function ActivityTimeline({ traces }: { traces: PersistedTraceDoc[] }) {
  if (traces.length === 0) {
    return (
      <div
        role="feed"
        aria-label="Agent activity timeline"
        aria-live="polite"
        aria-busy="false"
        className="text-[13px] text-ink-3 py-8 text-center"
      >
        No activity yet. Once the campaign enters sourcing, agent work will appear here in real time.
      </div>
    );
  }
  return (
    <div role="feed" aria-label="Agent activity timeline" aria-live="polite" aria-busy="false" className="space-y-5">
      {traces.map((run) => {
        const tree = buildTree(run.spans);
        return (
          <section key={run.runId} role="article" aria-label={`Run ${fmtRunWhen(run.startedAt)}`}>
            <div className="text-[11px] text-ink-3 mb-1.5">{fmtRunWhen(run.startedAt)}</div>
            <div className="border-l-2 border-line pl-3">
              {tree.map((n) => <SpanRow key={n.span.id} node={n} depth={0} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}
