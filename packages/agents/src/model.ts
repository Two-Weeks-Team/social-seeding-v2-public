/**
 * The seam between the agent runtime and the LLM provider.
 *
 * `runAgent` only ever talks to a `ModelClient` — never to a vendor SDK
 * directly — so a fake client makes the agent tests run with no API key, and a
 * different provider is a one-file swap. The default client wraps the Gemini
 * `generateContent` API via the `@google/genai` SDK (text + function-calling +
 * usage metadata is all the campaign agents need; see SCOPE-DECISIONS.md).
 *
 * Model routing (carried from ARCHITECTURE.md): Gemini 3.5 Flash for
 * judgment-heavy agents, Gemini 3.1 Flash-Lite for high-volume
 * extraction/classification.
 */

export type ModelId = "gemini-3.5-flash" | "gemini-3.1-flash-lite";

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
   * the default). Live-demo lesson 2026-05-14: Gemini 3.5 Flash with long
   * system prompts sometimes "thinks out loud" by emitting tool-call shaped
   * TEXT instead of a native `tool_use` block, breaking the runtime's
   * tool-result loop. `tool_choice: any` is the SDK-level fix — the model
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
 * and the cost ledger. Treat as estimates — verify against current Gemini /
 * Vertex AI pricing before relying on these for hard budget enforcement.
 */
export const MODEL_PRICING: Record<ModelId, { inputPerMTok: number; outputPerMTok: number }> = {
  "gemini-3.5-flash": { inputPerMTok: 1.5, outputPerMTok: 9 },
  "gemini-3.1-flash-lite": { inputPerMTok: 0.25, outputPerMTok: 1.5 },
};

export function estimateUsd(model: ModelId, inputTokens: number, outputTokens: number): number {
  const p = MODEL_PRICING[model];
  return (inputTokens / 1_000_000) * p.inputPerMTok + (outputTokens / 1_000_000) * p.outputPerMTok;
}

/** API model identifiers (kept separate from our routing keys in case they diverge). */
const MODEL_API_ID: Record<ModelId, string> = {
  "gemini-3.5-flash": "gemini-3.5-flash",
  "gemini-3.1-flash-lite": "gemini-3.1-flash-lite",
};

// Gemini dots aren't legal in function names; map "tiktok.search" <-> "tiktok__search".
const encodeToolName = (n: string): string => n.replace(/\./g, "__");
const decodeToolName = (n: string): string => n.replace(/__/g, ".");

/**
 * The minimal slice of the Gemini (`@google/genai`) SDK surface we use — keeps
 * us off its exact type shapes. We talk to `models.generateContent` with a
 * single `functionDeclarations` tool block; the response carries either
 * `functionCalls` (when the model invoked a tool) or `text`, plus
 * `usageMetadata` token counts for the cost ledger.
 */
interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: unknown };
}
interface GeminiLike {
  models: {
    generateContent(args: {
      model: string;
      contents: { role: "user" | "model"; parts: { text: string }[] }[];
      config?: {
        systemInstruction?: string;
        maxOutputTokens?: number;
        thinkingConfig?: { thinkingBudget?: number; includeThoughts?: boolean };
        tools?: { functionDeclarations: { name: string; description: string; parameters: Record<string, unknown> }[] }[];
        toolConfig?: { functionCallingConfig: { mode: "AUTO" | "ANY" | "NONE" } };
      };
    }): Promise<{
      candidates?: { content?: { parts?: GeminiPart[] } }[];
      functionCalls?: { name?: string; args?: unknown }[];
      text?: string;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    }>;
  };
}

let _gemini: GeminiLike | undefined;

/**
 * The production client. Lazily constructs the Gemini SDK so importing this
 * module (and running the tests) never requires a key — it throws, clearly,
 * only when actually invoked without `GEMINI_API_KEY`.
 */
