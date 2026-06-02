import type { StatusTone } from "@/components/ui/status-tag";

/**
 * Operator-language label map — the single place machine enums become Korean the
 * marketer actually reads. The audit's #1 systemic defect was raw code
 * identifiers as UI labels; every screen routes its enum→label through here.
 */

// ── Campaign status ─────────────────────────────────────────────────────────
export type CampaignStatus = "draft" | "running" | "paused" | "completed" | "cancelled";

const CAMPAIGN_STATUS_KO: Record<CampaignStatus, string> = {
  draft: "초안",
  running: "진행 중",
  paused: "일시정지",
  completed: "완료",
  cancelled: "취소",
};

const CAMPAIGN_STATUS_TONE: Record<CampaignStatus, StatusTone> = {
  draft: "neutral",
  running: "run",
  paused: "warn",
  completed: "ok",
  cancelled: "stop",
};

export function campaignStatus(status: string): { label: string; tone: StatusTone } {
  const s = status as CampaignStatus;
  return { label: CAMPAIGN_STATUS_KO[s] ?? status, tone: CAMPAIGN_STATUS_TONE[s] ?? "neutral" };
}

// ── Campaign stage (6-step loop) ────────────────────────────────────────────
export type CampaignStage =
  | "overview" | "sourcing" | "outreach" | "shipping" | "content_review" | "performance";

export const STAGE_ORDER: CampaignStage[] = [
  "overview", "sourcing", "outreach", "shipping", "content_review", "performance",
];

const STAGE_KO: Record<CampaignStage, string> = {
  overview: "개요",
  sourcing: "소싱",
  outreach: "아웃리치",
  shipping: "배송",
  content_review: "콘텐츠 검수",
  performance: "성과",
};

export function stageKo(stage: string): string {
  return STAGE_KO[stage as CampaignStage] ?? stage;
}

/** "3 · 아웃리치" style label with the 1-based step number. */
export function stageWithNumber(stage: string): string {
  const i = STAGE_ORDER.indexOf(stage as CampaignStage);
  return i >= 0 ? `${i + 1} · ${STAGE_KO[stage as CampaignStage]}` : stageKo(stage);
}

// ── Approval kinds ──────────────────────────────────────────────────────────
const APPROVAL_KIND_KO: Record<string, string> = {
  shortlist: "후보 리스트 승인",
  outreach_send: "아웃리치 발송",
  reply_response: "회신 응답",
  shipment: "배송 확인",
  content_review: "콘텐츠 검수",
  budget: "예산 승인",
  stage_advance: "단계 진행",
  payment_mandate: "결제 승인",
};

export function approvalKindKo(kind: string): string {
  return APPROVAL_KIND_KO[kind] ?? kind;
}

// ── Creator track state ─────────────────────────────────────────────────────
const TRACK_STATE_KO: Record<string, string> = {
  sourced: "선정됨",
  outreach_sent: "아웃리치 발송",
  in_conversation: "대화 중",
  agreed: "협의 완료",
  address_collected: "주소 확인",
  shipped: "샘플 발송",
  delivered: "수령",
  posted: "게시",
  verified: "검증 완료",
  no_response: "무응답",
  declined: "거절",
  flaked: "이탈",
};

const TRACK_STATE_TONE: Record<string, StatusTone> = {
  sourced: "neutral",
  outreach_sent: "run",
  in_conversation: "run",
  agreed: "ok",
  address_collected: "ok",
  shipped: "ok",
  delivered: "ok",
  posted: "ok",
  verified: "ok",
  no_response: "warn",
  declined: "stop",
  flaked: "stop",
};

export function trackState(state: string): { label: string; tone: StatusTone } {
  return { label: TRACK_STATE_KO[state] ?? state, tone: TRACK_STATE_TONE[state] ?? "neutral" };
}

// ── Activity-timeline span names → plain Korean ─────────────────────────────
// The audit flagged raw span names (workflow:brand-campaign, decision:approveShortlist)
// + OTel vocabulary as the operator-facing "what the agents did" record.
const SPAN_LABEL_KO: Array<[RegExp, string]> = [
  [/^workflow:brand-campaign/, "캠페인 워크플로우 시작"],
  [/^workflow:/, "워크플로우 시작"],
  [/^decision:approveShortlist/, "후보 리스트 승인"],
  [/^decision:approveOutreach/, "아웃리치 발송 승인"],
  [/^decision:/, "승인 결정"],
  [/^agent:sourcing/, "크리에이터 소싱"],
  [/^agent:vetting/, "후보 검증"],
  [/^agent:outreach/, "아웃리치 작성·발송"],
  [/^agent:conversation|^agent:responder/, "회신 처리"],
  [/^agent:logistics/, "배송 처리"],
  [/^agent:content[_-]?verify/, "콘텐츠 검증"],
  [/^agent:analyst|^agent:analytics/, "성과 분석"],
  [/^agent:/, "에이전트 작업"],
  [/^tool:tiktok/, "TikTok 조회"],
  [/^tool:gmail/, "메일 발송"],
  [/^tool:blacklist/, "블랙리스트 확인"],
  [/^tool:/, "도구 실행"],
];

export function spanLabelKo(name: string): string {
  for (const [re, label] of SPAN_LABEL_KO) if (re.test(name)) return label;
  return name;
}

// ── Autonomy gate labels (policies page) ────────────────────────────────────
const GATE_KO: Record<string, string> = {
  approveShortlist: "후보 리스트 확정",
  approveOutreachSend: "아웃리치 첫 발송",
  approveReplyResponse: "회신 자동 응답",
  approveShipment: "샘플 배송",
  approveStageAdvance: "단계 진행",
};

export function gateKo(gate: string): string {
  return GATE_KO[gate] ?? gate;
}
