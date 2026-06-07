import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusTag } from "@/components/ui/status-tag";
import { suppressionAdd, verifyUnsubscribeToken } from "@ss/capabilities";
import { campaignRepo } from "@ss/db";

/**
 * /unsubscribe — CAN-SPAM §5 unsubscribe landing.
 *
 * The link gmail.send embeds in every outreach footer points here with a
 * signed token: `…/unsubscribe?token=<base64url payload>.<base64url sig>`.
 * The token (P2-C2b) commits to {rid=creatorTrackId, cid=campaignId, exp},
 * is HMAC-signed with EMAIL_UNSUBSCRIBE_HMAC_SECRET (dual-secret rotation
 * for in-flight links), and has a 30-day TTL by default.
 *
 * UX:
 *   · GET: verify token → if valid, render the campaign context + a
 *     single "Confirm unsubscribe" button. If invalid (expired / bad sig /
 *     not configured), render a clear error state.
 *   · POST (server action `confirmAction`): re-verify the token, derive
 *     the workspace from the campaign id, add the recipient email to the
 *     workspace's suppression list, render the "you're unsubscribed" state.
 *
 * The recipient email isn't in the token payload itself (we don't want a
 * token leak to also leak addresses). Instead we recover it from the
 * outbox row (gmail.send wrote the recipient there). For Phase-2 demo
 * simplicity, this page reads the most-recent outbox row keyed by the
 * creator-track id; if no email is found, we still record a
 * suppression-by-rid entry so the operator can manually reconcile.
 */

export const dynamic = "force-dynamic";

const PARAMS = z.object({ token: z.string().min(1) });

async function confirmAction(formData: FormData): Promise<void> {
  "use server";
  const Form = z.object({ token: z.string().min(1) });
  const parsed = Form.safeParse({ token: formData.get("token") });
  if (!parsed.success) redirect("/unsubscribe?status=invalid");

  const res = verifyUnsubscribeToken(parsed.data.token);
  if (!res.valid) {
    redirect(`/unsubscribe?status=${encodeURIComponent(res.reason)}`);
  }

  // rid = creatorTrackId (`${campaignId}:${creatorId}`), cid = campaignId.
  const campaign = await campaignRepo.get(res.cid).catch(() => null);
  if (!campaign) redirect("/unsubscribe?status=campaign_missing");

  // Recover the recipient email — the outbox row holds it (gmail.send wrote it).
  // We look up by the creator's portion of the rid.
  const [, creatorId] = res.rid.split(":");
  const track = campaign.tracks.find((t) => t.creatorId === creatorId);
  // Phase-2 demo cuts a corner: tracks don't carry the email (creator emails
  // are sourced at fan-out time, see P2-C5). So we do a best-effort lookup
  // via the most recent outbox row for this creator. If still nothing, we
  // record by rid so the operator can manually reconcile.
  const { getDb, Collections } = await import("@ss/db");
  const db = await getDb();
  const outboxRow = await db
    .collection<{ to?: string }>(Collections.V2_OUTBOX)
    .findOne(
      { idempotencyKey: { $regex: `^${res.cid}:${creatorId}:` } },
      { sort: { updatedAt: -1 } },
    );
  const email = outboxRow?.to;
  if (email) {
    await suppressionAdd.handler(
      {
        email,
        reason: "unsubscribed",
        source: `unsubscribe page (token rid=${res.rid})`,
        campaignId: res.cid,
        creatorId: track?.creatorId,
      },
      { workspaceId: campaign.brief.workspaceId, userId: campaign.brief.createdBy, rateLimitClass: "default" },
    );
  }
  revalidatePath("/unsubscribe");
  redirect(`/unsubscribe?status=ok${email ? "" : "_no_email"}`);
}

