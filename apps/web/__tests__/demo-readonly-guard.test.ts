import { describe, expect, it } from "vitest";
import { demoReadonlyGuard, type SessionClaims } from "@/lib/auth";

const base: SessionClaims = { userId: "u".repeat(21), workspaceId: "ws_demo", email: "t@2weeks.co" };

describe("demoReadonlyGuard (server-action read-only enforcement)", () => {
  it("no-ops for real sessions and missing sessions", () => {
    expect(() => demoReadonlyGuard(base, "/approvals")).not.toThrow();
    expect(() => demoReadonlyGuard(null, "/approvals")).not.toThrow();
  });

  it("redirects a demo session back with the demoReadonly marker", () => {
    let digest = "";
    try {
      demoReadonlyGuard({ ...base, demo: true }, "/approvals");
      throw new Error("expected redirect");
    } catch (e) {
      digest = String((e as { digest?: string }).digest ?? "");
    }
    expect(digest).toContain("NEXT_REDIRECT");
    expect(digest).toContain("/approvals?demoReadonly=1");
  });

  it("appends with & when backTo already has a query", () => {
    let digest = "";
    try {
      demoReadonlyGuard({ ...base, demo: true }, "/campaigns/c1?tab=mail");
    } catch (e) {
      digest = String((e as { digest?: string }).digest ?? "");
    }
    expect(digest).toContain("/campaigns/c1?tab=mail&demoReadonly=1");
  });

  it("keeps the marker in the query, not inside a #fragment", () => {
    let digest = "";
    try {
      demoReadonlyGuard({ ...base, demo: true }, "/campaigns/c1#timeline");
    } catch (e) {
      digest = String((e as { digest?: string }).digest ?? "");
    }
    expect(digest).toContain("/campaigns/c1?demoReadonly=1#timeline");
  });

  it("never appends the marker twice", () => {
    let digest = "";
    try {
      demoReadonlyGuard({ ...base, demo: true }, "/approvals?demoReadonly=1");
    } catch (e) {
      digest = String((e as { digest?: string }).digest ?? "");
    }
    expect(digest).toContain("/approvals?demoReadonly=1");
    expect(digest).not.toContain("demoReadonly=1&demoReadonly=1");
  });
});
