import { redirect } from "next/navigation";

import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { StatusTag } from "@/components/ui/status-tag";
import { DiagnosticBanner } from "@/components/ui/diagnostic";
import { cn } from "@/lib/cn";
import { getServerSession } from "@/lib/auth";
import { gmailConnectionStatus } from "@/lib/gmail-oauth";

/**
 * Integrations / settings — the user-facing Gmail connect page (C2 redesign).
 *
 * After login, the operator lands here and clicks "Connect Gmail" to run the
 * OAuth consent flow (/api/auth/gmail/start → Google consent → callback stores
 * the refresh token in the shared backend). The same page every team member
 * uses to (re)connect their sending mailbox. No client JS — the button is a
 * plain link to the start endpoint; the callback redirects back here with
 * `?gmail_connected=<email>`.
 *
 * Re-auth gates the core send capability, so when the token needs reconnecting
 * we surface it with a DiagnosticBanner (consequence + recovery action), not a
 * quiet pill.
 */

const LINK_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-xl font-semibold transition-colors h-9 px-3.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-ink focus-visible:ring-offset-2";

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
  // Espresso fill is reserved for the action we want them to take — connect /
  // reconnect. A healthy connected state demotes reconnect to the ivory surface.
  const actionPrimary = !status.connected || status.needsReauth;
  const buttonLabel = status.connected ? "Reconnect Gmail" : status.needsReauth ? "Reconnect Gmail" : "Connect Gmail";

  return (
    <div className="max-w-3xl mx-auto px-8 py-8">
      <header className="mb-5">
        <h1 className="text-[24px] font-bold tracking-[-0.01em]">Integration settings</h1>
        <p className="mt-1 text-[13.5px] text-ink-2 max-w-[640px]">
          Connect Gmail so agents can send outreach and replies. The connection goes through Google consent, and issued tokens are stored securely in the shared backend.
        </p>
      </header>

      {/* Re-auth blocks sending — lead with it, not a quiet pill. */}
      {status.needsReauth ? (
        <DiagnosticBanner
          tone="stop"
          title="Gmail re-authentication required"
          actions={
            <a href={startHref} aria-label="Reconnect Gmail" className={cn(LINK_BASE, "bg-brand text-white hover:bg-brand-2 shadow-brand")}>
              Reconnect Gmail
            </a>
          }
          className="mb-5"
        >
          The connection expired or permissions were revoked, so this account cannot send mail right now.
          Agent outreach and replies are paused until Gmail is reconnected.
        </DiagnosticBanner>
      ) : null}

      {gmail_connected ? (
        <div className="mb-5 rounded-2xl border border-ok/25 bg-ok-bg px-5 py-3.5 text-[13.5px] text-ink-2 flex items-center gap-2.5 shadow-soft">
          <span className="w-[7px] h-[7px] rounded-full bg-ok shrink-0" aria-hidden />
          <span>
            <b className="mono text-ink">{gmail_connected}</b> connected. This account can now send mail.
          </span>
        </div>
      ) : null}

      <Card>
        <CardBody>
          <SectionLabel>Gmail sending account</SectionLabel>
          <div className="mt-3 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[15px] font-bold text-ink truncate">{email}</div>
              <div className="mt-1.5">
                {status.connected ? (
                  <StatusTag tone="ok" size="sm">
                    Connected
                    {status.expiresAt ? (
                      <span className="mono font-normal ml-1">expires {new Date(status.expiresAt).toLocaleString("en-US")}</span>
                    ) : null}
                  </StatusTag>
                ) : status.needsReauth ? (
                  <StatusTag tone="stop" size="sm">Re-auth required</StatusTag>
                ) : (
                  <StatusTag tone="neutral" size="sm">Not connected</StatusTag>
                )}
              </div>
            </div>
            <a
              href={startHref}
              aria-label={buttonLabel}
              className={cn(
                LINK_BASE,
                "shrink-0",
                actionPrimary
                  ? "bg-brand text-white hover:bg-brand-2 shadow-brand"
                  : "bg-surface text-ink border border-line hover:bg-surface-2",
              )}
            >
              {buttonLabel}
            </a>
          </div>
          <p className="mt-4 pt-3.5 border-t border-line-2 text-[12px] text-ink-3 leading-relaxed">
            Uses send/read mail permissions. Sending is limited to accounts on the operator allowlist.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
