"use client";

import { useMemo, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import type { CampaignStage } from "@ss/contracts";

/**
 * Campaign canvas — the alternative to the timeline view. Renders the
 * brand-campaign workflow as a typed node graph (n8n-style, with the
 * design language we locked: minimalist editorial). Same data, different
 * shell — the timeline list survives for cross-campaign triage in
 * /approvals; the canvas is single-campaign.
 *
 * Phase 2 Chunk 1 ships: 6-stage horizontal lanes · brief / agent / tool /
 * gate / wait / fan-out node types · right-side property panel · selection +
 * pan/zoom (React Flow's defaults). Auto-layout is intentionally absent —
 * the workflow shape is fixed and authored by the developer, not free-form.
 *
 * Outreach / shipping / content / performance nodes render in a faded
 * "pending" state today; Phase 2's outreach + reply-handling slice (and
 * subsequent phases) light them up.
 */

type Tone = "slate" | "blue" | "emerald" | "amber" | "rose" | "violet" | "cyan";
type Status = "done" | "running" | "waiting" | "pending" | "errored";

interface SsNodeData extends Record<string, unknown> {
  label: string;
  kind: "brief" | "agent" | "tool" | "gate" | "wait" | "group";
  status: Status;
  tone: Tone;
  hint?: string;
  attrs?: Array<{ label: string; tone?: Tone; mono?: boolean }>;
  detail?: string;
  primaryAction?: { label: string; href: string };
}

const STAGE_X: Record<CampaignStage, [number, number]> = {
  overview: [0, 140],
  sourcing: [140, 680],
  outreach: [680, 960],
  shipping: [960, 1160],
  content_review: [1160, 1360],
  performance: [1360, 1580],
};

const STAGE_LABEL: Record<CampaignStage, string> = {
  overview: "1 · overview",
  sourcing: "2 · sourcing",
  outreach: "3 · outreach",
  shipping: "4 · shipping",
  content_review: "5 · content_review",
  performance: "6 · performance",
};

// ── custom node components ─────────────────────────────────────────────────

const TONE_BORDER: Record<Tone, string> = {
  slate: "border-l-slate-500",
  blue: "border-l-blue-500",
  emerald: "border-l-emerald-500",
  amber: "border-l-amber-500",
  rose: "border-l-rose-500",
  violet: "border-l-violet-500",
  cyan: "border-l-cyan-500",
};

const STATUS_DOT: Record<Status, string> = {
  done: "bg-emerald-500",
  running: "bg-blue-500 animate-pulse",
  waiting: "bg-amber-500 animate-pulse",
  pending: "bg-slate-300",
  errored: "bg-rose-500",
};

function SsNode({ data, selected }: NodeProps<Node<SsNodeData>>) {
  const isFuture = data.status === "pending";
  return (
    <div
      className={cn(
        "relative bg-white border border-slate-200 rounded-md shadow-[0_1px_2px_rgba(15,23,42,0.05)]",
        "border-l-4 transition-transform",
        TONE_BORDER[data.tone],
        data.kind === "gate" && "bg-amber-50/40",
        data.kind === "wait" && "bg-slate-50 border-dashed",
        isFuture && "opacity-45",
        selected && "ring-2 ring-slate-900 ring-offset-1",
      )}
      style={{ width: 180, padding: "10px 12px" }}
    >
      <Handle type="target" position={Position.Left} style={{ background: "transparent", border: 0 }} />
      <div className="absolute top-2 right-2 flex items-center gap-1">
        <span className={cn("inline-block w-1.5 h-1.5 rounded-full", STATUS_DOT[data.status])} />
      </div>
      <div className="flex items-center gap-1.5 text-[10px] text-slate-600">
        <Badge variant={data.tone} className="!text-[9px] !py-0">{data.kind}</Badge>
      </div>
      <div className="mt-1 text-[13px] font-semibold leading-tight text-slate-900">{data.label}</div>
      {data.attrs && data.attrs.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {data.attrs.map((a, i) => (
            <Badge key={i} variant={a.tone ?? "slate"} mono={a.mono} className="!text-[10px] !py-0">
              {a.label}
            </Badge>
          ))}
        </div>
      )}
      {data.hint && <div className="mt-1.5 text-[10px] text-slate-500 leading-snug">{data.hint}</div>}
      <Handle type="source" position={Position.Right} style={{ background: "transparent", border: 0 }} />
    </div>
  );
}

const nodeTypes = { ssNode: SsNode };

// ── data → graph ───────────────────────────────────────────────────────────

interface BuildArgs {
  stage: CampaignStage;
  brandName: string;
  targetCreatorCount: number;
  vetCount: number;
  budgetCapUsd: number;
  shortlistCount?: number;
  shortlistGateApprovalId?: string;
  trackCount: number;
}

