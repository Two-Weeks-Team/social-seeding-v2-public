import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { DiagnosticBanner } from "@/components/ui/diagnostic";
import { getServerSession } from "@/lib/auth";
import { leadCampaignRepo } from "@ss/db";
import { Events, LeadCampaignBriefSchema } from "@ss/contracts";
import { inngest } from "@ss/workflows";

/**
 * /leads/new — 새 리드 캠페인 브리프 폼 (C2 redesign). Operator pastes a list of
 * companies + the offer brief. On submit: leadCampaignRepo.create + emit the
 * lead-campaign event; the workflow takes over (회사 등록 → 조사 → 제안 준비 →
 * 콜드메일). Presentation only — the action + field names are unchanged.
 */

async function createLeadCampaignAction(formData: FormData): Promise<void> {
  "use server";
  const session = await getServerSession();
  if (!session) redirect("/sign-in");

  const Form = z.object({
    name: z.string().min(2).max(120),
    "ourProduct.name": z.string().min(1),
    "ourProduct.pitchSummary": z.string().min(10),
    "ourProduct.keyClaims": z.string().default(""),
    "targeting.countries": z.string().default("KR"),
    "outreach.toneNotes": z.string().default(""),
    "outreach.maxSendsPerBatch": z.coerce.number().int().positive().default(20),
    "goals.targetReplies": z.coerce.number().int().positive(),
    "goals.deadline": z.string().min(1),
    "goals.budgetUsd": z.coerce.number().nonnegative().optional(),
    leadList: z.string().min(1),
  });
  const parsed = Form.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    redirect("/leads/new?error=invalid");
  }
  const f = parsed.data;

  const brief = LeadCampaignBriefSchema.parse({
    workspaceId: session.workspaceId,
    createdBy: session.userId,
    name: f.name,
    ourProduct: {
      name: f["ourProduct.name"],
      pitchSummary: f["ourProduct.pitchSummary"],
      keyClaims: f["ourProduct.keyClaims"].split(",").map((s) => s.trim()).filter(Boolean),
    },
    targeting: {
      countries: f["targeting.countries"].split(",").map((s) => s.trim().toUpperCase()).filter((s) => s.length === 2),
      categories: [],
      excludeBlacklist: true,
    },
    outreach: {
      toneNotes: f["outreach.toneNotes"],
      maxSendsPerBatch: f["outreach.maxSendsPerBatch"],
    },
    goals: {
      targetReplies: f["goals.targetReplies"],
      deadline: new Date(f["goals.deadline"]),
      ...(f["goals.budgetUsd"] !== undefined ? { budgetUsd: f["goals.budgetUsd"] } : {}),
    },
  });

  // Parse the lead list — one row per line. Two accepted formats:
  //   "회사명 | https://homepage.url"
  //   "회사명" (홈페이지 주소 생략 — 주소가 없으면 워크플로우가 자동으로 제외합니다)
  const leadInputs = f.leadList
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, url] = line.split("|").map((s) => s.trim());
      return {
        companyName: name ?? "(이름 없음)",
        ...(url && /^https?:\/\//i.test(url) ? { homepageUrl: url } : {}),
      };
    })
    .slice(0, 200);
  if (leadInputs.length === 0) {
    redirect("/leads/new?error=empty_list");
  }

  const lc = await leadCampaignRepo.create({
    brief,
    status: "running",
    stage: "overview",
    leadIds: [],
  });
  await inngest.send({
    name: Events.LeadCampaignSubmitted,
    data: { leadCampaignId: lc.id, brief, leadInputs },
  });
  revalidatePath("/leads");
  redirect(`/leads/${lc.id}`);
}

const FIELD =
  "w-full text-[13px] text-ink bg-surface border border-line rounded-xl px-3.5 py-2.5 outline-none placeholder:text-ink-3 focus:border-brand-ink transition-colors";
const LABEL = "block text-[12px] font-medium text-ink-2 mb-1.5";

