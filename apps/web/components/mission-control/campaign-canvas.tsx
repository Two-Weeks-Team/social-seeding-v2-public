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
import { cn } from "@/lib/cn";
import type { CampaignStage } from "@ss/contracts";
import {
  bucketTracksByState,
  type TrackStateBuckets,
} from "./campaign-track-buckets";

export { bucketTracksByState };
export type { TrackStateBuckets };

/**
 * Campaign canvas (C2 redesign) — the brand-campaign workflow as a typed node
 * graph. Operator-language node labels (no model/function names leaked); C2
 * espresso/champagne styling. The previous screen-fixed StageLanes overlay was
 * removed: it positioned lane labels in raw px outside React Flow's transform,
 * so after fitView they drifted and overlapped the property panel/headers (the
 * audit's canvas overlap bug). Node x-positions still encode the 6-stage order.
 */

type Tone = "neutral" | "run" | "ok" | "warn" | "stop" | "brand";
type Status = "done" | "running" | "waiting" | "pending" | "errored";

interface SsNodeData extends Record<string, unknown> {
  label: string;
  kind: "brief" | "agent" | "tool" | "gate" | "wait" | "group";
  status: Status;
  tone: Tone;
  hint?: string;
  detail?: string;
  primaryAction?: { label: string; href: string };
}

const KIND_KO: Record<SsNodeData["kind"], string> = {
  brief: "브리프",
  agent: "에이전트",
  tool: "도구",
  gate: "승인 게이트",
  wait: "대기",
  group: "병렬 처리",
};

const STATUS_KO: Record<Status, string> = {
  done: "완료",
  running: "진행 중",
  waiting: "대기 중",
  pending: "예정",
  errored: "오류",
};

const TONE_BORDER: Record<Tone, string> = {
  neutral: "border-l-ink-3",
  run: "border-l-run",
  ok: "border-l-ok",
  warn: "border-l-warn",
  stop: "border-l-stop",
  brand: "border-l-brand-ink",
};

const STATUS_DOT: Record<Status, string> = {
  done: "bg-ok",
  running: "bg-run animate-pulse",
  waiting: "bg-warn animate-pulse",
  pending: "bg-line",
  errored: "bg-stop",
};

const STATUS_TEXT: Record<Status, string> = {
  done: "text-ok",
  running: "text-run",
  waiting: "text-warn",
  pending: "text-ink-3",
  errored: "text-stop",
};

function SsNode({ data, selected }: NodeProps<Node<SsNodeData>>) {
  const isFuture = data.status === "pending";
  return (
    <div
      className={cn(
        "relative bg-surface border border-line rounded-xl shadow-soft border-l-4 transition-transform",
        TONE_BORDER[data.tone],
        data.kind === "gate" && "bg-warn-bg",
        data.kind === "wait" && "bg-surface-2 border-dashed",
        isFuture && "opacity-45",
        selected && "ring-2 ring-brand-ink ring-offset-2",
      )}
      style={{ width: "100%", height: "100%", padding: "11px 13px" }}
    >
      <Handle type="target" position={Position.Left} style={{ background: "transparent", border: 0 }} />
      <div className="absolute top-2.5 right-2.5">
        <span className={cn("inline-block w-1.5 h-1.5 rounded-full", STATUS_DOT[data.status])} />
      </div>
      <div className="text-[10px] uppercase tracking-[0.05em] text-ink-3 font-semibold">{KIND_KO[data.kind]}</div>
      <div className="mt-1 text-[13px] font-bold leading-tight text-ink">{data.label}</div>
      {data.hint && <div className="mt-1.5 text-[10.5px] text-ink-3 leading-snug">{data.hint}</div>}
      <Handle type="source" position={Position.Right} style={{ background: "transparent", border: 0 }} />
    </div>
  );
}

const nodeTypes = { ssNode: SsNode };

interface BuildArgs {
  stage: CampaignStage;
  brandName: string;
  targetCreatorCount: number;
  vetCount: number;
  budgetCapUsd: number;
  shortlistCount?: number;
  shortlistGateApprovalId?: string;
  trackCount: number;
  trackBuckets?: TrackStateBuckets;
}

