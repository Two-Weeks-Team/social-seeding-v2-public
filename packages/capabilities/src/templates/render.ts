import { z } from "zod";
import { defineCapability } from "../registry";

/**
 * templates.render — port of v1 `~/social-seeding/src/lib/email-template-engine.ts`.
 * A pure capability (no I/O): given a subject + body containing `{{ varName }}`
 * placeholders + a values map, return the rendered pair. Variable values are
 * HTML-escaped before substitution because the rendered body is fed straight
 * into Gmail multipart/alternative HTML — without escaping, a recipient name
 * like `<script>alert(1)</script>` would execute when previewed in the MC.
 * v1's SEC-05 defence carried verbatim.
 *
 * The default `missing` policy mirrors v1's `removeUnmatched=false`: unresolved
 * placeholders are left intact in the output AND reported in `missingVariables`
 * so the caller (outreach-writer agent / approval UI) can flag them. Setting
 * `missing: "remove"` is what the cold-mail tournament uses when previewing a
 * draft to humans (so they don't see literal `{{name}}`).
 *
 * What this is *not*: a template-CRUD layer. Loading a stored template by
 * `templateId` from SHARED_TEMPLATES is a separate `templates.get` capability
 * (Phase 2 follow-up) that the workflow calls before this one. Keeping render
 * pure lets it run in the agent's tool set without a rate-limit class or DB hit.
 */

const HTML_ESCAPE_TABLE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "/": "&#x2F;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"'/]/g, (ch) => HTML_ESCAPE_TABLE[ch] ?? ch);
}

const VARIABLE_PATTERN = /\{\{\s*([\w.-]+)\s*\}\}/g;

export interface RenderOptions {
  /**
   * What to do when a `{{var}}` reference has no matching value.
   * - `"preserve"` (default): leave the literal `{{var}}` in the output.
   * - `"remove"`             : replace with empty string (v1 `removeUnmatched`).
   */
  missing?: "preserve" | "remove";
  /**
   * Skip HTML-escaping. Off by default — only enable for fields rendered into
   * a `text/plain` part (the subject line is text/plain too, but Gmail's MIME
   * layer will percent-encode anything we don't escape, so keeping the default
   * on is the safer default).
   */
  raw?: boolean;
}

function substitute(
  source: string,
  variables: Record<string, string>,
  opts: Required<RenderOptions>,
): { out: string; missing: Set<string> } {
  const missing = new Set<string>();
  const out = source.replace(VARIABLE_PATTERN, (match, name: string) => {
    const v = variables[name];
    if (v === undefined || v === null || v === "") {
      missing.add(name);
      return opts.missing === "remove" ? "" : match;
    }
    return opts.raw ? String(v) : escapeHtml(String(v));
  });
  return { out, missing };
}

export const templatesRender = defineCapability({
  name: "templates.render",
  description:
    "Render an outreach email template: substitute `{{var}}` placeholders in subject + body using the given values map. Values are HTML-escaped by default. Missing vars are reported (not silently dropped).",
  scope: "read",
  idempotent: true,
  rateLimitClass: "default",
  input: z.object({
    subject: z.string().min(1),
    body: z.string().min(1),
    variables: z.record(z.string(), z.string()).default({}),
    options: z
      .object({
        missing: z.enum(["preserve", "remove"]).default("preserve"),
        raw: z.boolean().default(false),
      })
      .default({ missing: "preserve", raw: false }),
  }),
  output: z.object({
    subject: z.string(),
    body: z.string(),
    missingVariables: z.array(z.string()),
  }),
  async handler({ subject, body, variables, options }, _ctx) {
    const opts: Required<RenderOptions> = { missing: options.missing, raw: options.raw };
    const s = substitute(subject, variables, opts);
    const b = substitute(body, variables, opts);
    const missing = new Set<string>([...s.missing, ...b.missing]);
    return { subject: s.out, body: b.out, missingVariables: [...missing] };
  },
});

/**
 * Extract every `{{var}}` reference from a template. Exposed for the
 * outreach-writer agent and the template-editor UI, which both need to know
 * what variables a draft expects before sending.
 */
export function extractTemplateVariables(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(VARIABLE_PATTERN)) {
    if (m[1]) out.add(m[1]);
  }
  return [...out];
}