function buildGraph(a: BuildArgs): { nodes: Node<SsNodeData>[]; edges: Edge[] } {
  const passed = (s: CampaignStage): boolean => {
    const order: CampaignStage[] = ["overview", "sourcing", "outreach", "shipping", "content_review", "performance"];
    return order.indexOf(a.stage) > order.indexOf(s);
  };
  const isCurrent = (s: CampaignStage): boolean => a.stage === s;
  const stageStatus = (s: CampaignStage): Status =>
    passed(s) ? "done" : isCurrent(s) ? "running" : "pending";

  const sourcingStatus: Status = passed("sourcing") ? "done" : isCurrent("sourcing") ? (a.shortlistGateApprovalId ? "done" : "running") : "pending";
  const vetGroupStatus: Status = sourcingStatus === "done" ? "done" : isCurrent("sourcing") ? "running" : "pending";
  const shortlistStatus: Status = a.shortlistGateApprovalId ? "done" : isCurrent("sourcing") && passed("overview") ? "running" : "pending";
  const gateStatus: Status = a.shortlistGateApprovalId ? "waiting" : a.trackCount > 0 ? "done" : "pending";

  const nodes: Node<SsNodeData>[] = [
    {
      id: "brief",
      position: { x: 16, y: 180 },
      type: "ssNode",
      data: {
        label: a.brandName,
        kind: "brief",
        tone: "slate",
        status: passed("overview") ? "done" : "running",
        hint: `${a.targetCreatorCount} creators · $${a.budgetCapUsd} cap`,
      },
    },
    {
      id: "sourcing",
      position: { x: 220, y: 180 },
      type: "ssNode",
      data: {
        label: "sourcing",
        kind: "agent",
        tone: "violet",
        status: sourcingStatus,
        attrs: [
          { label: "opus-4.7", tone: "violet", mono: true },
          { label: "tiktok.search", tone: "cyan" },
          { label: "blacklist.check", tone: "cyan" },
        ],
      },
    },
    {
      id: "vetting",
      position: { x: 440, y: 270 },
      type: "ssNode",
      data: {
        label: `vetting × ${a.vetCount || "—"}`,
        kind: "group",
        tone: "violet",
        status: vetGroupStatus,
        attrs: [{ label: "haiku-4.5", tone: "violet", mono: true }],
        hint: a.vetCount > 0 ? `${a.vetCount} candidates evaluated` : "fan-out per candidate",
      },
    },
    {
      id: "shortlist",
      position: { x: 520, y: 180 },
      type: "ssNode",
      data: {
        label: "pickShortlist",
        kind: "tool",
        tone: "cyan",
        status: shortlistStatus,
        attrs: a.shortlistCount ? [{ label: `→ ${a.shortlistCount}`, tone: "slate", mono: true }] : [],
      },
    },
    {
      id: "gate-shortlist",
      position: { x: 720, y: 180 },
      type: "ssNode",
      data: {
        label: "approveShortlist",
        kind: "gate",
        tone: "amber",
        status: gateStatus,
        hint: a.shortlistGateApprovalId
          ? "human review pending"
          : a.trackCount > 0
            ? `${a.trackCount} tracks persisted`
            : "policy gate",
        ...(a.shortlistGateApprovalId
          ? { primaryAction: { label: "검토 →", href: `/approvals/${a.shortlistGateApprovalId}` } }
          : {}),
      },
    },
    // Future stages (Phase 2+) — kept faded for inventory awareness
    {
      id: "outreach",
      position: { x: 960, y: 200 },
      type: "ssNode",
      data: {
        label: "outreach-writer",
        kind: "agent",
        tone: "violet",
        status: stageStatus("outreach"),
        attrs: [{ label: "gmail.send", tone: "cyan" }],
      },
    },
    {
      id: "wait-reply",
      position: { x: 960, y: 320 },
      type: "ssNode",
      data: {
        label: "reply · 3d",
        kind: "wait",
        tone: "slate",
        status: stageStatus("outreach"),
        hint: "step.sleep | reply",
      },
    },
    {
      id: "shipping",
      position: { x: 1160, y: 200 },
      type: "ssNode",
      data: {
        label: "logistics",
        kind: "agent",
        tone: "violet",
        status: stageStatus("shipping"),
        attrs: [{ label: "shipment.create", tone: "cyan" }],
      },
    },
    {
      id: "content",
      position: { x: 1360, y: 200 },
      type: "ssNode",
      data: {
        label: "content-verify",
        kind: "agent",
        tone: "violet",
        status: stageStatus("content_review"),
        attrs: [{ label: "tiktok.getCreator", tone: "cyan" }],
      },
    },
  ];

  const edges: Edge[] = [
    edge("brief", "sourcing", sourcingStatus !== "pending"),
    edge("sourcing", "vetting", vetGroupStatus !== "pending"),
    edge("vetting", "shortlist", shortlistStatus !== "pending"),
    edge("shortlist", "gate-shortlist", gateStatus !== "pending"),
    edge("gate-shortlist", "outreach", a.trackCount > 0),
    edge("outreach", "wait-reply", false),
    edge("outreach", "shipping", false),
    edge("shipping", "content", false),
  ];

  return { nodes, edges };
}

