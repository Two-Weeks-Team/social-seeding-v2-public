import type { z } from "zod";
import type { CapabilityContext } from "@ss/capabilities";
import type { RunTrace } from "@ss/observability";

/**
 * Agent runtime — the one place LLMs are called. An agent is NOT a free-roaming
 * ReAct loop: it's a *function* the deterministic Inngest workflow invokes for a
 * judgment-heavy sub-task, with a curated tool set, a structured output
 * contract, a token/cost budget, and an escalation policy. (This generalizes
 * v1's `lib/cold-mail` evaluator-optimizer + tournament/judges pattern, which is
 * already the right shape.)
 *
 * Implementation note: wraps the Claude Agent SDK. Model routing —
 *   Opus 4.7  → orchestration-adjacent judgment (sourcing strategy, reply triage)
 *   Haiku 4.5 → high-volume extraction/classification
 * — keeps cost down. Falls back to the raw Anthropic SDK / Vercel AI SDK.
 */
export interface AgentDef<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  id: string;
  description: string;
  /** dotted capability names this agent may call */
  tools: string[];
  input: I;
  output: O;
  model: "claude-opus-4-7" | "claude-haiku-4-5";
  /** absolute USD cap for one invocation; the runtime aborts if exceeded */
  maxUsd: number;
  /** when the agent decides it can't proceed safely, it returns this instead of `output` */
  systemPrompt: (input: z.infer<I>) => string;
}

export interface AgentRunContext {
  capabilityCtx: CapabilityContext;
  trace: RunTrace;
}

export type AgentOutcome<O extends z.ZodTypeAny> =
  | { kind: "ok"; value: z.infer<O>; usd: number }
  | { kind: "escalate"; reason: string; partial?: unknown; usd: number };

export async function runAgent<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  _def: AgentDef<I, O>,
  _input: z.infer<I>,
  _ctx: AgentRunContext,
): Promise<AgentOutcome<O>> {
  // TODO(phase-0): implement on Claude Agent SDK —
  //   1. resolve _def.tools → capability schemas → SDK tool definitions
  //   2. enforce budget via @ss/observability assertWithinBudget + recordCost
  //   3. wrap every tool call + LLM call in _ctx.trace.span(...)
  //   4. parse final message against _def.output; on parse failure run one
  //      reviser pass (the cold-mail loop); after that → { kind: "escalate" }
  throw new Error("runAgent not implemented — see docs/PHASE-1-PLAN.md task P0-3");
}

export function defineAgent<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(def: AgentDef<I, O>): AgentDef<I, O> {
  return def;
}
