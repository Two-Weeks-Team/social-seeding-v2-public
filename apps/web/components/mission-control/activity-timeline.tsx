import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import type { PersistedSpan, PersistedTraceDoc } from "@ss/db";

/**
 * W3 — Activity timeline renderer. Reads from v2_agent_traces. Each span
 * shows kind (color stripe via left-border + tone), name, optional model /
 * cost / token attrs, and timing. Spans nest by parentId — orphans are
 * rendered at root level. Most-recent run at the top.
 *
 * The mockup's design language: thin connector lines on the left, kind-tinted
 * dot at the row head, attribute chips inline. No heavy cards — this is a
 * dense feed.
 */

const KIND_VARIANT: Record<PersistedSpan["kind"], BadgeVariant> = {
  workflow: "emerald",
  stage: "blue",
  agent: "violet",
  tool: "cyan",
  llm: "violet",
};

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19); // HH:MM:SS
}
function fmtDuration(span: PersistedSpan): string {
  if (!span.endedAt) return "running";
  const d = span.endedAt - span.startedAt;
  if (d < 1000) return `${d}ms`;
  if (d < 60_000) return `${(d / 1000).toFixed(1)}s`;
  return `${Math.round(d / 60_000)}m`;
}

interface TreeNode {
  span: PersistedSpan;
  children: TreeNode[];
}

function buildTree(spans: PersistedSpan[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const s of spans) byId.set(s.id, { span: s, children: [] });
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.span.parentId ? byId.get(node.span.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  // sort siblings by startedAt ascending (child order within a parent run)
  const sortRec = (n: TreeNode): void => {
    n.children.sort((a, b) => a.span.startedAt - b.span.startedAt);
    n.children.forEach(sortRec);
  };
  roots.sort((a, b) => a.span.startedAt - b.span.startedAt);
  roots.forEach(sortRec);
  return roots;
}

function SpanAttrs({ span }: { span: PersistedSpan }) {
  const a = span.attrs;
  const chips: Array<{ label: string; variant?: BadgeVariant; mono?: boolean }> = [];
  if (typeof a.model === "string") chips.push({ label: String(a.model), variant: "violet", mono: true });
  if (typeof a.usd === "number" && a.usd > 0) chips.push({ label: `$${a.usd.toFixed(4)}`, variant: "slate", mono: true });
  if (typeof a.inputTokens === "number" && typeof a.outputTokens === "number") {
    chips.push({ label: `${a.inputTokens}↗ / ${a.outputTokens}↙`, variant: "slate", mono: true });
  }
  if (typeof a.agent === "string") chips.push({ label: a.agent, variant: "violet" });
  return (
    <>
      {chips.map((c, i) => (
        <Badge key={i} variant={c.variant} mono={c.mono}>{c.label}</Badge>
      ))}
    </>
  );
}

function SpanRow({ node, depth }: { node: TreeNode; depth: number }) {
  const { span } = node;
  return (
    <div className="relative">
      <div className="flex items-baseline gap-2 py-1.5" style={{ paddingLeft: depth * 18 }}>
        <span
          className={cn(
            "inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5",
            span.kind === "workflow" && "bg-emerald-500",
            span.kind === "stage" && "bg-blue-500",
            span.kind === "agent" && "bg-violet-500",
            span.kind === "tool" && "bg-cyan-500",
            span.kind === "llm" && "bg-violet-400",
            span.error && "bg-rose-500",
          )}
        />
        <Badge variant={KIND_VARIANT[span.kind]} className="!text-[10px]">{span.kind}</Badge>
        <span className="text-[13px] mono font-medium text-slate-900">{span.name}</span>
        <div className="flex items-center gap-1 flex-wrap ml-1">
          <SpanAttrs span={span} />
        </div>
        <span className="ml-auto text-[10px] text-slate-400 mono whitespace-nowrap">
          {fmtTime(span.startedAt)} · {fmtDuration(span)}
        </span>
      </div>
      {span.error && (
        <div className="text-[11px] text-rose-700 ml-6 mb-1" style={{ paddingLeft: depth * 18 }}>
          error: {span.error}
        </div>
      )}
      {node.children.map((c) => <SpanRow key={c.span.id} node={c} depth={depth + 1} />)}
    </div>
  );
}

export function ActivityTimeline({ traces }: { traces: PersistedTraceDoc[] }) {
  // A10 (P1 Sub-1.4) — the timeline is a streaming feed of agent activity, so
  // a screen reader benefits from role="feed" + aria-live="polite" so newly
  // streamed spans are announced (without interrupting current focus). The
  // outermost wrapper carries the role even in the empty state so AT users
  // hear a consistent "Agent activity timeline" landmark.
  if (traces.length === 0) {
    return (
      <div
        role="feed"
        aria-label="에이전트 활동 타임라인"
        aria-live="polite"
        aria-busy="false"
        className="text-[12px] text-slate-500 py-4 text-center"
      >
        아직 활동이 없습니다. 캠페인이 sourcing 단계로 진입하면 sourcing/vetting span 들이 여기에 실시간으로 쌓입니다.
      </div>
    );
  }
  return (
    <div
      role="feed"
      aria-label="에이전트 활동 타임라인"
      aria-live="polite"
      aria-busy="false"
      className="space-y-4"
    >
      {traces.map((run) => {
        const tree = buildTree(run.spans);
        return (
          <section key={run.runId} aria-label={`실행 ${run.runId.slice(0, 12)}`}>
            <div className="text-[10px] mono text-slate-400 mb-1 flex items-center gap-2">
              <span>run_{run.runId.slice(0, 12)}</span>
              <span>·</span>
              <span>{run.startedAt.toISOString().slice(0, 16).replace("T", " ")}</span>
              <span>·</span>
              <span>{run.spans.length} spans</span>
            </div>
            <div className="border-l border-slate-200 pl-2">
              {tree.map((n) => <SpanRow key={n.span.id} node={n} depth={0} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}
