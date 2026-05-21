import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { memorySink, setObservabilitySink, startTrace } from "@ss/observability";
import { defineAgent, runAgent, type AgentRunContext } from "./runtime";
import type { ModelClient, ModelTurn } from "./model";

// runAgent's recordCost goes through the observability sink — give it an in-memory one
// (the same way these tests inject a fake ModelClient) so nothing touches a database.
beforeEach(() => setObservabilitySink(memorySink()));
afterEach(() => setObservabilitySink(undefined));

/**
 * P0-3 proof: runAgent's control flow exercised end-to-end with an injected
 * fake ModelClient (no API key needed) — happy path, the cold-mail-style
 * one-pass reviser on a schema failure, escalation, model-initiated escalation,
 * the per-invocation USD cap, and trace span emission.
 */

const echoAgent = defineAgent({
  id: "echo",
  description: "Uppercase the input text and return it.",
  tools: [], // no capabilities — keeps this a pure runtime test
  model: "gemini-3.1-flash-lite",
  maxUsd: 0.01,
  input: z.object({ text: z.string() }),
  output: z.object({ upper: z.string() }),
  systemPrompt: ({ text }) => `Return a JSON object {"upper": "<the input uppercased>"}. Input: ${JSON.stringify(text)}`,
});

function testCtx(model: ModelClient, extra?: Partial<AgentRunContext>): AgentRunContext {
  return {
    capabilityCtx: { workspaceId: "ws_test", userId: "u".repeat(21), rateLimitClass: "llm" },
    trace: startTrace("camp_test"),
    model,
    ...extra,
  };
}

const TOKENS = { inputTokens: 40, outputTokens: 8 };

/** A client that always replies with the same turn. */
function fixedClient(turn: ModelTurn): ModelClient {
  return { complete: async () => turn };
}

/** A client that walks through a script (then repeats the last entry). */
function scriptedClient(turns: ModelTurn[]): ModelClient {
  let i = 0;
  return {
    complete: async () => {
      const t = turns[Math.min(i++, turns.length - 1)];
      if (!t) throw new Error("scriptedClient: no turns configured");
      return t;
    },
  };
}

const text = (s: string): ModelTurn => ({ kind: "text", text: s, ...TOKENS });

describe("runAgent (echo agent)", () => {
  it("returns ok with the parsed, schema-valid output", async () => {
    const ctx = testCtx(fixedClient(text(JSON.stringify({ upper: "HELLO" }))));
    const out = await runAgent(echoAgent, { text: "hello" }, ctx);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.value.upper).toBe("HELLO");
    expect(out.usd).toBeGreaterThan(0);
  });

  it("tolerates markdown fences / surrounding prose around the JSON", async () => {
    const ctx = testCtx(fixedClient(text("Sure! Here you go:\n```json\n{ \"upper\": \"WIDGETS\" }\n```\nLet me know if you need anything else.")));
    const out = await runAgent(echoAgent, { text: "widgets" }, ctx);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.value.upper).toBe("WIDGETS");
  });

  it("runs one reviser pass when the first response fails the output schema, then succeeds", async () => {
    const ctx = testCtx(scriptedClient([text("here you go: UPPER"), text(JSON.stringify({ upper: "WORLD" }))]));
    const out = await runAgent(echoAgent, { text: "world" }, ctx);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.value.upper).toBe("WORLD");
    // 2 LLM calls => the reviser pass ran
    expect(ctx.trace.spans.filter((s) => s.kind === "llm")).toHaveLength(2);
  });

  it("escalates after the reviser pass still fails the schema", async () => {
    const ctx = testCtx(fixedClient(text("nope, no json here")));
    const out = await runAgent(echoAgent, { text: "x" }, ctx);
    expect(out.kind).toBe("escalate");
    if (out.kind !== "escalate") throw new Error("expected escalate");
    expect(out.reason).toMatch(/failed validation twice/i);
  });

  it("propagates a model-initiated escalation", async () => {
    const ctx = testCtx(fixedClient(text(JSON.stringify({ escalate: "input text was empty — cannot proceed" }))));
    const out = await runAgent(echoAgent, { text: "" }, ctx);
    expect(out.kind).toBe("escalate");
    if (out.kind !== "escalate") throw new Error("expected escalate");
    expect(out.reason).toContain("cannot proceed");
  });

  it("aborts (escalates) when a call pushes spend past the agent's USD cap", async () => {
    // 12M Gemini 3.1 Flash-Lite input tokens ≈ $3 ≫ maxUsd 0.01
    const ctx = testCtx(fixedClient({ kind: "text", text: JSON.stringify({ upper: "OK" }), inputTokens: 12_000_000, outputTokens: 0 }));
    const out = await runAgent(echoAgent, { text: "ok" }, ctx);
    expect(out.kind).toBe("escalate");
    if (out.kind !== "escalate") throw new Error("expected escalate");
    expect(out.reason).toMatch(/cap/i);
    expect(out.usd).toBeGreaterThan(1);
  });

  it("emits nested trace spans (agent → llm)", async () => {
    const ctx = testCtx(fixedClient(text(JSON.stringify({ upper: "TRACED" }))));
    await runAgent(echoAgent, { text: "traced" }, ctx);
    const agentSpan = ctx.trace.spans.find((s) => s.kind === "agent" && s.name === "agent:echo");
    const llmSpan = ctx.trace.spans.find((s) => s.kind === "llm");
    expect(agentSpan).toBeDefined();
    expect(llmSpan).toBeDefined();
    expect(llmSpan?.parentId).toBe(agentSpan?.id);
    expect(llmSpan?.attrs.usd).toBeGreaterThan(0);
  });
});
