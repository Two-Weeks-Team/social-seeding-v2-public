// @vitest-environment node
import { describe, expect, it, beforeAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { SESSION_COOKIE, denyIfDemo, signSession, verifySession } from "@/lib/auth";
import { GET } from "@/app/api/auth/judge-demo/route";

const TOKEN = "judge-demo-test-token-0123456789abcdef";
const hasMongo = Boolean(process.env.MONGODB_URI);

beforeAll(() => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-auth-secret-0123456789abcdef";
});

/** Reset the judge-demo env to a known-armed baseline before each test. */
beforeEach(() => {
  process.env.JUDGE_DEMO_ENABLED = "true";
  process.env.JUDGE_DEMO_TOKEN = TOKEN;
  process.env.JUDGE_DEMO_WORKSPACE_ID = "ws_wooriliu_2nd";
  process.env.JUDGE_DEMO_EMAIL = "judge-demo@2weeks.co";
  process.env.JUDGE_DEMO_USER_ID = "judge-demo-0000000000";
  delete process.env.JUDGE_DEMO_EXPIRES_AT;
  delete process.env.JUDGE_DEMO_MAX_USES;
});

function reqWith(token: string): NextRequest {
  return new NextRequest(new URL(`https://agents.test/api/auth/judge-demo?token=${encodeURIComponent(token)}`));
}

describe("denyIfDemo — read-only guard", () => {
  it("returns a 403 Response for a demo session", () => {
    const res = denyIfDemo({ userId: "u", workspaceId: "w", email: "e", demo: true });
    expect(res).not.toBeNull();
    expect(res?.status).toBe(403);
  });
  it("returns null for a normal session", () => {
    expect(denyIfDemo({ userId: "u", workspaceId: "w", email: "e" })).toBeNull();
  });
});

describe("signSession/verifySession — demo claim round-trip", () => {
  it("preserves demo:true through sign + verify", async () => {
    const t = await signSession({ userId: "u", workspaceId: "w", email: "e", demo: true }, 60);
    const claims = await verifySession(t);
    expect(claims?.demo).toBe(true);
  });
  it("omits demo for a normal session", async () => {
    const t = await signSession({ userId: "u", workspaceId: "w", email: "e" }, 60);
    const claims = await verifySession(t);
    expect(claims?.demo).toBeUndefined();
  });
});

describe("GET /api/auth/judge-demo — env guards (no DB)", () => {
  it("404 when JUDGE_DEMO_ENABLED is not 'true' (kill switch)", async () => {
    process.env.JUDGE_DEMO_ENABLED = "false";
    expect((await GET(reqWith(TOKEN))).status).toBe(404);
  });

  it("410 when past JUDGE_DEMO_EXPIRES_AT", async () => {
    process.env.JUDGE_DEMO_EXPIRES_AT = "2000-01-01T00:00:00Z";
    expect((await GET(reqWith(TOKEN))).status).toBe(410);
  });

  it("401 on a wrong token", async () => {
    expect((await GET(reqWith("wrong-token"))).status).toBe(401);
  });

  it("401 on a missing token", async () => {
    const res = await GET(new NextRequest(new URL("https://agents.test/api/auth/judge-demo")));
    expect(res.status).toBe(401);
  });

  it("500 when JUDGE_DEMO_TOKEN is unset (misconfigured)", async () => {
    delete process.env.JUDGE_DEMO_TOKEN;
    expect((await GET(reqWith(TOKEN))).status).toBe(500);
  });
});

describe.skipIf(!hasMongo)("GET /api/auth/judge-demo — happy path + cap (DB)", () => {
  it("valid token → redirect to /campaigns + a demo ss_session cookie", async () => {
    const res = await GET(reqWith(TOKEN));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/campaigns");
    const cookie = res.cookies.get(SESSION_COOKIE)?.value;
    expect(cookie).toBeTruthy();
    const claims = await verifySession(cookie!);
    expect(claims).toMatchObject({ workspaceId: "ws_wooriliu_2nd", email: "judge-demo@2weeks.co", demo: true });
  });

  it("429 once the usage cap is exhausted", async () => {
    process.env.JUDGE_DEMO_TOKEN = `${TOKEN}-cap-${Date.now()}`; // fresh counter row
    process.env.JUDGE_DEMO_MAX_USES = "1";
    const first = await GET(reqWith(process.env.JUDGE_DEMO_TOKEN));
    expect(first.status).toBe(307);
    const second = await GET(reqWith(process.env.JUDGE_DEMO_TOKEN));
    expect(second.status).toBe(429);
  });
});
