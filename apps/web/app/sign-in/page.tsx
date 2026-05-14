import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Card, CardBody } from "@/components/ui/card";
import { SESSION_COOKIE, signSession } from "@/lib/auth";

/**
 * Sign-in stub. Phase 1 doesn't yet ship Google OAuth (Auth.js v5 +
 * next@16 peer-dep mismatch — see docs/SCOPE-DECISIONS.md). For the dev
 * demo, mint a session via the test-login route and the ss_session cookie
 * gets set automatically.
 *
 * In dev (when `AUTH_TEST_LOGIN_ENABLED === "true"`), this page also
 * renders a one-click "dev login" form whose server action mints the
 * session inline. Defaults match the live-demo workspace + sender
 * (override via `DEMO_LOGIN_WORKSPACE_ID` / `DEMO_LOGIN_USER_ID` /
 * `DEMO_LOGIN_EMAIL` if you need a different identity).
 */

/** Server action — only callable when AUTH_TEST_LOGIN_ENABLED=true. */
async function devLogin(): Promise<void> {
  "use server";
  if (process.env.AUTH_TEST_LOGIN_ENABLED !== "true") {
    throw new Error("dev login disabled");
  }
  const workspaceId = process.env.DEMO_LOGIN_WORKSPACE_ID ?? "ws_demo";
  const userId = process.env.DEMO_LOGIN_USER_ID ?? "102248148591352004682";
  const email = process.env.DEMO_LOGIN_EMAIL ?? "sangguen@2weeks.co";
  const token = await signSession({ userId, workspaceId, email });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
    secure: process.env.NODE_ENV === "production",
  });
  redirect("/campaigns");
}

export default function SignInPage(): React.ReactNode {
  const devLoginEnabled = process.env.AUTH_TEST_LOGIN_ENABLED === "true";
  const demoWorkspaceId = process.env.DEMO_LOGIN_WORKSPACE_ID ?? "ws_demo";
  const demoEmail = process.env.DEMO_LOGIN_EMAIL ?? "sangguen@2weeks.co";
  return (
    <main className="min-h-screen grid place-items-center px-6">
      <Card className="max-w-md w-full">
        <CardBody className="space-y-4">
          <div>
            <h1 className="text-[18px] font-semibold">로그인이 필요합니다</h1>
            <p className="mt-1 text-[13px] text-slate-600">
              Mission Control은 인증된 워크스페이스에서만 동작합니다. Phase 1 단계의 dev 데모에서는
              <span className="mono"> /api/auth/test-login </span>이 세션 쿠키를 직접 발급합니다.
            </p>
          </div>

          {devLoginEnabled ? (
            <form action={devLogin} className="space-y-2">
              <button
                type="submit"
                className="w-full inline-flex items-center justify-center rounded-md bg-slate-900 px-3 py-2 text-[13px] font-medium text-white hover:bg-slate-700"
              >
                테스트 세션으로 로그인 ({demoEmail} · {demoWorkspaceId})
              </button>
              <p className="text-[11px] text-slate-500">
                Dev 전용 ·{" "}
                <span className="mono">AUTH_TEST_LOGIN_ENABLED=true</span> 일 때만 표시됩니다. 프로덕션에서는
                숨김.
              </p>
            </form>
          ) : null}

          <div className="text-[12px] text-slate-600">
            <div className="mono bg-slate-50 border border-slate-200 rounded px-2 py-1.5 text-[11px] overflow-x-auto whitespace-nowrap">
              curl -X POST http://localhost:3000/api/auth/test-login -H &apos;content-type: application/json&apos; -d &apos;{`{`}&quot;secret&quot;:&quot;$AUTH_TEST_LOGIN_SECRET&quot;{`}`}&apos; -c -
            </div>
          </div>
          <div className="text-[11px] text-slate-500">
            Google OAuth + 일반 로그인은 Phase 2에서 들어옵니다 (next-auth@5-beta + next@16 peer-dep 이슈 해결 후).
          </div>
          <Link href="/campaigns" className="text-[12px] text-blue-700 hover:underline">
            세션이 이미 있다면 캠페인으로 이동 →
          </Link>
        </CardBody>
      </Card>
    </main>
  );
}