function buildGraph(a: BuildArgs): { nodes: Node<SsNodeData>[]; edges: Edge[] } {
  const order: CampaignStage[] = ["overview", "sourcing", "outreach", "shipping", "content_review", "performance"];
  const passed = (s: CampaignStage): boolean => order.indexOf(a.stage) > order.indexOf(s);
  const isCurrent = (s: CampaignStage): boolean => a.stage === s;
  const stageStatus = (s: CampaignStage): Status => (passed(s) ? "done" : isCurrent(s) ? "running" : "pending");

  const sourcingStatus: Status = passed("sourcing") ? "done" : isCurrent("sourcing") ? (a.shortlistGateApprovalId ? "done" : "running") : "pending";
  const vetGroupStatus: Status = sourcingStatus === "done" ? "done" : isCurrent("sourcing") ? "running" : "pending";
  const shortlistStatus: Status = a.shortlistGateApprovalId ? "done" : isCurrent("sourcing") && passed("overview") ? "running" : "pending";
  const gateStatus: Status = a.shortlistGateApprovalId ? "waiting" : a.trackCount > 0 ? "done" : "pending";

  const buckets = a.trackBuckets;
  const liveTracks = buckets ? buckets.outreach_sent + buckets.in_conversation : 0;
  const terminalTracks = buckets ? buckets.agreed + buckets.declined + buckets.no_response + buckets.flaked : 0;
  const outreachStarted = a.trackCount > 0 && (liveTracks > 0 || terminalTracks > 0);
  const outreachAllTerminal = a.trackCount > 0 && terminalTracks === a.trackCount;
  const outreachStatus: Status = isCurrent("outreach")
    ? outreachAllTerminal ? "done" : a.trackCount > 0 ? "running" : "pending"
    : passed("outreach") ? "done" : "pending";
  const waitStatus: Status = isCurrent("outreach") && buckets && buckets.outreach_sent > 0 ? "waiting" : outreachStatus;

  const nodes: Node<SsNodeData>[] = [
    {
      id: "brief", position: { x: 16, y: 180 }, type: "ssNode",
      data: { label: a.brandName, kind: "brief", tone: "neutral", status: passed("overview") ? "done" : "running", hint: `크리에이터 ${a.targetCreatorCount}명 · 예산 $${a.budgetCapUsd}` },
    },
    {
      id: "sourcing", position: { x: 220, y: 180 }, type: "ssNode",
      data: { label: "크리에이터 소싱", kind: "agent", tone: "brand", status: sourcingStatus, hint: "TikTok 후보 검색 · 블랙리스트 확인" },
    },
    {
      id: "vetting", position: { x: 440, y: 270 }, type: "ssNode",
      data: { label: "후보 검증", kind: "group", tone: "brand", status: vetGroupStatus, hint: a.vetCount > 0 ? `${a.vetCount}명 평가` : "후보별 병렬 평가" },
    },
    {
      id: "shortlist", position: { x: 520, y: 180 }, type: "ssNode",
      data: { label: "후보 선정", kind: "tool", tone: "neutral", status: shortlistStatus, hint: a.shortlistCount ? `${a.shortlistCount}명 추천` : undefined },
    },
    {
      id: "gate-shortlist", position: { x: 720, y: 180 }, type: "ssNode",
      data: {
        label: "후보 리스트 승인", kind: "gate", tone: "warn", status: gateStatus,
        hint: a.shortlistGateApprovalId ? "사람 검토 대기" : a.trackCount > 0 ? `${a.trackCount}명 확정` : "정책 게이트",
        ...(a.shortlistGateApprovalId ? { primaryAction: { label: "검토하러 가기 →", href: `/approvals/${a.shortlistGateApprovalId}` } } : {}),
      },
    },
    {
      id: "outreach", position: { x: 960, y: 200 }, type: "ssNode",
      data: {
        label: "아웃리치 작성·발송", kind: "agent", tone: "brand", status: outreachStatus,
        hint: outreachStarted ? `진행 ${liveTracks}명 · 종료 ${terminalTracks}명` : buckets ? `${a.trackCount}명 대기` : "메일 발송",
      },
    },
    {
      id: "wait-reply", position: { x: 960, y: 320 }, type: "ssNode",
      data: { label: "회신 대기 · 3일", kind: "wait", tone: "neutral", status: waitStatus, hint: buckets && buckets.outreach_sent > 0 ? `${buckets.outreach_sent}명 응답 대기` : "응답 이벤트 대기" },
    },
    {
      id: "shipping", position: { x: 1160, y: 200 }, type: "ssNode",
      data: {
        label: "배송 처리", kind: "agent", tone: "brand",
        status: buckets
          ? buckets.shipped + buckets.delivered + buckets.address_collected > 0
            ? buckets.delivered + buckets.posted + buckets.verified + buckets.flaked >= a.trackCount ? "done" : "running"
            : isCurrent("shipping") ? "running" : "pending"
          : stageStatus("shipping"),
        hint: buckets ? `발송 중 ${buckets.address_collected + buckets.shipped}명 · 수령 ${buckets.delivered}명` : "샘플 발송",
      },
    },
    {
      id: "content", position: { x: 1360, y: 200 }, type: "ssNode",
      data: {
        label: "콘텐츠 검증", kind: "agent", tone: "brand",
        status: buckets
          ? buckets.verified + buckets.posted > 0 || buckets.flaked > 0
            ? buckets.delivered === 0 && buckets.shipped === 0 ? "done" : "running"
            : buckets.delivered > 0 ? "waiting" : "pending"
          : stageStatus("content_review"),
        hint: buckets ? (buckets.delivered > 0 ? `수령 ${buckets.delivered}명 · 게시 대기` : `검증 ${buckets.verified}명 · 이탈 ${buckets.flaked}명`) : "콘텐츠 검토 예정",
      },
    },
  ];

  const edges: Edge[] = [
    edge("brief", "sourcing", sourcingStatus !== "pending"),
    edge("sourcing", "vetting", vetGroupStatus !== "pending"),
    edge("vetting", "shortlist", shortlistStatus !== "pending"),
    edge("shortlist", "gate-shortlist", gateStatus !== "pending"),
    edge("gate-shortlist", "outreach", a.trackCount > 0),
    edge("outreach", "wait-reply", outreachStatus !== "pending"),
    edge("outreach", "shipping", buckets ? buckets.address_collected + buckets.shipped + buckets.delivered + buckets.verified + buckets.flaked > 0 : false),
    edge("shipping", "content", buckets ? buckets.delivered + buckets.verified + buckets.flaked > 0 : false),
  ];

  // Provide explicit dimensions so React Flow treats nodes as already-measured.
  // Without this, RF v12 can leave nodes `visibility:hidden` (measurement never
  // registers under dev StrictMode / flex mount timing) and fitView never runs —
  // the canvas renders blank. Fixed dims also give the pipeline uniform cards.
  const sized = nodes.map((n) => ({
    ...n,
    width: 184,
    height: 88,
    // `measured` is what fitView / getNodesBounds read; set it so the viewport
    // fits even when RF's ResizeObserver hasn't run (dev StrictMode / mount race).
    measured: { width: 184, height: 88 },
  }));
  return { nodes: sized, edges };
}