export default async function NewLeadCampaignPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  const { error } = await searchParams;

  return (
    <div className="max-w-3xl mx-auto px-8 py-8">
      <header className="mb-5">
        <Link href="/leads" className="text-[12px] text-ink-3 hover:text-ink-2">← 리드 목록</Link>
        <h1 className="mt-2 text-[24px] font-bold tracking-[-0.01em]">새 리드 캠페인</h1>
        <p className="mt-1 text-[13.5px] text-ink-2 max-w-[560px]">
          제안하고 싶은 회사 목록과 우리 제품을 알려주면, 에이전트가 각 회사를 조사해 제안 포인트를 정리하고 콜드메일을 보냅니다.
        </p>
      </header>

      {error && (
        <DiagnosticBanner
          tone="warn"
          title={error === "invalid" ? "입력값을 확인해주세요." : "회사 목록이 비어 있습니다."}
          className="mb-5"
        >
          {error === "invalid"
            ? "필수 항목이 비었거나 형식이 맞지 않습니다. 캠페인 이름·제안 요약·목표 답신 수·마감일을 다시 확인해주세요."
            : "최소 한 곳 이상의 회사를 한 줄에 하나씩 입력해주세요."}
        </DiagnosticBanner>
      )}

      <form action={createLeadCampaignAction} className="space-y-4">
        {/* ── brief ─────────────────────────────────────────── */}
        <Card><CardBody>
          <SectionLabel className="mb-3">캠페인 요약</SectionLabel>
          <label htmlFor="name" className={LABEL}>캠페인 이름</label>
          <input
            id="name"
            name="name"
            required
            minLength={2}
            maxLength={120}
            placeholder="K-뷰티 브랜드에 제안"
            className={FIELD}
          />
        </CardBody></Card>

        <Card><CardBody>
          <SectionLabel className="mb-3">우리가 제안하는 것</SectionLabel>
          <label htmlFor="ourProduct.name" className={LABEL}>제품 이름</label>
          <input
            id="ourProduct.name"
            name="ourProduct.name"
            required
            defaultValue="Social Seeding"
            className={`${FIELD} mb-4`}
          />
          <label htmlFor="ourProduct.pitchSummary" className={LABEL}>한 줄 소개 (10자 이상)</label>
          <input
            id="ourProduct.pitchSummary"
            name="ourProduct.pitchSummary"
            required
            minLength={10}
            defaultValue="TikTok 인플루언서 마케팅 플랫폼"
            className={`${FIELD} mb-4`}
          />
          <label htmlFor="ourProduct.keyClaims" className={LABEL}>핵심 강점 (쉼표로 구분)</label>
          <input
            id="ourProduct.keyClaims"
            name="ourProduct.keyClaims"
            placeholder="해시태그 적합도로 크리에이터 발굴, 회신 자동 처리"
            className={FIELD}
          />
        </CardBody></Card>

        <Card><CardBody>
          <SectionLabel className="mb-3">대상 + 콜드메일</SectionLabel>
          <label htmlFor="targeting.countries" className={LABEL}>대상 국가 (국가 코드, 쉼표로 구분)</label>
          <input
            id="targeting.countries"
            name="targeting.countries"
            required
            defaultValue="KR"
            className={`${FIELD} mono mb-4`}
          />
          <label htmlFor="outreach.toneNotes" className={LABEL}>메일 톤 메모 (선택)</label>
          <input
            id="outreach.toneNotes"
            name="outreach.toneNotes"
            placeholder="간결하게, 과장 없이"
            className={`${FIELD} mb-4`}
          />
          <label htmlFor="outreach.maxSendsPerBatch" className={LABEL}>한 번에 보낼 최대 메일 수</label>
          <input
            id="outreach.maxSendsPerBatch"
            name="outreach.maxSendsPerBatch"
            type="number"
            min="1"
            max="200"
            defaultValue="20"
            className={`${FIELD} mono w-32`}
          />
        </CardBody></Card>

        <Card><CardBody>
          <SectionLabel className="mb-3">목표</SectionLabel>
          <label htmlFor="goals.targetReplies" className={LABEL}>목표 답신 수</label>
          <input
            id="goals.targetReplies"
            name="goals.targetReplies"
            type="number"
            min="1"
            required
            defaultValue="5"
            className={`${FIELD} mono w-32 mb-4`}
          />
          <label htmlFor="goals.deadline" className={LABEL}>마감일</label>
          <input
            id="goals.deadline"
            name="goals.deadline"
            type="date"
            required
            className={`${FIELD} mono w-52 mb-4`}
          />
          <label htmlFor="goals.budgetUsd" className={LABEL}>예산 (USD, 선택)</label>
          <input
            id="goals.budgetUsd"
            name="goals.budgetUsd"
            type="number"
            min="0"
            step="0.01"
            placeholder="100"
            className={`${FIELD} mono w-32`}
          />
        </CardBody></Card>

        <Card><CardBody>
          <SectionLabel className="mb-3">회사 목록 (최대 200곳)</SectionLabel>
          <p className="text-[12.5px] text-ink-2 mb-2.5">
            한 줄에 한 회사씩 입력하세요. 형식: <span className="mono text-ink">회사명 | https://homepage.url</span>
            <span className="text-ink-3"> · 홈페이지 주소가 없으면 조사가 어려워 자동으로 제외됩니다.</span>
          </p>
          <textarea
            name="leadList"
            required
            rows={10}
            placeholder={"글로우 토닉 | https://glow-tonic.kr\n하이드라 코 | https://hydra.kr\n프레시 뷰티 | https://fresh.kr"}
            className={`${FIELD} mono text-[12px] leading-relaxed`}
          />
        </CardBody></Card>

        <div className="flex items-center justify-end gap-3 pt-1">
          <Link href="/leads"><Button variant="secondary">취소</Button></Link>
          <Button variant="primary" type="submit">캠페인 시작 →</Button>
        </div>
      </form>
    </div>
  );
}
