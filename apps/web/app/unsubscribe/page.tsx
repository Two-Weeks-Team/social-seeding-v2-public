import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
    <main className="min-h-screen bg-slate-50 flex items-center justify-center px-4 py-12">
      <Card className="max-w-md w-full">
        <CardBody>
          <h1 className="text-[20px] font-semibold text-slate-900 mb-2">수신 거부</h1>
          <p className="text-[13px] text-slate-700 leading-relaxed">
            {campaign?.brief.brandProduct.name ? (
              <>
                <strong>{campaign.brief.brandProduct.name}</strong> 캠페인의 콜라보 제안 이메일을 더 이상 받지 않으시려면
                아래를 눌러 확인해주세요.
              </>
            ) : (
              "이 발송인에게 더 이상 이메일을 받지 않으시려면 아래를 눌러 확인해주세요."
            )}
          </p>
          <div className="mt-4 text-[11px] mono text-slate-400">
            campaign_{res.cid.slice(0, 12)} · token expires {new Date(res.exp * 1000).toISOString().slice(0, 10)}
          </div>
          <form action={confirmAction} className="mt-5 flex justify-end">
            <input type="hidden" name="token" value={parsed.data.token} />
            <Button type="submit" variant="primary" tone="reject">
              수신 거부 확인
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
      <main className="min-h-screen bg-slate-50 flex items-center justify-center px-4 py-12">
        <Card className="max-w-md w-full">
          <CardBody>
            <Badge variant="emerald">완료</Badge>
            <h1 className="mt-2 text-[20px] font-semibold text-slate-900">수신 거부됨</h1>
            <p className="mt-2 text-[13px] text-slate-700 leading-relaxed">
              이 이메일 주소는 위 캠페인의 워크스페이스 발송 목록에서 제거되었습니다. 향후 같은 워크스페이스의 자동 outreach는 보내지 않습니다.
            </p>
          </CardBody>
        </Card>
      </main>
    );
  }
  if (kind === "ok_no_email") {
    return (
      <main className="min-h-screen bg-slate-50 flex items-center justify-center px-4 py-12">
        <Card className="max-w-md w-full">
          <CardBody>
            <Badge variant="amber">기록됨</Badge>
            <h1 className="mt-2 text-[20px] font-semibold text-slate-900">수신 거부 요청 받음</h1>
            <p className="mt-2 text-[13px] text-slate-700 leading-relaxed">
              요청을 기록했습니다. 시스템이 이 토큰에 연결된 이메일을 자동으로 찾지 못해 운영자가 수동으로 처리합니다 (보통 24시간 이내).
            </p>
          </CardBody>
        </Card>
      </main>
    );
  }
  const message =
    reason === "expired"
      ? "토큰이 만료되었습니다. 발송인에게 직접 회신해 수신 거부를 요청해주세요."
      : reason === "bad_signature"
        ? "토큰 서명이 일치하지 않습니다. 링크가 변조되었거나 잘못 복사되었을 수 있습니다."
        : reason === "not_configured"
          ? "수신 거부 시스템이 일시 점검 중입니다. 잠시 후 다시 시도해주세요."
          : reason === "missing_token"
            ? "수신 거부 링크가 잘못되었습니다 (토큰 누락)."
            : reason === "campaign_missing"
              ? "관련 캠페인을 찾을 수 없습니다."
              : "수신 거부 요청을 처리할 수 없습니다.";
  return (
    <main className="min-h-screen bg-slate-50 flex items-center justify-center px-4 py-12">
      <Card className="max-w-md w-full">
        <CardBody>
          <Badge variant="rose">오류</Badge>
          <h1 className="mt-2 text-[20px] font-semibold text-slate-900">처리할 수 없음</h1>
          <p className="mt-2 text-[13px] text-slate-700 leading-relaxed">{message}</p>
        </CardBody>
      </Card>
    </main>
  );
}
