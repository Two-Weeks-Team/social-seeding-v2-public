import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import Link from "next/link";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { getServerSession } from "@/lib/auth";
import { campaignRepo } from "@ss/db";
import { CampaignBriefSchema, Events } from "@ss/contracts";
import { promptGuard, PromptGuardError } from "@/lib/prompt-guard";
import { inngest } from "@ss/workflows";

/**
 * W2 — New campaign (C2 redesign). One activation gate: the operator fills the
 * brief, presses 캠페인 시작, and the fleet begins sourcing creators. The form is
 * the supported entry path; copy stays operator-facing (no workflow internals).
 */

async function createCampaignAction(formData: FormData): Promise<void> {
  "use server";
  const session = await getServerSession();
  if (!session) redirect("/sign-in");

  const Form = z.object({
    "brandProduct.name": z.string().min(1),
    "brandProduct.category": z.string().min(1),
    "brandProduct.description": z.string().min(1),
    "targeting.creatorCount": z.coerce.number().int().positive(),
    "targeting.minEngagementRate": z.coerce.number().min(0).max(1),
    "targeting.languages": z.string(),
    "targeting.hashtags": z.string().optional().default(""),
    "logistics.shipsSamples": z.string().optional(),
    "goals.targetLivePosts": z.coerce.number().int().positive(),
    "goals.deadline": z.string().min(1),
    "goals.budgetUsd": z.preprocess(
      (v) => (v === "" || v == null ? undefined : v),
      z.coerce.number().nonnegative().optional(),
    ),
  });
  const raw = Object.fromEntries(formData.entries());
  const parsed = Form.safeParse(raw);
  if (!parsed.success) return;
  const f = parsed.data;

  // prompt-guard the free-text fields before they reach the agents
  try {
    promptGuard(f["brandProduct.name"], "brandProduct.name");
    promptGuard(f["brandProduct.description"], "brandProduct.description");
  } catch (err) {
    if (err instanceof PromptGuardError) return; // soft-fail; user re-submits
    throw err;
  }

  const briefInput = {
    workspaceId: session.workspaceId,
    createdBy: session.userId,
    brandProduct: {
      name: f["brandProduct.name"],
      category: f["brandProduct.category"],
      description: f["brandProduct.description"],
      keyClaims: [],
    },
    targeting: {
      creatorCount: f["targeting.creatorCount"],
      minEngagementRate: f["targeting.minEngagementRate"],
      languages: f["targeting.languages"].split(",").map((s) => s.trim()).filter(Boolean),
      hashtags: f["targeting.hashtags"]?.split(",").map((s) => s.trim()).filter(Boolean) ?? [],
      excludeBlacklist: true,
    },
    logistics: { shipsSamples: f["logistics.shipsSamples"] === "on" },
    goals: { targetLivePosts: f["goals.targetLivePosts"], deadline: f["goals.deadline"], budgetUsd: f["goals.budgetUsd"] },
  };
  const briefParsed = CampaignBriefSchema.safeParse(briefInput);
  if (!briefParsed.success) return;
  const brief = briefParsed.data;

  const campaign = await campaignRepo.create({ brief, status: "running", stage: "overview", tracks: [] });
  await inngest.send({ name: Events.CampaignSubmitted, data: { campaignId: campaign.id, brief } });
  revalidatePath("/campaigns");
  redirect(`/campaigns/${campaign.id}`);
}

const LANG_OPTIONS: { code: string; label: string }[] = [
  { code: "ko", label: "한국어" },
  { code: "en", label: "영어" },
  { code: "ja", label: "일본어" },
  { code: "zh", label: "중국어" },
];

