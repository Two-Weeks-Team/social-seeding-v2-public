import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { Card, CardBody } from "@/components/ui/card";
import { GoogleButton } from "@/components/ui/google-button";
import { googleLoginHref } from "@/lib/auth-links";
import { SESSION_COOKIE, cookieSecure, getServerSession, signSession } from "@/lib/auth";

/**
 * Sign-in. The production path is a real Google OAuth login (the prominent
 * button → /api/auth/google/start → consent → ss_session). A dev test-login
 * form is still rendered, but ONLY when AUTH_TEST_LOGIN_ENABLED==="true"
 * (hidden in production), demoted below a divider. C2 "Champagne & Espresso".
 */

/** Server action — only callable when AUTH_TEST_LOGIN_ENABLED=true. */
async function devLogin(): Promise<void> {
  "use server";
  if (process.env.AUTH_TEST_LOGIN_ENABLED !== "true") {
    throw new Error("dev login disabled");
  }
  const workspaceId = process.env.DEMO_LOGIN_WORKSPACE_ID ?? "ws_demo";
  const userId = process.env.DEMO_LOGIN_USER_ID ?? "102248148591352004682";
  const email = process.env.DEMO_LOGIN_EMAIL ?? "tester@2weeks.co";
  const token = await signSession({ userId, workspaceId, email });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
    secure: cookieSecure(),
  });
  redirect("/campaigns");
}

export default async function SignInPage(): Promise<React.ReactNode> {
  if (await getServerSession()) redirect("/campaigns");

  const devLoginEnabled = process.env.AUTH_TEST_LOGIN_ENABLED === "true";
  const demoWorkspaceId = process.env.DEMO_LOGIN_WORKSPACE_ID ?? "ws_demo";
  const demoEmail = process.env.DEMO_LOGIN_EMAIL ?? "tester@2weeks.co";

  return (
    <main className="min-h-screen grid place-items-center px-6 bg-canvas text-ink">
      <Card className="max-w-md w-full">
        <CardBody className="space-y-5">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-xl bg-brand text-white grid place-items-center text-[11px] font-bold shadow-brand">
              SS
            </div>
            <span className="text-[13px] font-semibold tracking-[-0.01em]">Social Seeding</span>
          </div>

          <div>
            <h1 className="text-[20px] font-bold tracking-[-0.01em] text-ink">Sign in</h1>
            <p className="mt-1 text-[13px] text-ink-2">Access your workspace with a Google account.</p>
          </div>

          <GoogleButton href={googleLoginHref()} size="lg" block label="Sign in with Google" />

          <p className="text-[12px] leading-relaxed text-ink-3">
            Once signed in, the agent fleet runs campaigns for this workspace. External sends pass through
            policy gates, with <span className="font-semibold text-ink-2">always review</span> as the default.
          </p>

          {devLoginEnabled ? (
            <div className="pt-4 border-t border-line space-y-2.5">
              <div className="text-[10px] uppercase tracking-[0.06em] text-ink-3 font-semibold">Development</div>
              <form action={devLogin}>
                <button
                  type="submit"
                  className="w-full inline-flex items-center justify-center rounded-xl border border-line bg-surface px-3 py-2 text-[12px] font-semibold text-ink-2 hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-ink focus-visible:ring-offset-2"
                >
                  Sign in with test session ({demoEmail} · {demoWorkspaceId})
                </button>
              </form>
              <details className="text-[11px] text-ink-3">
                <summary className="cursor-pointer hover:text-ink-2 transition-colors">curl login</summary>
                <div className="mono bg-canvas border border-line rounded-xl px-2.5 py-1.5 text-[11px] text-ink-2 mt-1.5 overflow-x-auto whitespace-nowrap">
                  curl -X POST http://localhost:3000/api/auth/test-login -H &apos;content-type:
                  application/json&apos; -d &apos;{`{`}&quot;secret&quot;:&quot;$AUTH_TEST_LOGIN_SECRET&quot;
                  {`}`}&apos; -c -
                </div>
              </details>
            </div>
          ) : null}
        </CardBody>
      </Card>
    </main>
  );
}
