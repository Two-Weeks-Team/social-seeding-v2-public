import type { StatusTone } from "@/components/ui/status-tag";

/**
 * Operator-language label map — the single place machine enums become English the
 * marketer actually reads. The audit's #1 systemic defect was raw code
 * identifiers as UI labels; every screen routes its enum→label through here.
 */

// ── Campaign status ─────────────────────────────────────────────────────────
export type CampaignStatus = "draft" | "running" | "paused" | "completed" | "cancelled";

const CAMPAIGN_STATUS_KO: Record<CampaignStatus, string> = {
  draft: "Draft",
  running: "Running",
  paused: "Paused",
  completed: "Complete",
  cancelled: "Cancelled",
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
  overview: "Overview",
  sourcing: "Sourcing",
  outreach: "Outreach",
  shipping: "Shipping",
  content_review: "Content review",
  performance: "Performance",
};

export function stageKo(stage: string): string {
  return STAGE_KO[stage as CampaignStage] ?? stage;
}

/** "3 · Outreach" style label with the 1-based step number. */
export function stageWithNumber(stage: string): string {
  const i = STAGE_ORDER.indexOf(stage as CampaignStage);
  return i >= 0 ? `${i + 1} · ${STAGE_KO[stage as CampaignStage]}` : stageKo(stage);
}

// ── Approval kinds ──────────────────────────────────────────────────────────
const APPROVAL_KIND_KO: Record<string, string> = {
  shortlist: "Shortlist approval",
  outreach_send: "Outreach send",
  reply_response: "Reply response",
  shipment: "Shipment confirmation",
  content_review: "Content review",
  budget: "Budget approval",
  stage_advance: "Stage advance",
  payment_mandate: "Payment approval",
};

export function approvalKindKo(kind: string): string {
  return APPROVAL_KIND_KO[kind] ?? kind;
}

// ── Creator track state ─────────────────────────────────────────────────────
const TRACK_STATE_KO: Record<string, string> = {
  sourced: "Sourced",
  outreach_sent: "Outreach sent",
  in_conversation: "In conversation",
  agreed: "Agreed",
  address_collected: "Address collected",
  shipped: "Sample shipped",
  delivered: "Delivered",
  posted: "Posted",
  verified: "Verified",
  no_response: "No response",
  declined: "Declined",
  flaked: "Dropped",
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

// ── Activity-timeline span names → plain English ────────────────────────────
// The audit flagged raw span names (workflow:brand-campaign, decision:approveShortlist)
// + OTel vocabulary as the operator-facing "what the agents did" record.
const SPAN_LABEL_KO: Array<[RegExp, string]> = [
  [/^workflow:brand-campaign/, "Campaign workflow started"],
  [/^workflow:/, "Workflow started"],
  [/^decision:approveShortlist/, "Shortlist approved"],
  [/^decision:approveOutreach/, "Outreach send approved"],
  [/^decision:/, "Approval decision"],
  [/^agent:sourcing/, "Creator sourcing"],
  [/^agent:vetting/, "Candidate vetting"],
  [/^agent:outreach/, "Outreach draft/send"],
  [/^agent:conversation|^agent:responder/, "Reply handling"],
  [/^agent:logistics/, "Shipment handling"],
  [/^agent:content[_-]?verify/, "Content verification"],
  [/^agent:analyst|^agent:analytics/, "Performance analysis"],
  [/^agent:/, "Agent task"],
  [/^tool:tiktok/, "TikTok lookup"],
  [/^tool:gmail/, "Email sent"],
  [/^tool:blacklist/, "Blacklist check"],
  [/^tool:/, "Tool run"],
];

export function spanLabelKo(name: string): string {
  for (const [re, label] of SPAN_LABEL_KO) if (re.test(name)) return label;
  return name;
}

// ── Lead (B2B) lifecycle ────────────────────────────────────────────────────
// A sales lead moves through import → enrichment → research → cold email → conversation. The raw enum
// values (imported / enriching / researched …) leak agent internals, so every
// lead screen routes its stage through here.
const LEAD_STAGE_KO: Record<string, string> = {
  imported: "Imported",
  enriching: "Enriching company",
  enriched: "Company enriched",
  researching: "Preparing proposal",
  researched: "Proposal ready",
  outreach_sent: "Cold email sent",
  in_conversation: "In conversation",
  agreed: "Agreed",
  declined: "Declined",
  no_response: "No response",
  flaked: "Missing info",
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
  overview: "Overview",
  import: "Company import",
  research: "Analysis & proposal prep",
  outreach: "Cold email",
  performance: "Performance",
};

const LEAD_CAMPAIGN_STAGE_ORDER = ["overview", "import", "research", "outreach", "performance"];

export function leadCampaignStage(stage: string): string {
  return LEAD_CAMPAIGN_STAGE_KO[stage] ?? stage;
}

/** "2 · Company import" style label with the 1-based step number. */
export function leadCampaignStageWithNumber(stage: string): string {
  const i = LEAD_CAMPAIGN_STAGE_ORDER.indexOf(stage);
  return i >= 0 ? `${i + 1} · ${LEAD_CAMPAIGN_STAGE_KO[stage]}` : leadCampaignStage(stage);
}

/** Sales priority (high/medium/low) → English + status tone. */
export function salesPriority(p: string): { label: string; tone: StatusTone } {
  if (p === "high") return { label: "High priority", tone: "ok" };
  if (p === "medium") return { label: "Medium priority", tone: "warn" };
  if (p === "low") return { label: "Low priority", tone: "neutral" };
  return { label: p, tone: "neutral" };
}

// ── Agent ids → plain Korean role names ──────────────────────────────────────
// The cost ledger stores each line under a bare agent id (sourcing,
// outreach-writer …). The usage dashboard routes those through here so the
// operator reads roles, never code identifiers.
const AGENT_KO: Record<string, string> = {
  intake: "Brief intake",
  research: "Brand research",
  sourcing: "Creator sourcing",
  vetting: "Candidate vetting",
  "outreach-writer": "Outreach writing",
  "lead-outreach-writer": "Lead outreach writing",
  conversation: "Reply handling",
  "conversation-responder": "Reply response",
  logistics: "Shipment handling",
  "content-verify": "Content verification",
  analyst: "Performance analysis",
};

export function agentKo(agent: string): string {
  return AGENT_KO[agent] ?? "Agent task";
}

// ── Reply classification (email thread / responder) ─────────────────────────
const REPLY_CLASS_KO: Record<string, { label: string; tone: StatusTone }> = {
  interested: { label: "Interested", tone: "ok" },
  needs_info: { label: "Needs info", tone: "run" },
  negotiating: { label: "Negotiating", tone: "warn" },
  not_now: { label: "Not now", tone: "neutral" },
  declined: { label: "Declined", tone: "stop" },
  out_of_office: { label: "Out of office", tone: "neutral" },
  unsubscribe: { label: "Unsubscribed", tone: "stop" },
  unrelated: { label: "Unrelated", tone: "neutral" },
};

export function replyClass(c: string): { label: string; tone: StatusTone } {
  return REPLY_CLASS_KO[c] ?? { label: c, tone: "neutral" };
}

// ── Autonomy gate labels (policies page) ────────────────────────────────────
const GATE_KO: Record<string, string> = {
  approveShortlist: "Finalize shortlist",
  approveOutreachSend: "First outreach send",
  approveReplyResponse: "Auto reply response",
  approveShipment: "Sample shipment",
  approveStageAdvance: "Stage advance",
};

export function gateKo(gate: string): string {
  return GATE_KO[gate] ?? gate;
}