export default async function NewCampaignPage() {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");

  return (
    <div className="max-w-3xl mx-auto px-8 py-8 pb-28">
      <header className="mb-6">
        <Link href="/campaigns" className="text-[12px] text-ink-3 hover:text-ink-2">← 캠페인 목록</Link>
        <h1 className="mt-2 text-[24px] font-bold tracking-[-0.01em]">새 캠페인</h1>
        <p className="mt-1.5 text-[13.5px] text-ink-2">
          제품과 목표를 채우면 에이전트가 바로 크리에이터를 찾기 시작합니다. 후보가 모이면 검토 요청이 올라옵니다.
        </p>
      </header>

      <form id="new-campaign" action={createCampaignAction} className="space-y-5">
        <Card>
          <CardBody className="space-y-4">
            <SectionLabel>브랜드 · 제품</SectionLabel>
            <Field name="brandProduct.name" label="제품명" placeholder="예: Hydra Serum" />
            <Field name="brandProduct.category" label="카테고리" placeholder="예: 스킨케어 / 세럼" />
            <Field
              name="brandProduct.description"
              label="제품 설명"
              hint="크리에이터에게 보낼 메시지의 바탕이 됩니다."
              placeholder="예: 수분 12시간 유지 · 끈적임 없음 · 진정 효과"
              textarea
            />
          </CardBody>
        </Card>

        <Card>
          <CardBody className="space-y-4">
            <SectionLabel>찾을 크리에이터</SectionLabel>
            <div className="grid grid-cols-2 gap-4">
              <Field name="targeting.creatorCount" label="크리에이터 수" type="number" min={1} defaultValue={3} hint="처음 모을 후보 규모입니다." />
              <EngagementField />
            </div>

            <div className="block">
              <span className="block text-[12.5px] font-medium text-ink mb-1.5">콘텐츠 언어</span>
              <p className="text-[11.5px] text-ink-3 mb-2">아래에서 골라 쉼표로 적어주세요.</p>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {LANG_OPTIONS.map((l) => (
                  <span
                    key={l.code}
                    className="inline-flex items-center gap-1.5 rounded-full bg-brand-soft text-brand-ink border border-line px-2.5 py-1 text-[11.5px] font-medium"
                  >
                    {l.label}
                    <span className="mono text-[10.5px] text-ink-3">{l.code}</span>
                  </span>
                ))}
              </div>
              <input
                name="targeting.languages"
                defaultValue="ko"
                placeholder="ko, en"
                className="w-full bg-surface border border-line rounded-xl px-3 py-2 text-[13px] text-ink mono placeholder:text-ink-3 outline-none focus:border-brand-ink transition-colors"
              />
            </div>

            <Field
              name="targeting.hashtags"
              label="해시태그 힌트"
              hint="선택 사항 · 쉼표로 구분"
              placeholder="예: 스킨케어, 케이뷰티"
            />
          </CardBody>
        </Card>

        <Card>
          <CardBody className="space-y-4">
            <SectionLabel>물류 · 목표</SectionLabel>
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                name="logistics.shipsSamples"
                defaultChecked
                className="mt-0.5 h-4 w-4 rounded border-line accent-[var(--color-brand)]"
              />
              <span>
                <span className="block text-[13px] font-medium text-ink">제품 샘플 발송</span>
                <span className="block text-[11.5px] text-ink-3 mt-0.5">협의된 크리에이터에게 샘플을 보냅니다.</span>
              </span>
            </label>
            <div className="grid grid-cols-2 gap-4">
              <Field name="goals.targetLivePosts" label="목표 게시물 수" type="number" min={1} defaultValue={3} hint="이 캠페인에서 올리고 싶은 게시물 개수입니다." />
              <Field
                name="goals.deadline"
                label="마감일"
                type="date"
                defaultValue={new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10)}
                hint="이 날짜까지 게시 완료를 목표로 합니다."
              />
            </div>
            <Field
              name="goals.budgetUsd"
              label="캠페인 예산 한도 (USD)"
              type="number"
              min={1}
              placeholder="예: 25"
              hint="이 캠페인에 쓸 최대 비용입니다. 비우면 기본 한도 $25가 적용됩니다."
            />
          </CardBody>
        </Card>
      </form>

      {/* sticky activation bar — primary CTA always in view */}
      <div className="fixed bottom-0 inset-x-0 z-10 bg-surface/95 backdrop-blur border-t border-line shadow-soft">
        <div className="max-w-3xl mx-auto px-8 py-3.5 flex items-center justify-between gap-4">
          <p className="text-[12px] text-ink-2 min-w-0">
            <span className="font-medium text-ink">시작하면</span> 에이전트가 크리에이터를 찾고, 예산 한도 안에서 첫 아웃리치를 보낼 수 있습니다.
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <Link href="/campaigns"><Button type="button" variant="secondary">취소</Button></Link>
            <Button type="submit" form="new-campaign" variant="primary" size="lg">캠페인 시작</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function EngagementField() {
  // The action receives a 0–1 value unchanged; the operator reads it as a %.
  return (
    <label className="block">
      <span className="block text-[12.5px] font-medium text-ink mb-1.5">최소 참여율 (%)</span>
      <div className="relative">
        <input
          name="targeting.minEngagementRate"
          type="number"
          min={0}
          max={1}
          step={0.005}
          defaultValue={0.02}
          className="w-full bg-surface border border-line rounded-xl px-3 py-2 pr-9 text-[13px] text-ink tnum placeholder:text-ink-3 outline-none focus:border-brand-ink transition-colors"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-ink-3">%</span>
      </div>
      <span className="block text-[11.5px] text-ink-3 mt-1">예: 2.0% = 0.02 로 입력</span>
    </label>
  );
}

function Field({
  name, label, placeholder, defaultValue, hint, type = "text", textarea, min, max, step,
}: {
  name: string; label: string; placeholder?: string; defaultValue?: string | number; hint?: string;
  type?: string; textarea?: boolean; min?: number; max?: number; step?: number;
}) {
  const fieldClass =
    "w-full bg-surface border border-line rounded-xl px-3 py-2 text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-brand-ink transition-colors";
  return (
    <label className="block">
      <span className="block text-[12.5px] font-medium text-ink mb-1.5">{label}</span>
      {textarea ? (
        <textarea
          name={name}
          rows={2}
          placeholder={placeholder}
          defaultValue={defaultValue}
          className={fieldClass}
        />
      ) : (
        <input
          name={name}
          type={type}
          placeholder={placeholder}
          defaultValue={defaultValue}
          min={min}
          max={max}
          step={step}
          className={fieldClass}
        />
      )}
      {hint && <span className="block text-[11.5px] text-ink-3 mt-1">{hint}</span>}
    </label>
  );
}
