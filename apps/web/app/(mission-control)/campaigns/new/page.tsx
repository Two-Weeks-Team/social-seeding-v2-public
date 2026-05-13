import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import Link from "next/link";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getServerSession } from "@/lib/auth";
import { campaignRepo } from "@ss/db";
import { CampaignBriefSchema, Events } from "@ss/contracts";
import { promptGuard, PromptGuardError } from "@/lib/prompt-guard";
import { inngest } from "@ss/workflows";

/**
 * W2 — New campaign. Two entry paths:
 *   1. Manual form (what this page renders) — always works, no API key needed.
 *   2. Intake conversation (POST /api/campaigns/intake → A-intake agent) —
 *      requires ANTHROPIC_API_KEY; the chat UI lands in a Phase-2 polish pass.
 *
 * The mockup (docs/previews/mission-control-timeline.html) shows the chat
 * pattern as the future direction. For Phase 1's exit demo, the manual form
 * is the supported flow.
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
    goals: { targetLivePosts: f["goals.targetLivePosts"], deadline: f["goals.deadline"] },
  };
  const briefParsed = CampaignBriefSchema.safeParse(briefInput);
  if (!briefParsed.success) return;
  const brief = briefParsed.data;

  const campaign = await campaignRepo.create({ brief, status: "running", stage: "overview", tracks: [] });
  await inngest.send({ name: Events.CampaignSubmitted, data: { campaignId: campaign.id, brief } });
  revalidatePath("/campaigns");
  redirect(`/campaigns/${campaign.id}`);
}

export default async function NewCampaignPage() {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");

  return (
    <div className="max-w-3xl mx-auto px-8 py-8">
      <header className="mb-5">
        <Link href="/campaigns" className="text-[11px] text-slate-500 hover:text-slate-900">← 캠페인 목록</Link>
        <h1 className="mt-2 text-[22px] font-semibold">새 캠페인</h1>
        <p className="mt-1 text-[13px] text-slate-500">
          brief를 채우면 brand-campaign 워크플로우가 즉시 시작됩니다 (overview → sourcing → 22명 후보 → approveShortlist 게이트).
        </p>
        <div className="mt-3 inline-flex items-center gap-2 text-[11px] text-slate-500">
          <Badge variant="slate">Phase 2</Badge>
          <span>대화형 intake (A-intake agent + SSE) 는 ANTHROPIC_API_KEY 가 들어오는 시점에 합쳐집니다.</span>
        </div>
      </header>

      <form action={createCampaignAction} className="space-y-4">
        <Card>
          <CardBody className="space-y-3">
            <SectionLabel>브랜드 · 제품</SectionLabel>
            <Field name="brandProduct.name" label="제품명" placeholder="Hydra Serum" />
            <Field name="brandProduct.category" label="카테고리" placeholder="skincare/serum" />
            <Field name="brandProduct.description" label="설명" placeholder="수분 12시간 유지 / 끈적임 없음 / 진정" textarea />
          </CardBody>
        </Card>

        <Card>
          <CardBody className="space-y-3">
            <SectionLabel>타겟팅</SectionLabel>
            <div className="grid grid-cols-2 gap-3">
              <Field name="targeting.creatorCount" label="크리에이터 수" type="number" min={1} defaultValue={3} />
              <Field name="targeting.minEngagementRate" label="최소 ER (0–1)" type="number" min={0} max={1} step={0.005} defaultValue={0.02} />
            </div>
            <Field name="targeting.languages" label="언어 (ISO 2-letter, 쉼표 구분)" defaultValue="ko" />
            <Field name="targeting.hashtags" label="해시태그 힌트 (쉼표 구분, 선택)" placeholder="스킨케어, kbeauty" />
          </CardBody>
        </Card>

        <Card>
          <CardBody className="space-y-3">
            <SectionLabel>물류 + 목표</SectionLabel>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" name="logistics.shipsSamples" defaultChecked /> 샘플 발송
            </label>
            <div className="grid grid-cols-2 gap-3">
              <Field name="goals.targetLivePosts" label="목표 live post 개수" type="number" min={1} defaultValue={3} />
              <Field name="goals.deadline" label="마감일 (YYYY-MM-DD)" type="date" defaultValue={new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10)} />
            </div>
          </CardBody>
        </Card>

        <div className="flex justify-end gap-2">
          <Link href="/campaigns"><Button type="button">취소</Button></Link>
          <Button type="submit" variant="primary">캠페인 시작 → sourcing</Button>
        </div>
      </form>
    </div>
  );
}

function Field({
  name, label, placeholder, defaultValue, type = "text", textarea, min, max, step,
}: {
  name: string; label: string; placeholder?: string; defaultValue?: string | number;
  type?: string; textarea?: boolean; min?: number; max?: number; step?: number;
}) {
  return (
    <label className="block">
      <span className="block text-[12px] text-slate-700 mb-1">{label}</span>
      {textarea ? (
        <textarea
          name={name}
          rows={2}
          placeholder={placeholder}
          defaultValue={defaultValue}
          className="w-full border border-slate-200 rounded px-2 py-1.5 text-[13px]"
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
          className="w-full border border-slate-200 rounded px-2 py-1.5 text-[13px]"
        />
      )}
    </label>
  );
}