function edge(source: string, target: string, active: boolean): Edge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    type: "default",
    style: {
      stroke: active ? "rgb(16 185 129)" : "rgb(203 213 225)",
      strokeWidth: active ? 1.5 : 1,
      strokeDasharray: undefined,
    },
  };
}

// ── stage-lane background (vertical bands behind the flow) ─────────────────

function StageLanes({ currentStage }: { currentStage: CampaignStage }) {
  const stages: CampaignStage[] = ["overview", "sourcing", "outreach", "shipping", "content_review", "performance"];
  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 0 }}>
      {stages.map((s) => {
        const [x0, x1] = STAGE_X[s];
        const isCurrent = s === currentStage;
        return (
          <div
            key={s}
            className={cn(
              "absolute top-0 bottom-0 border-r border-dashed",
              isCurrent ? "border-blue-200 bg-blue-50/30" : "border-slate-200",
            )}
            style={{ left: x0, width: x1 - x0 }}
          >
            <div className="absolute top-3 left-3 text-[10px] uppercase tracking-wider text-slate-400 font-medium">
              {STAGE_LABEL[s]}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── exposed component ──────────────────────────────────────────────────────

export interface CampaignCanvasProps {
  stage: CampaignStage;
  brandName: string;
  targetCreatorCount: number;
  vetCount: number;
  budgetCapUsd: number;
  shortlistCount?: number;
  shortlistGateApprovalId?: string;
  trackCount: number;
}

export function CampaignCanvas(props: CampaignCanvasProps) {
  const [selected, setSelected] = useState<SsNodeData | null>(null);
  const { nodes, edges } = useMemo(() => buildGraph(props), [props]);

  return (
    <div className="relative flex h-[560px] border border-slate-200 rounded-lg overflow-hidden bg-white">
      <div className="flex-1 relative">
        <StageLanes currentStage={props.stage} />
        <div className="absolute inset-0" style={{ zIndex: 1 }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            proOptions={{ hideAttribution: true }}
            nodesDraggable={false}
            nodesConnectable={false}
            onNodeClick={(_e, node) => setSelected(node.data as SsNodeData)}
            onPaneClick={() => setSelected(null)}
            defaultEdgeOptions={{ animated: false }}
          >
            <Background gap={16} size={1} color="#cbd5e1" />
            <Controls showInteractive={false} position="bottom-left" style={{ background: "white", border: "1px solid rgb(226 232 240)", borderRadius: 6 }} />
          </ReactFlow>
        </div>
      </div>

      {/* Right property panel */}
      <aside className="w-80 border-l border-slate-200 bg-white overflow-y-auto flex-shrink-0">
        {!selected ? (
          <div className="p-4 text-[12px] text-slate-500">
            노드를 클릭하면 세부 정보가 여기에 나타납니다.
          </div>
        ) : (
          <div className="p-4 space-y-3">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500">선택한 노드</div>
              <div className="mt-1 flex items-center gap-2">
                <Badge variant={selected.tone}>{selected.kind}</Badge>
                <div className="text-[15px] font-semibold">{selected.label}</div>
              </div>
            </div>
            <div className="text-[12px] text-slate-600">
              <span className="font-medium">상태</span>{" "}
              <span className={cn(
                selected.status === "done" && "text-emerald-700",
                selected.status === "running" && "text-blue-700",
                selected.status === "waiting" && "text-amber-700",
                selected.status === "pending" && "text-slate-500",
                selected.status === "errored" && "text-rose-700",
              )}>{selected.status}</span>
            </div>
            {selected.hint && (
              <div className="text-[12px] text-slate-600">{selected.hint}</div>
            )}
            {selected.attrs && selected.attrs.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {selected.attrs.map((a, i) => (
                  <Badge key={i} variant={a.tone ?? "slate"} mono={a.mono}>{a.label}</Badge>
                ))}
              </div>
            )}
            {selected.primaryAction && (
              <a
                href={selected.primaryAction.href}
                className="block text-center bg-amber-500 hover:bg-amber-600 text-white text-[12px] py-2 rounded-md transition-colors"
              >
                {selected.primaryAction.label}
              </a>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
