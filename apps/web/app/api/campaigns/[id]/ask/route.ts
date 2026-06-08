import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { campaignAssistantAgent, runAgent, type AgentRunContext } from "@ss/agents";
import { AnalyticsReportSchema, type AnalyticsReport } from "@ss/contracts";
import { invokeCapability } from "@ss/capabilities";
import { campaignRepo, messageRepo } from "@ss/db";
import { startTrace } from "@ss/observability";
import { getSessionOr401 } from "@/lib/auth";
import { resolveCreators } from "@/lib/creators";
import { stageKo, campaignStatus } from "@/lib/labels";

/**
 * POST /api/campaigns/[id]/ask — the campaign "Ask the agent" assistant.
 * Read-only Q&A grounded in a preloaded campaign snapshot + the agent's read
 * tools (analytics.compile, tiktok.getCreator). Mirrors the intake SSE route's
 * request/response shape. Demo sessions are allowed (read-only, no mutations).
 * Needs Gemini at runtime (Vertex `global` / GEMINI_API_KEY) → 503 if absent.
 */
export const runtime = "nodejs";

const Body = z.object({
  question: z.string().min(1).max(500),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(2000) }))
    .max(10)
    .default([]),
});

function fmtDate(d: Date | string | number | undefined): string {
  if (!d) return "—";
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime())
    ? "—"
    : dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getSessionOr401(req);
  if (!auth.ok) return auth.response;
  const { session } = auth;
  const { id } = await params;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", details: parsed.error.flatten() }, { status: 400 });
  }

  const campaign = await campaignRepo.get(id);
  if (!campaign || campaign.brief.workspaceId !== session.workspaceId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const cctx = { workspaceId: session.workspaceId, userId: session.userId, rateLimitClass: "default" as const };

  // ── Preload a compact campaign snapshot from real data ──────────────────────
  const a: AnalyticsReport | null = await invokeCapability("analytics.compile", { campaignId: id }, cctx)
    .then((raw) => AnalyticsReportSchema.parse(raw))
    .catch(() => null);
  const profiles = await resolveCreators(campaign.tracks.map((t) => t.creatorId));
  const threads = await messageRepo.threadsByCampaign(id, session.workspaceId).catch(() => []);
  const awaiting = threads.filter((t) => t.lastDirection === "inbound").length;

  const handleOf = (creatorId: string) => profiles.get(creatorId)?.handle ?? creatorId;
  const creatorLines = a
    ? [...a.tracks]
        .sort((x, y) => (y.views ?? 0) - (x.views ?? 0))
        .slice(0, 10)
        .map((t) => `- ${handleOf(t.creatorId)} · ${t.state}${t.views != null ? ` · ${t.views.toLocaleString()} views` : ""}${t.performanceScore != null ? ` · score ${t.performanceScore}` : ""}`)
    : campaign.tracks.slice(0, 10).map((t) => `- ${handleOf(t.creatorId)} · ${t.state}`);

  const er = a?.reach.weightedEngagementRate ?? null;
  const context = [
    `Brand/product: ${campaign.brief.brandProduct.name} (${campaign.brief.brandProduct.category})`,
    `Description: ${campaign.brief.brandProduct.description}`,
    `Status: ${campaignStatus(campaign.status).label} · current stage: ${stageKo(campaign.stage)}`,
    `Goals: ${campaign.brief.goals.targetLivePosts} posts · deadline ${fmtDate(campaign.brief.goals.deadline)} · budget ${campaign.brief.goals.budgetUsd != null ? `$${campaign.brief.goals.budgetUsd}` : "—"}`,
    `Targeting: ${campaign.brief.targeting.creatorCount} creators · minimum engagement rate ${(campaign.brief.targeting.minEngagementRate * 100).toFixed(1)}%`,
    a
      ? `Performance summary: verified ${a.goals.verifiedCount}/${a.goals.targetLivePosts} (${a.goals.percentOfGoal !== null ? Math.round(a.goals.percentOfGoal * 100) + "%" : "n/a"} of goal) · total views ${a.reach.verifiedViews.toLocaleString()} · average engagement rate ${er !== null ? (er * 100).toFixed(1) + "%" : "n/a"}`
      : "Performance summary: none yet",
    a
      ? `Funnel: outreach ${a.funnel.outreach_sent} · in conversation ${a.funnel.in_conversation} · shipped ${a.funnel.shipped} · delivered ${a.funnel.delivered} · posted ${a.funnel.posted} · verified ${a.funnel.verified}`
      : "",
    `Email threads: ${threads.length} · waiting for replies ${awaiting}`,
    `Target creators (${campaign.tracks.length}):`,
    ...creatorLines,
  ]
    .filter(Boolean)
    .join("\n");

  const trace = startTrace(id, `ask-${id}-${Date.now()}`);
  const ctx: AgentRunContext = { capabilityCtx: cctx, trace };

  try {
    const outcome = await runAgent(
      campaignAssistantAgent,
      { campaignId: id, question: parsed.data.question, history: parsed.data.history, context },
      ctx,
    );
    if (outcome.kind === "escalate") {
      return NextResponse.json({ error: "escalate", reason: outcome.reason }, { status: 422 });
    }
    return NextResponse.json(outcome.value);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/GEMINI_API_KEY|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_CLOUD_PROJECT|permission|credit|quota|429|403/i.test(msg)) {
      return NextResponse.json(
        { error: "assistant_unavailable", reason: "The assistant LLM is currently unavailable because Gemini authentication or quota is unavailable. Try again shortly." },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: "assistant_failed", reason: msg.slice(0, 200) }, { status: 500 });
  }
}
