/**
 * The seam between the agent runtime and the LLM provider.
 *
 * `runAgent` only ever talks to a `ModelClient` — never to a vendor SDK
 * directly — so a fake client makes the agent tests run with no API key, and a
 * different provider is a one-file swap. The default client wraps the Anthropic
 * Messages API via the raw `@anthropic-ai/sdk` (the heavier
 * `@anthropic-ai/claude-agent-sdk` is reserved for agents that need Claude
 * Code's filesystem/bash tools — campaign agents don't; see SCOPE-DECISIONS.md).
 *
 * Model routing (carried from ARCHITECTURE.md): Opus 4.7 for judgment-heavy
 * agents, Haiku 4.5 for high-volume extraction/classification.
 */

export type ModelId = "claude-opus-4-7" | "claude-haiku-4-5";

/** A conversation turn. `content` is plain text — tool results are fed back as text user turns. */
export interface ModelMessage {
  role: "user" | "assistant";
  content: string;
}

/** A tool the model may call this turn (derived from a capability's name + Zod input schema). */
export interface ModelToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema (best-effort from Zod)
}

export type ModelTurn =
  | { kind: "text"; text: string; inputTokens: number; outputTokens: number }
  | { kind: "tool_use"; toolUseId: string; toolName: string; toolInput: unknown; inputTokens: number; outputTokens: number };

export interface ModelCompleteArgs {
  model: ModelId;
  system: string;
  messages: ModelMessage[];
  tools: ModelToolSpec[];
  maxTokens: number;
  /**
   * Force the model to use a tool (when `any`) or any tool/text (`auto` —
   * the default). Live-demo lesson 2026-05-14: Opus 4.7 with long system
   * prompts sometimes "thinks out loud" by emitting tool-call shaped TEXT
   * instead of a native `tool_use` block, breaking the runtime's
   * tool-result loop. `tool_choice: any` is the SDK-level fix — Anthropic
   * forces the response to include a real tool_use block when tools are
   * available.
   *
   * Runtime sets `any` on the first turn when tools are present and the
   * agent expects to use them. Subsequent turns fall back to `auto` so
   * the model can produce the final text answer.
   */
  toolChoice?: "auto" | "any";
}

export interface ModelClient {
  complete(args: ModelCompleteArgs): Promise<ModelTurn>;
}

/**
 * Approximate published $/MTok, by model. Used for the per-invocation USD cap
 * and the cost ledger. Treat as estimates — verify against current Anthropic
 * pricing before relying on these for hard budget enforcement.
 */
export const MODEL_PRICING: Record<ModelId, { inputPerMTok: number; outputPerMTok: number }> = {
  "claude-opus-4-7": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

export function estimateUsd(model: ModelId, inputTokens: number, outputTokens: number): number {
  const p = MODEL_PRICING[model];
  return (inputTokens / 1_000_000) * p.inputPerMTok + (outputTokens / 1_000_000) * p.outputPerMTok;
}

/** API model identifiers (kept separate from our routing keys in case they diverge). */
const MODEL_API_ID: Record<ModelId, string> = {
  "claude-opus-4-7": "claude-opus-4-7",
  "claude-haiku-4-5": "claude-haiku-4-5",
};

// Anthropic dots aren't legal in tool names; map "tiktok.search" <-> "tiktok__search".
const encodeToolName = (n: string): string => n.replace(/\./g, "__");
const decodeToolName = (n: string): string => n.replace(/__/g, ".");

/** The minimal slice of the Anthropic SDK surface we use — keeps us off its exact type shapes. */
interface AnthropicLike {
  messages: {
    create(args: {
      model: string;
      max_tokens: number;
      system: string;
      messages: { role: "user" | "assistant"; content: string }[];
      tools?: { name: string; description: string; input_schema: Record<string, unknown> }[];
      tool_choice?: { type: "auto" | "any" | "tool"; name?: string };
    }): Promise<{
      content: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
      usage: { input_tokens: number; output_tokens: number };
    }>;
  };
}

let _anthropic: AnthropicLike | undefined;

/**
 * The production client. Lazily constructs the Anthropic SDK so importing this
 * module (and running the tests) never requires a key — it throws, clearly,
 * only when actually invoked without `ANTHROPIC_API_KEY`.
 */
export function defaultModelClient(): ModelClient {
  return {
    async complete({ model, system, messages, tools, maxTokens, toolChoice }) {
      if (!_anthropic) {
        const key = process.env.ANTHROPIC_API_KEY;
        if (!key) {
          throw new Error(
            "ANTHROPIC_API_KEY is not set — runAgent needs it at runtime (tests should inject a fake ModelClient via ctx.model)",
          );
        }
        const mod = (await import("@anthropic-ai/sdk")) as unknown as { default: new (o: { apiKey: string }) => AnthropicLike };
        _anthropic = new mod.default({ apiKey: key });
      }
      const toolList = tools.length
        ? tools.map((t) => ({ name: encodeToolName(t.name), description: t.description, input_schema: t.inputSchema }))
        : undefined;
      const sendToolChoice = toolChoice === "any" && Boolean(toolList);
      if (process.env.SS_DEBUG_MODEL === "1") {
        console.log(`[model] complete ${model} tools=${toolList?.length ?? 0} tool_choice=${sendToolChoice ? "any" : "auto"} messages=${messages.length}`);
      }
      const res = await _anthropic.messages.create({
        model: MODEL_API_ID[model],
        max_tokens: maxTokens,
        system,
        messages,
        tools: toolList,
        // Forward `tool_choice` only when caller asked for `any` AND tools
        // exist. Default `auto` matches the SDK default; we don't send it
        // explicitly to keep the payload minimal.
        ...(sendToolChoice ? { tool_choice: { type: "any" as const } } : {}),
      });
      if (process.env.SS_DEBUG_MODEL === "1") {
        console.log(`[model] response types=[${res.content.map((b) => b.type).join(",")}]`);
      }
      const usage = { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
      const toolUse = res.content.find((b) => b.type === "tool_use");
      if (toolUse && toolUse.id && toolUse.name) {
        return { kind: "tool_use", toolUseId: toolUse.id, toolName: decodeToolName(toolUse.name), toolInput: toolUse.input, ...usage };
      }
      const text = res.content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");
      return { kind: "text", text, ...usage };
    },
  };
}
