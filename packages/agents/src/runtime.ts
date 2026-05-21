import type { z } from "zod";
import type { CapabilityContext } from "@ss/capabilities";
import { getCapability, invokeCapability } from "@ss/capabilities";
import type { RunTrace } from "@ss/observability";
import { assertWithinBudget, recordCost } from "@ss/observability";
import {
  defaultModelClient,
  estimateUsd,
  type ModelClient,
  type ModelId,
  type ModelMessage,
  type ModelToolSpec,
} from "./model";

/**
 * Agent runtime — the one place LLMs are called. An agent is NOT a free-roaming
 * ReAct loop: it's a *function* the deterministic Inngest workflow invokes for a
 * judgment-heavy sub-task, with a curated tool set, a structured output
 * contract, a token/cost budget, and an escalation policy. (This generalizes
 * v1's `lib/cold-mail` evaluator-optimizer + tournament/judges pattern, which is
 * already the right shape — note its reviser loop, mirrored below.)
 *
 * The LLM call goes through an injectable `ModelClient` (`ctx.model`), so tests
 * run with no API key and a different provider is a one-file swap (see
 * `model.ts`). Model routing — Gemini 3.5 Flash for judgment, Gemini 3.1
 * Flash-Lite for bulk — comes from `def.model`.
 */
export interface AgentDef<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  id: string;
  description: string;
  /** dotted capability names this agent may call */
  tools: string[];
  input: I;
  output: O;
  model: ModelId;
  /** absolute USD cap for one invocation; the runtime aborts (escalates) if exceeded */
  maxUsd: number;
  /** the agent's prompt; the runtime appends the output-contract instructions */
  systemPrompt: (input: z.infer<I>) => string;
}

export interface AgentRunContext {
  capabilityCtx: CapabilityContext;
  trace: RunTrace;
  /** injected in tests / for alternate providers; defaults to the Gemini-backed client */
  model?: ModelClient;
  /** when set, runAgent calls assertWithinBudget(trace.campaignId, this) before the first LLM call */
  campaignBudgetUsd?: number;
}

export type AgentOutcome<O extends z.ZodTypeAny> =
  | { kind: "ok"; value: z.infer<O>; usd: number }
  | { kind: "escalate"; reason: string; partial?: unknown; usd: number };

const MAX_MODEL_TURNS = 8;
const MAX_OUTPUT_TOKENS = 4096;

