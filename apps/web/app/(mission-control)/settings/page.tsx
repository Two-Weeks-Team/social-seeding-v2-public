import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { getServerSession } from "@/lib/auth";
import { gmailConnectionStatus } from "@/lib/gmail-oauth";

/**
 * Integrations / settings — the user-facing Gmail connect page.
 *
 * After login, the operator lands here and clicks "Gmail 연결" to run the
 * OAuth consent flow (/api/auth/gmail/start → Google consent → callback stores
 * the refresh token in the shared backend). The same page every team member
 * uses to (re)connect their sending mailbox. No client JS — the button is a
 * plain link to the start endpoint; the callback redirects back here with
 * `?gmail_connected=<email>`.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ gmail_connected?: string }>;
}) {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");

  const { gmail_connected } = await searchParams;
  const email = session.email;
  const status = await gmailConnectionStatus(email);

  const startHref = `/api/auth/gmail/start?email=${encodeURIComponent(email)}&returnUrl=/settings`;

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <h1 className="text-2xl font-bold text-slate-900">연동 설정</h1>
      <p className="mt-1 text-sm text-slate-600">
        에이전트가 아웃리치/답장 메일을 보내려면 Gmail 계정을 연결해야 합니다. 연결은 Google 동의 화면을
        거치며, 발급된 토큰은 공유 백엔드에 안전하게 저장됩니다.
      </p>

      {gmail_connected ? (
        <div className="mt-4 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          ✅ <b>{gmail_connected}</b> 연결 완료 — 이제 이 계정으로 메일을 보낼 수 있습니다.
        </div>
      ) : null}

      <Card className="mt-6">
        <CardBody>
          <SectionLabel>Gmail</SectionLabel>
          <div className="mt-2 flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-slate-900">{email}</div>
              <div className="mt-1">
                {status.connected ? (
                  <Badge>연결됨{status.expiresAt ? ` · 만료 ${new Date(status.expiresAt).toLocaleString("ko-KR")}` : ""}</Badge>
                ) : status.needsReauth ? (
                  <span className="text-xs text-amber-700">재인증 필요 (토큰 만료/미연결)</span>
                ) : (
                  <span className="text-xs text-slate-500">미연결</span>
                )}
              </div>
            </div>
            <a
              href={startHref}
              className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 transition-colors"
            >
              {status.connected ? "Gmail 재연결" : "Gmail 연결"}
            </a>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            권한: <code>gmail.send</code> + <code>gmail.readonly</code>. 발송은 운영자 허용 목록(D10) 내
            계정으로만 제한됩니다.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
