import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { intakeAgent, runAgent, type AgentRunContext } from "@ss/agents";
import { startTrace } from "@ss/observability";
import { denyIfDemo, getSessionOr401 } from "@/lib/auth";

/**
 * W2 — A-intake conversation endpoint (request/response, one deliberation
 * step per call). The caller (Chunk 4 chat UI — Phase 2 polish) maintains
 * the message history and re-POSTs after each user reply until status="done".
 *
 * Response shape mirrors intakeAgent.output exactly. On agent escalation
 * (irreducible disagreement / parse failure), returns 422 with the reason.
 *
 * This route needs GEMINI_API_KEY at runtime — the agent's defaultModelClient
 * is what makes the actual LLM call. No key → the agent's seam still loads,
 * but the first complete() throws and we surface a 503.
 */

const Body = z.object({
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1),
  })).min(1).max(20),
});

export async function POST(req: NextRequest) {
  const auth = await getSessionOr401(req);
  if (!auth.ok) return auth.response;
  const { session } = auth;
  const denied = denyIfDemo(session);
  if (denied) return denied;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", details: parsed.error.flatten() }, { status: 400 });
  }

  const trace = startTrace(`intake-${session.workspaceId}-${Date.now()}`);
  const ctx: AgentRunContext = {
    capabilityCtx: { workspaceId: session.workspaceId, userId: session.userId, rateLimitClass: "default" },
    trace,
  };

  try {
    const outcome = await runAgent(
      intakeAgent,
      { messages: parsed.data.messages, workspaceId: session.workspaceId, createdBy: session.userId },
      ctx,
    );
    if (outcome.kind === "escalate") {
      return NextResponse.json({ status: "escalate", reason: outcome.reason }, { status: 422 });
    }
    return NextResponse.json(outcome.value);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("GEMINI_API_KEY")) {
      return NextResponse.json(
        { error: "intake_unavailable", reason: "GEMINI_API_KEY 가 설정되지 않아 대화형 intake 가 비활성화 상태입니다. /campaigns/new 의 manual form 을 사용해주세요." },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: "intake_failed", reason: msg }, { status: 500 });
  }
}
