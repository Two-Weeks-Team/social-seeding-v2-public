import { describe, expect, it } from "vitest";
import { extractTemplateVariables, templatesRender } from "./render";

/**
 * P2-C2a — templates.render. Pure capability, no Mongo needed. Exercises the
 * substitution + HTML-escape + missing-vars contract that gmail.send and the
 * outreach-writer agent both rely on.
 */

const ctx = { workspaceId: "ws", userId: "u".repeat(21), rateLimitClass: "default" as const };

describe("templates.render", () => {
  it("substitutes simple placeholders in subject and body", async () => {
    const out = await templatesRender.handler(
      {
        subject: "Hi {{ name }}",
        body: "We loved your @{{ username }} content — got 60s?",
        variables: { name: "Jiwoo", username: "freshly" },
        options: { missing: "preserve", raw: false },
      },
      ctx,
    );
    expect(out.subject).toBe("Hi Jiwoo");
    expect(out.body).toBe("We loved your @freshly content — got 60s?");
    expect(out.missingVariables).toEqual([]);
  });

  it("HTML-escapes variable values to block XSS via recipient-controlled fields", async () => {
    const out = await templatesRender.handler(
      {
        subject: "Hi {{name}}",
        body: "<p>Hi {{name}}, from {{brand}}.</p>",
        variables: { name: "<script>alert(1)</script>", brand: "K&Beauty" },
        options: { missing: "preserve", raw: false },
      },
      ctx,
    );
    expect(out.body).toContain("&lt;script&gt;");
    expect(out.body).not.toContain("<script>");
    expect(out.body).toContain("K&amp;Beauty");
    expect(out.subject).toBe("Hi &lt;script&gt;alert(1)&lt;&#x2F;script&gt;");
  });

  it("raw: true skips escaping (text/plain rendering path)", async () => {
    const out = await templatesRender.handler(
      {
        subject: "x",
        body: "Address: {{addr}}",
        variables: { addr: "1-2, Apt 3 < B>" },
        options: { missing: "preserve", raw: true },
      },
      ctx,
    );
    expect(out.body).toBe("Address: 1-2, Apt 3 < B>");
  });

  it("missing: preserve (default) leaves {{var}} intact AND reports it", async () => {
    const out = await templatesRender.handler(
      {
        subject: "Hi {{ name }}",
        body: "Re your {{ niche }} content — interested in {{ brand }}?",
        variables: { name: "Jiwoo" },
        options: { missing: "preserve", raw: false },
      },
      ctx,
    );
    expect(out.body).toContain("{{ niche }}");
    expect(out.body).toContain("{{ brand }}");
    expect(new Set(out.missingVariables)).toEqual(new Set(["niche", "brand"]));
  });

  it("missing: remove strips unresolved placeholders entirely (preview mode)", async () => {
    const out = await templatesRender.handler(
      {
        subject: "Hi {{name}}",
        body: "{{greeting}}Welcome.",
        variables: { name: "Jiwoo" },
        options: { missing: "remove", raw: false },
      },
      ctx,
    );
    expect(out.subject).toBe("Hi Jiwoo");
    expect(out.body).toBe("Welcome.");
    expect(out.missingVariables).toEqual(["greeting"]);
  });

  it("does not double-substitute: a value that itself contains '{{x}}' is escaped, not re-rendered", async () => {
    const out = await templatesRender.handler(
      {
        subject: "x",
        body: "Hi {{name}}",
        variables: { name: "{{evil}}", evil: "should not appear" },
        options: { missing: "preserve", raw: false },
      },
      ctx,
    );
    expect(out.body).toBe("Hi {{evil}}"); // literal, no recursion
    expect(out.body).not.toContain("should not appear");
  });

  it("error path: empty subject or body is rejected by the input schema", () => {
    expect(templatesRender.input.safeParse({ subject: "", body: "x" }).success).toBe(false);
    expect(templatesRender.input.safeParse({ subject: "x", body: "" }).success).toBe(false);
  });

  it("extractTemplateVariables returns the unique set in input order", () => {
    expect(
      extractTemplateVariables("Hi {{name}}, your {{niche}} on @{{ username }} — also {{name}}!"),
    ).toEqual(["name", "niche", "username"]);
  });
});