export function defaultModelClient(): ModelClient {
  return {
    async complete({ model, system, messages, tools, maxTokens, toolChoice }) {
      if (!_gemini) {
        const mod = (await import("@google/genai")) as unknown as {
          GoogleGenAI: new (
            o: { vertexai: true; project: string; location: string } | { apiKey: string },
          ) => GeminiLike;
        };
        // D53: the product runs Gemini 3.5/3.1 on the Vertex AI `global`
        // endpoint. In production we use Vertex (ADC — the Cloud Run runtime
        // service account's credentials, no API key). Local dev / tests fall
        // back to the Gemini Developer API via GEMINI_API_KEY.
        // Case-fold the flag: deploy docs/scripts use `GOOGLE_GENAI_USE_VERTEXAI=TRUE`
        // (uppercase); a strict lowercase check would silently fall through to the
        // (absent) GEMINI_API_KEY path on Cloud Run and throw.
        const vertexFlag = process.env.GOOGLE_GENAI_USE_VERTEXAI?.toLowerCase();
        const useVertex = vertexFlag === "true" || vertexFlag === "1";
        if (useVertex) {
          const project = process.env.GOOGLE_CLOUD_PROJECT;
          if (!project) {
            throw new Error(
              "GOOGLE_GENAI_USE_VERTEXAI is set but GOOGLE_CLOUD_PROJECT is missing — Vertex (D53 global) needs the project id",
            );
          }
          // `||` not `??`: an empty-string GOOGLE_CLOUD_LOCATION must still default to global.
          const location = process.env.GOOGLE_CLOUD_LOCATION || "global";
          _gemini = new mod.GoogleGenAI({ vertexai: true, project, location });
        } else {
          const key = process.env.GEMINI_API_KEY;
          if (!key) {
            throw new Error(
              "GEMINI_API_KEY is not set — runAgent needs it at runtime (set GOOGLE_GENAI_USE_VERTEXAI=true for Vertex, or inject a fake ModelClient via ctx.model in tests)",
            );
          }
          _gemini = new mod.GoogleGenAI({ apiKey: key });
        }
      }
      const functionDeclarations = tools.length
        ? tools.map((t) => ({ name: encodeToolName(t.name), description: t.description, parameters: t.inputSchema }))
        : undefined;
      // Force a tool call (`ANY`) only when the caller asked for it AND tools
      // exist; otherwise let the model decide (`AUTO`, the SDK default).
      const sendToolChoice = toolChoice === "any" && Boolean(functionDeclarations);
      if (process.env.SS_DEBUG_MODEL === "1") {
        console.log(`[model] complete ${model} tools=${functionDeclarations?.length ?? 0} tool_choice=${sendToolChoice ? "ANY" : "AUTO"} messages=${messages.length}`);
      }
      const res = await _gemini.models.generateContent({
        model: MODEL_API_ID[model],
        // Gemini uses "model" (not "assistant") for the model's own turns.
        contents: messages.map((m) => ({
          role: m.role === "assistant" ? ("model" as const) : ("user" as const),
          parts: [{ text: m.content }],
        })),
        config: {
          systemInstruction: system,
          maxOutputTokens: maxTokens,
          thinkingConfig: { thinkingBudget: 0 },
          ...(functionDeclarations ? { tools: [{ functionDeclarations }] } : {}),
          ...(sendToolChoice ? { toolConfig: { functionCallingConfig: { mode: "ANY" as const } } } : {}),
        },
      });
      const usage = {
        inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
      };
      const parts = res.candidates?.[0]?.content?.parts ?? [];
      const fnCall = res.functionCalls?.[0] ?? parts.find((p) => p.functionCall)?.functionCall;
      if (process.env.SS_DEBUG_MODEL === "1") {
        console.log(`[model] response ${fnCall ? `functionCall=${fnCall.name}` : "text"}`);
      }
      if (fnCall && fnCall.name) {
        // Gemini doesn't surface a per-call tool-use id like the Messages API
        // did; synthesize a stable one from the (decoded) function name.
        return {
          kind: "tool_use",
          toolUseId: `gemini_${decodeToolName(fnCall.name)}`,
          toolName: decodeToolName(fnCall.name),
          toolInput: fnCall.args,
          ...usage,
        };
      }
      const text = res.text ?? parts.map((p) => p.text ?? "").join("");
      return { kind: "text", text, ...usage };
    },
  };
}