function edge(source: string, target: string, active: boolean): Edge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    type: "default",
    style: { stroke: active ? "#2a241c" : "#e6dfce", strokeWidth: active ? 1.5 : 1 },
  };
}

export interface CampaignCanvasProps {
  stage: CampaignStage;
  brandName: string;
  targetCreatorCount: number;
  vetCount: number;
  budgetCapUsd: number;
  shortlistCount?: number;
  shortlistGateApprovalId?: string;
  trackCount: number;
  trackBuckets?: TrackStateBuckets;
}

export function CampaignCanvas(props: CampaignCanvasProps) {
  const [selected, setSelected] = useState<SsNodeData | null>(null);
  const { nodes, edges } = useMemo(() => buildGraph(props), [props]);

  return (
    <div className="relative flex h-[680px] border border-line rounded-2xl overflow-hidden bg-surface shadow-soft">
      <div className="flex-1 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.15, minZoom: 0.4, maxZoom: 1.1 }}
          minZoom={0.35}
          maxZoom={1.6}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
          onNodeClick={(_e, node) => setSelected(node.data as SsNodeData)}
          onPaneClick={() => setSelected(null)}
          defaultEdgeOptions={{ animated: false }}
        >
          <Background gap={16} size={1} color="#e6dfce" />
          <Controls showInteractive={false} position="bottom-left" style={{ background: "var(--color-surface)", border: "1px solid var(--color-line)", borderRadius: 10 }} />
        </ReactFlow>
      </div>

      <aside className="w-72 border-l border-line bg-surface overflow-y-auto shrink-0">
        {!selected ? (
          <div className="p-5 text-[12.5px] text-ink-3">노드를 누르면 세부 정보가 여기에 표시됩니다.</div>
        ) : (
          <div className="p-5 space-y-3">
            <div>
              <div className="text-[10px] uppercase tracking-[0.05em] text-ink-3 font-semibold">선택한 단계</div>
              <div className="mt-1.5 text-[16px] font-bold text-ink">{selected.label}</div>
              <div className="mt-0.5 text-[11.5px] text-ink-3">{KIND_KO[selected.kind]}</div>
            </div>
            <div className="text-[12.5px]">
              <span className="text-ink-2">상태 </span>
              <span className={cn("font-semibold", STATUS_TEXT[selected.status])}>{STATUS_KO[selected.status]}</span>
            </div>
            {selected.hint && <div className="text-[12.5px] text-ink-2">{selected.hint}</div>}
            {selected.primaryAction && (
              <a href={selected.primaryAction.href} className="block text-center bg-brand hover:bg-brand-2 text-white text-[12.5px] font-semibold py-2 rounded-xl transition-colors shadow-brand">
                {selected.primaryAction.label}
              </a>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