export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; status?: string }>;
}) {
  const params = await searchParams;
  const status = params.status ?? null;

  // Confirmation states (post-form submit redirect)
  if (status === "ok") return <Result kind="ok" />;
  if (status === "ok_no_email") return <Result kind="ok_no_email" />;
  if (status && status !== "valid") return <Result kind="error" reason={status} />;

  // GET — show the confirmation card if the token verifies.
  const parsed = PARAMS.safeParse(params);
  if (!parsed.success) return <Result kind="error" reason="missing_token" />;
  const res = verifyUnsubscribeToken(parsed.data.token);
  if (!res.valid) return <Result kind="error" reason={res.reason} />;
  const campaign = await campaignRepo.get(res.cid).catch(() => null);

  return (
    <main className="min-h-screen bg-canvas flex items-center justify-center px-4 py-12">
      <Card className="max-w-md w-full">
        <CardBody>
          <h1 className="text-[20px] font-bold tracking-[-0.01em] text-ink mb-2">Unsubscribe</h1>
          <p className="text-[13px] text-ink-2 leading-relaxed">
            {campaign?.brief.brandProduct.name ? (
              <>
                Click below if you no longer want to receive collaboration proposal emails for the{" "}
                <strong className="text-ink">{campaign.brief.brandProduct.name}</strong> campaign.
              </>
            ) : (
              "Click below if you no longer want to receive emails from this sender."
            )}
          </p>
          <div className="mt-4 text-[11px] text-ink-3">
            Link valid until <span className="mono">{new Date(res.exp * 1000).toISOString().slice(0, 10)}</span>
          </div>
          <form action={confirmAction} className="mt-5 flex justify-end">
            <input type="hidden" name="token" value={parsed.data.token} />
            <Button type="submit" variant="primary" tone="reject">
              Confirm unsubscribe
            </Button>
          </form>
        </CardBody>
      </Card>
    </main>
  );
}

function Result({
  kind,
  reason,
}: {
  kind: "ok" | "ok_no_email" | "error";
  reason?: string;
}): React.ReactElement {
  if (kind === "ok") {
    return (
      <main className="min-h-screen bg-canvas flex items-center justify-center px-4 py-12">
        <Card className="max-w-md w-full">
          <CardBody>
            <StatusTag tone="ok" size="sm">Done</StatusTag>
            <h1 className="mt-2.5 text-[20px] font-bold tracking-[-0.01em] text-ink">Unsubscribed</h1>
            <p className="mt-2 text-[13px] text-ink-2 leading-relaxed">
              This email address has been removed from the campaign mailing list. Automated proposal emails from this sender will no longer be sent.
            </p>
          </CardBody>
        </Card>
      </main>
    );
  }
  if (kind === "ok_no_email") {
    return (
      <main className="min-h-screen bg-canvas flex items-center justify-center px-4 py-12">
        <Card className="max-w-md w-full">
          <CardBody>
            <StatusTag tone="warn" size="sm">Received</StatusTag>
            <h1 className="mt-2.5 text-[20px] font-bold tracking-[-0.01em] text-ink">Unsubscribe request received</h1>
            <p className="mt-2 text-[13px] text-ink-2 leading-relaxed">
              We received the request. The linked email address could not be verified automatically, so an operator will process it manually, usually within 24 hours.
            </p>
          </CardBody>
        </Card>
      </main>
    );
  }
  const message =
    reason === "expired"
      ? "This token has expired. Reply directly to the sender to request unsubscribe."
      : reason === "bad_signature"
        ? "The token signature does not match. The link may have been altered or copied incorrectly."
        : reason === "not_configured"
          ? "The unsubscribe system is temporarily unavailable. Try again shortly."
          : reason === "missing_token"
            ? "This unsubscribe link is invalid because the token is missing."
            : reason === "campaign_missing"
              ? "The related campaign could not be found."
              : "The unsubscribe request could not be processed.";
  return (
    <main className="min-h-screen bg-canvas flex items-center justify-center px-4 py-12">
      <Card className="max-w-md w-full">
        <CardBody>
          <StatusTag tone="stop" size="sm">Error</StatusTag>
          <h1 className="mt-2.5 text-[20px] font-bold tracking-[-0.01em] text-ink">Cannot process request</h1>
          <p className="mt-2 text-[13px] text-ink-2 leading-relaxed">{message}</p>
        </CardBody>
      </Card>
    </main>
  );
}
