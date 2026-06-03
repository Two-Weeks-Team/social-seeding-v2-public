/**
 * Server-side render for the 5th `approval.kind` discriminator —
 * `"payment_mandate"`.
 *
 * D-IDs touched:
 *   D26 — Mission Control surface (this is the drill-in route).
 *   D27 — AP2 Intent Mandate scope; the page composes the human-review surface
 *         and hands off to the client `MandateDetail` for the interactive
 *         signing path.
 *   D33 — page reads the operator's preferred locale from session (per
 *         workspace `user_prefs.preferredLocale`); when unset, falls back to
 *         the browser's `Accept-Language` header.
 *   D34 — every visible string flows through the AP2 i18n helper.
 *
 * AP2-UX.md §3.2: server component → client interactive boundary at the
 * `<MandateDetail />` element. The server validates the Mandate draft via
 * the Zod schema; if parsing fails the page falls back to a clean error
 * surface (mirrors the existing `outreach_send` invalid-draft branch).
 */
import type React from "react";
import Link from "next/link";
import { headers } from "next/headers";
import { type Approval } from "@ss/contracts";
import { DiagnosticBanner } from "@/components/ui/diagnostic";
import { SectionLabel } from "@/components/ui/card";
import { approvalKindKo } from "@/lib/labels";
import { MandateDetail } from "./mandate-detail";
import { isPaymentMandateDraft, type AP2Locale, type PaymentMandateDraft } from "@/lib/ap2/mandate";
import { negotiateLocale } from "@/lib/ap2/i18n";

export async function renderPaymentMandateApproval(
  approval: Approval,
  brandName: string | undefined,
): Promise<React.ReactElement> {
  const locale = await detectLocale();
  const draft = approval.recommendation;
  if (!isPaymentMandateDraft(draft)) {
    return (
      <div className="max-w-3xl mx-auto px-8 py-8">
        <Link
          href="/approvals"
          className="text-[12px] text-ink-3 hover:text-ink-2"
        >
          ← 승인 인박스
        </Link>
        <div className="mt-2 mb-5">
          <SectionLabel>{approvalKindKo("payment_mandate")}</SectionLabel>
          <h1 className="mt-1 text-[24px] font-bold tracking-[-0.01em]">
            {approvalKindKo("payment_mandate")}
          </h1>
        </div>
        <DiagnosticBanner tone="stop" title="이 항목은 지금 검토할 수 없습니다">
          첨부된 결제 위임 데이터가 형식과 맞지 않습니다. 워크플로 기록을
          확인한 뒤 다시 시도해주세요.
        </DiagnosticBanner>
      </div>
    );
  }
  return (
    <MandateDetail
      approvalId={approval.id}
      approvalCreatedAt={approval.createdAt.toISOString()}
      campaignId={approval.campaignId}
      campaignName={brandName ?? "(unknown campaign)"}
      rationale={approval.rationale}
      draft={draft as PaymentMandateDraft}
      locale={locale}
    />
  );
}

/**
 * Detect the operator's preferred locale.
 *
 *   1. session preference (TODO once `getServerSession` exposes
 *      `preferredLocale`; for now falls through to (2)).
 *   2. `Accept-Language` header — first matching D34 locale.
 *   3. fall back to "ko" (day-1 primary).
 */
async function detectLocale(): Promise<AP2Locale> {
  try {
    const h = await headers();
    const accept = h.get("accept-language");
    if (accept) {
      const first = accept.split(",")[0]?.trim();
      return negotiateLocale(first);
    }
  } catch {
    // SSR / static context — fall through.
  }
  return "ko";
}
