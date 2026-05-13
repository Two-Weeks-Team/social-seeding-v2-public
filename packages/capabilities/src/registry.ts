import type { z } from "zod";
import { checkAndIncrement } from "./usage";

/**
 * Capability layer — the platform's typed functions. ONE place that both the
 * HTTP API and the agents call. Replaces v1's 266-route sprawl with ~dozens of
 * named capabilities, each with input/output schemas, auth scope, idempotency,
 * and rate-limit class baked in.
 *
 * An agent is handed a *subset* of this registry as its tool set. The registry
 * is the trust boundary: capabilities decide what's allowed, agents only ask.
 */
export interface CapabilityContext {
  workspaceId: string;
  userId: string; // 21-char Google OAuth id (v1 parity)
  campaignId?: string;
  /** carried from v1: per-plan × action monthly quota + atomic $inc + rollback */
  rateLimitClass: "tiktok_read" | "gmail_send" | "llm" | "shipment" | "crm_enrich" | "default";
}

export interface Capability<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  name: string; // dotted: "tiktok.search"
  description: string; // shown to agents
  input: I;
  output: O;
  scope: "read" | "write" | "external_send"; // external_send ⇒ never auto without policy gate
  idempotent: boolean;
  rateLimitClass: CapabilityContext["rateLimitClass"];
  handler: (input: z.infer<I>, ctx: CapabilityContext) => Promise<z.infer<O>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REGISTRY = new Map<string, Capability<any, any>>();

export function defineCapability<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(c: Capability<I, O>): Capability<I, O> {
  if (REGISTRY.has(c.name)) throw new Error(`duplicate capability: ${c.name}`);
  REGISTRY.set(c.name, c);
  return c;
}

export function getCapability(name: string): Capability<z.ZodTypeAny, z.ZodTypeAny> {
  const c = REGISTRY.get(name);
  if (!c) throw new Error(`unknown capability: ${name}`);
  return c;
}

export function listCapabilities(): ReadonlyArray<{ name: string; description: string; scope: Capability<z.ZodTypeAny, z.ZodTypeAny>["scope"] }> {
  return [...REGISTRY.values()].map(({ name, description, scope }) => ({ name, description, scope }));
}

/** Invoke a capability: validate input → enforce the rate-limit class → run → validate output. */
export async function invokeCapability(name: string, rawInput: unknown, ctx: CapabilityContext): Promise<unknown> {
  const c = getCapability(name);
  const input = c.input.parse(rawInput);
  // rate limit on the capability's declared class (no-op for "default") — port of v1 usage-limiter
  await checkAndIncrement(ctx.workspaceId, ctx.userId, c.rateLimitClass);
  const out = await c.handler(input, ctx);
  return c.output.parse(out);
}
