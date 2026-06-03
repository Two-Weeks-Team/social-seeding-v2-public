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

// ── Lead (B2B) lifecycle ────────────────────────────────────────────────────
// A sales lead moves through import → 분석 → 조사 → 콜드메일 → 대화. The raw enum
// values (imported / enriching / researched …) leak agent internals, so every
// lead screen routes its stage through here.
const LEAD_STAGE_KO: Record<string, string> = {
  imported: "등록됨",
  enriching: "회사 분석 중",
  enriched: "회사 분석 완료",
  researching: "제안 준비 중",
  researched: "제안 준비 완료",
  outreach_sent: "콜드메일 발송",
  in_conversation: "대화 중",
  agreed: "협의 완료",
  declined: "거절",
  no_response: "무응답",
  flaked: "정보 부족",
};

const LEAD_STAGE_TONE: Record<string, StatusTone> = {
  imported: "neutral",
  enriching: "run",
  enriched: "run",
  researching: "run",
  researched: "run",
  outreach_sent: "run",
  in_conversation: "run",
  agreed: "ok",
  declined: "stop",
  no_response: "warn",
  flaked: "stop",
};

export function leadStage(stage: string): { label: string; tone: StatusTone } {
  return { label: LEAD_STAGE_KO[stage] ?? stage, tone: LEAD_STAGE_TONE[stage] ?? "neutral" };
}

// Lead-campaign lifecycle stages (narrower than brand-campaign's 6 steps).
const LEAD_CAMPAIGN_STAGE_KO: Record<string, string> = {
  overview: "개요",
  import: "회사 등록",
  research: "분석·제안 준비",
  outreach: "콜드메일",
  performance: "성과",
};

const LEAD_CAMPAIGN_STAGE_ORDER = ["overview", "import", "research", "outreach", "performance"];

export function leadCampaignStage(stage: string): string {
  return LEAD_CAMPAIGN_STAGE_KO[stage] ?? stage;
}

/** "2 · 회사 등록" style label with the 1-based step number. */
export function leadCampaignStageWithNumber(stage: string): string {
  const i = LEAD_CAMPAIGN_STAGE_ORDER.indexOf(stage);
  return i >= 0 ? `${i + 1} · ${LEAD_CAMPAIGN_STAGE_KO[stage]}` : leadCampaignStage(stage);
}

/** Sales priority (high/medium/low) → Korean + status tone. */
export function salesPriority(p: string): { label: string; tone: StatusTone } {
  if (p === "high") return { label: "우선순위 높음", tone: "ok" };
  if (p === "medium") return { label: "우선순위 중간", tone: "warn" };
  if (p === "low") return { label: "우선순위 낮음", tone: "neutral" };
  return { label: p, tone: "neutral" };
}

// ── Agent ids → plain Korean role names ──────────────────────────────────────
// The cost ledger stores each line under a bare agent id (sourcing,
// outreach-writer …). The usage dashboard routes those through here so the
// operator reads roles, never code identifiers.
const AGENT_KO: Record<string, string> = {
  intake: "브리프 정리",
  research: "브랜드 리서치",
  sourcing: "크리에이터 소싱",
  vetting: "후보 검증",
  "outreach-writer": "아웃리치 작성",
  "lead-outreach-writer": "리드 아웃리치 작성",
  conversation: "회신 처리",
  "conversation-responder": "회신 응답",
  logistics: "배송 처리",
  "content-verify": "콘텐츠 검증",
  analyst: "성과 분석",
};

export function agentKo(agent: string): string {
  return AGENT_KO[agent] ?? "에이전트 작업";
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