export async function runAgent<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  def: AgentDef<I, O>,
  input: z.infer<I>,
  ctx: AgentRunContext,
): Promise<AgentOutcome<O>> {
  const model = ctx.model ?? defaultModelClient();
  const campaignId = ctx.trace.campaignId;

  if (ctx.campaignBudgetUsd !== undefined) {
    // throws BudgetExceededError → aborts the run (the orchestrator's hard cap)
    await assertWithinBudget(campaignId, ctx.campaignBudgetUsd);
  }

  return ctx.trace.span(`agent:${def.id}`, "agent", { model: def.model, maxUsd: def.maxUsd }, async () => {
    let usd = 0;
    const toolSpecs: ModelToolSpec[] = def.tools.map((name) => {
      // permissive JSON Schema on purpose — invokeCapability re-validates with the
      // real Zod schema, and a bad shape comes back to the model as a tool error.
      const cap = getCapability(name);
      return { name, description: cap.description, inputSchema: { type: "object", additionalProperties: true } };
    });
    const system = buildSystemPrompt(def, input);
    const messages: ModelMessage[] = [{ role: "user", content: "Begin." }];

    /**
     * Tracks whether the agent has produced ANY tool call yet on this run.
     * On the FIRST turn — when tools are present + nothing has been called
     * yet — we set `tool_choice: any` so Gemini 3.5 Flash emits a native tool_use
     * block instead of pseudo-tool-calling via text. Once the model has
     * called at least one tool (or made it past the first turn), we drop
     * back to `auto` so it can produce the final text answer.
     * Live-demo lesson 2026-05-14: without this, Gemini 3.5 Flash with long
     * system prompts sometimes "thinks out loud" by writing
     * `[calling tool X: {...}]` as text content, which the runtime then
     * tries to parse as the agent's final output → escalate.
     */
    let hasCalledATool = false;
    const callModel = async (): Promise<
      { kind: "text"; text: string } | { kind: "tool_use"; toolName: string; toolInput: unknown }
    > => {
      const forceTool = !hasCalledATool && toolSpecs.length > 0;
      const turn = await ctx.trace.span(`llm:${def.model}`, "llm", { agent: def.id }, async (span) => {
        const t = await model.complete({
          model: def.model, system, messages, tools: toolSpecs,
          maxTokens: MAX_OUTPUT_TOKENS,
          ...(forceTool ? { toolChoice: "any" as const } : {}),
        });
        const callUsd = estimateUsd(def.model, t.inputTokens, t.outputTokens);
        usd += callUsd;
        span.attrs.inputTokens = t.inputTokens;
        span.attrs.outputTokens = t.outputTokens;
        span.attrs.usd = Number(callUsd.toFixed(6));
        try {
          await recordCost({
            campaignId,
            workspaceId: ctx.capabilityCtx.workspaceId,
            agent: def.id,
            model: def.model,
            inputTokens: t.inputTokens,
            outputTokens: t.outputTokens,
            usd: callUsd,
            at: Date.now(),
          });
        } catch (err) {
          // cost recording is observability, not load-bearing — a sink hiccup must not fail the agent's work
          console.warn(`[runAgent] recordCost failed for ${def.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
        return t;
      });
      return turn.kind === "tool_use"
        ? { kind: "tool_use", toolName: turn.toolName, toolInput: turn.toolInput }
        : { kind: "text", text: turn.text };
    };

    const overCap = (): AgentOutcome<O> => ({
      kind: "escalate",
      reason: `agent ${def.id} exceeded its $${def.maxUsd} cap (spent $${usd.toFixed(4)})`,
      usd,
    });

    // ── tool loop ──────────────────────────────────────────────────────────
    /**
     * The model is text-only (ModelClient deliberately doesn't expose the
     * provider's native tool_use/tool_result content blocks — see model.ts). We render the
     * model's prior tool call as a parenthetical aside on the assistant turn,
     * NOT as a bracket-prefixed pseudo-syntax — Gemini 3.5 Flash was observed (live-demo
     * 2026-05-14) copying our previous `[calling tool X: {...}]` synthetic
     * format on the next turn as TEXT, which the runtime then can't route as a
     * tool call. A parenthetical reads as commentary the model is less likely
     * to mimic.
     */
    const renderPriorToolCall = (toolName: string, toolInput: unknown): string =>
      `(I called tool ${toolName} with input: ${JSON.stringify(toolInput)})`;

    /**
     * Belt-and-suspenders: if the model DOES emit pseudo-tool-call text on a
     * later turn (we've seen `[calling tool X: {...}]` and `(call ... )`
     * variants), try to parse it back into a tool invocation rather than
     * escalate. We accept the most common shapes the model produces.
     */
    const PSEUDO_TOOL_CALL = /^\s*[[(]\s*(?:I\s+)?call(?:ing|ed)?\s+(?:tool\s+)?(?<name>[a-zA-Z0-9_.-]+)\s*(?:with\s+input)?\s*[:=]\s*(?<json>\{[\s\S]*\})\s*[\])]\s*$/i;
    const tryDecodePseudoToolCall = (text: string): { toolName: string; toolInput: unknown } | null => {
      const m = text.match(PSEUDO_TOOL_CALL);
      if (!m?.groups?.name || !m?.groups?.json) return null;
      try {
        return { toolName: m.groups.name, toolInput: JSON.parse(m.groups.json) };
      } catch {
        return null;
      }
    };

    let lastText = "";
    for (let turnNo = 0; turnNo < MAX_MODEL_TURNS; turnNo++) {
      const raw = await callModel();
      if (usd > def.maxUsd) return overCap();

      // If the model returned text, check whether it's a pseudo-tool-call we
      // should route as a real tool invocation. Otherwise, accept it as the
      // final assistant message.
      let r: typeof raw;
      if (raw.kind === "text") {
        const decoded = tryDecodePseudoToolCall(raw.text);
        if (decoded && def.tools.includes(decoded.toolName)) {
          r = { kind: "tool_use", toolName: decoded.toolName, toolInput: decoded.toolInput };
          // Keep the assistant's text on the wire so the model sees its own turn,
          // but explicitly tag the next user turn as a runtime-promoted tool call.
          messages.push({ role: "assistant", content: raw.text });
        } else {
          r = raw;
        }
      } else {
        r = raw;
      }

      if (r.kind === "text") {
        lastText = r.text;
        break;
      }
      hasCalledATool = true; // flip so subsequent calls drop tool_choice → auto
      messages.push({ role: "assistant", content: renderPriorToolCall(r.toolName, r.toolInput) });
      let toolResult: string;
      if (!def.tools.includes(r.toolName)) {
        toolResult = `ERROR: "${r.toolName}" is not one of your tools (${def.tools.join(", ") || "none"}).`;
      } else {
        toolResult = await ctx.trace.span(`tool:${r.toolName}`, "tool", { agent: def.id }, async (span) => {
          try {
            const out = await invokeCapability(r.toolName, r.toolInput, ctx.capabilityCtx);
            return JSON.stringify(out);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            span.error = msg;
            return `ERROR: ${msg}`;
          }
        });
      }
      messages.push({ role: "user", content: `Tool result for ${r.toolName}:\n${toolResult}` });
      if (turnNo === MAX_MODEL_TURNS - 1) {
        return { kind: "escalate", reason: `agent ${def.id} hit the ${MAX_MODEL_TURNS}-turn limit`, usd };
      }
    }

    // ── parse the final message; one reviser pass on a schema failure ──────
    let parsed = parseAgentOutput(def.output, lastText);
    if (parsed.escalate !== undefined) return { kind: "escalate", reason: parsed.escalate, usd };
    if (!parsed.ok) {
      messages.push({ role: "assistant", content: lastText });
      messages.push({
        role: "user",
        content:
          `Your response did not satisfy the required output contract:\n${parsed.critique}\n` +
          `Respond again with ONLY a single JSON object that matches the schema — no prose, no markdown fences. ` +
          `If you genuinely cannot, respond with {"escalate":"<reason>"}.`,
      });
      const r2 = await callModel();
      if (usd > def.maxUsd) return overCap();
      if (r2.kind !== "text") {
        return {
          kind: "escalate",
          reason: `agent ${def.id} called a tool during the reviser pass (first-pass text was: ${lastText.slice(0, 300)})`,
          partial: lastText,
          usd,
        };
      }
      parsed = parseAgentOutput(def.output, r2.text);
      if (parsed.escalate !== undefined) return { kind: "escalate", reason: parsed.escalate, usd };
      if (!parsed.ok) {
        return { kind: "escalate", reason: `agent ${def.id} output failed validation twice:\n${parsed.critique}`, partial: r2.text, usd };
      }
    }
    return { kind: "ok", value: parsed.value, usd };
  });
}

export function defineAgent<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(def: AgentDef<I, O>): AgentDef<I, O> {
  return def;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function buildSystemPrompt<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(def: AgentDef<I, O>, input: z.infer<I>): string {
  const hasTools = def.tools.length > 0;
  return [
    def.systemPrompt(input),
    "",
    "## Output contract",
    `When you are done${hasTools ? " (after any tool calls)" : ""}, respond with a single JSON object and nothing else.`,
    `It must satisfy this shape (informal — the runtime validates with the real schema): ${describeSchema(def.output)}.`,
    `If you cannot produce a valid result, respond with {"escalate":"<short reason>"} instead.`,
  ].join("\n");
}

function describeSchema(t: z.ZodTypeAny): string {
  const d = (t as unknown as { _def?: { typeName?: string; shape?: () => Record<string, unknown> } })._def;
  if (d?.typeName === "ZodObject" && typeof d.shape === "function") return `{ ${Object.keys(d.shape()).join(", ")} }`;
  return "(an object)";
}

type ParseOk<O extends z.ZodTypeAny> = { ok: true; value: z.infer<O>; escalate?: undefined; critique?: undefined };
type ParseFail = { ok: false; value?: undefined; critique: string; escalate?: string };

function parseAgentOutput<O extends z.ZodTypeAny>(schema: O, raw: string): ParseOk<O> | ParseFail {
  const json = extractJson(raw);
  if (json === undefined) return { ok: false, critique: "Response was not parseable as JSON." };
  if (typeof json === "object" && json !== null && "escalate" in json) {
    const e = (json as { escalate: unknown }).escalate;
    if (typeof e === "string") return { ok: false, critique: "agent escalated", escalate: e };
  }
  const r = schema.safeParse(json);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, critique: r.error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n") };
}

function extractJson(raw: string): unknown {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const between = text.includes("{") && text.includes("}") ? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1) : undefined;
  const candidates = [fenced?.[1]?.trim(), text, between].filter((s): s is string => typeof s === "string" && s.includes("{"));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}
