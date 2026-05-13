import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { Sidebar } from "@/components/mission-control/sidebar";
import { getServerSession } from "@/lib/auth";
import { approvalRepo } from "@ss/db";

/**
 * Mission Control shell — sidebar + main area. All `/(mission-control)/*`
 * pages render inside this. Authenticates server-side via the ss_session
 * cookie; unauthenticated users land on /sign-in (a stub that explains how
 * to use test-login for now, since Auth.js v5 + Google OAuth is deferred).
 *
 * Surfaces a live pending-approvals badge in the sidebar so even Phase-2/3
 * gates (when they arrive) flow into the same UI without code change.
 */

async function pendingApprovalsCount(workspaceId: string): Promise<number> {
  try {
    return (await approvalRepo.listPendingByWorkspace(workspaceId)).length;
  } catch {
    // DB might not be reachable in dev (e.g. dev-mongo down) — degrade gracefully.
    return 0;
  }
}

export default async function MissionControlLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");

  // Determine the active route from the request headers so the sidebar can
  // highlight the current section. Falls back to /campaigns.
  const h = await headers();
  const pathname = h.get("x-pathname") ?? h.get("next-url") ?? "/campaigns";

  const pending = await pendingApprovalsCount(session.workspaceId);

  return (
    <div className="flex h-screen">
      <Sidebar session={session} active={pathname} pendingApprovals={pending} />
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
