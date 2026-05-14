import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { getServerSession } from "@/lib/auth";
import { leadCampaignRepo } from "@ss/db";
import { Events, LeadCampaignBriefSchema } from "@ss/contracts";
import { inngest } from "@ss/workflows";

/**
 * /leads/new — Phase 5 P5-C4. Operator's brief form for a new lead
 * campaign. Imports a paste-list of companies via the textarea (one
 * row per line: "Company Name | https://homepage.url") + the brief.
 *
 * On submit: leadCampaignRepo.create + emit lead-campaign/submitted.
 * The lead-campaign workflow takes over (P5-C3): import → enrich →
 * research → fan-out lead-track.
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
  //   "Company Name | https://homepage.url"
  //   "Company Name" (homepage URL omitted; the workflow will flake it
  //                   at the no_homepage_url check)
  const leadInputs = f.leadList
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, url] = line.split("|").map((s) => s.trim());
      return {
        companyName: name ?? "(unnamed)",
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
      <header className="mb-6">
        <Link href="/leads" className="text-[11px] text-slate-500 hover:text-slate-900">← 리드</Link>
        <h1 className="mt-2 text-[22px] font-semibold">새 리드 캠페인</h1>
        <p className="mt-1 text-[13px] text-slate-500">
          회사 리스트를 붙여넣으면 crm.enrich(Modal+Kimi) → research 에이전트 → outreach가 자동 실행됩니다.
        </p>
        {error && (
          <div className="mt-3 text-[12px] text-rose-700">
            {error === "invalid" ? "입력값을 확인해주세요." : "리드 리스트가 비어있습니다."}
          </div>
        )}
      </header>

      <form action={createLeadCampaignAction} className="space-y-5">
        {/* ── brief ─────────────────────────────────────────── */}
        <Card><CardBody>
          <SectionLabel className="mb-3">캠페인 요약</SectionLabel>
          <label className="block text-[11px] text-slate-600 mb-1">캠페인 이름</label>
          <input name="name" required minLength={2} maxLength={120}
            placeholder="Pitch to K-beauty brands"
            className="w-full text-[13px] border border-slate-200 rounded-md px-3 py-2 mono" />
        </CardBody></Card>

        <Card><CardBody>
          <SectionLabel className="mb-3">우리가 파는 것</SectionLabel>
          <label className="block text-[11px] text-slate-600 mb-1">제품 이름</label>
          <input name="ourProduct.name" required defaultValue="Social Seeding"
            className="w-full text-[13px] border border-slate-200 rounded-md px-3 py-2 mb-3 mono" />
          <label className="block text-[11px] text-slate-600 mb-1">한 줄 요약 (≥10자)</label>
          <input name="ourProduct.pitchSummary" required minLength={10}
            defaultValue="TikTok influencer marketing platform"
            className="w-full text-[13px] border border-slate-200 rounded-md px-3 py-2 mb-3" />
          <label className="block text-[11px] text-slate-600 mb-1">핵심 클레임 (쉼표로 구분)</label>
          <input name="ourProduct.keyClaims"
            placeholder="finds creators by hashtag fit, auto-handles replies"
            className="w-full text-[13px] border border-slate-200 rounded-md px-3 py-2" />
        </CardBody></Card>

        <Card><CardBody>
          <SectionLabel className="mb-3">타겟팅 + outreach</SectionLabel>
          <label className="block text-[11px] text-slate-600 mb-1">국가 (ISO-3166, 쉼표로 구분)</label>
          <input name="targeting.countries" required defaultValue="KR"
            className="w-full text-[13px] border border-slate-200 rounded-md px-3 py-2 mb-3 mono" />
          <label className="block text-[11px] text-slate-600 mb-1">tone notes (선택)</label>
          <input name="outreach.toneNotes" placeholder="directness, no hype"
            className="w-full text-[13px] border border-slate-200 rounded-md px-3 py-2 mb-3" />
          <label className="block text-[11px] text-slate-600 mb-1">배치당 최대 발송</label>
          <input name="outreach.maxSendsPerBatch" type="number" min="1" max="200" defaultValue="20"
            className="w-32 text-[13px] border border-slate-200 rounded-md px-3 py-2 mono" />
        </CardBody></Card>

        <Card><CardBody>
          <SectionLabel className="mb-3">목표</SectionLabel>
          <label className="block text-[11px] text-slate-600 mb-1">목표 답신 수</label>
          <input name="goals.targetReplies" type="number" min="1" required defaultValue="5"
            className="w-32 text-[13px] border border-slate-200 rounded-md px-3 py-2 mb-3 mono" />
          <label className="block text-[11px] text-slate-600 mb-1">마감일 (YYYY-MM-DD)</label>
          <input name="goals.deadline" type="date" required
            className="w-48 text-[13px] border border-slate-200 rounded-md px-3 py-2 mb-3 mono" />
          <label className="block text-[11px] text-slate-600 mb-1">예산 USD (선택)</label>
          <input name="goals.budgetUsd" type="number" min="0" step="0.01" placeholder="100"
            className="w-32 text-[13px] border border-slate-200 rounded-md px-3 py-2 mono" />
        </CardBody></Card>

        <Card><CardBody>
          <SectionLabel className="mb-3">리드 리스트 (최대 200개)</SectionLabel>
          <p className="text-[11px] text-slate-500 mb-2">
            한 줄에 한 회사. 형식: <span className="mono">회사명 | https://homepage.url</span> (URL 없으면 자동 flake).
          </p>
          <textarea
            name="leadList"
            required
            rows={10}
            placeholder={"Glow Tonic | https://glow-tonic.kr\nHydra Co | https://hydra.kr\nFresh Beauty | https://fresh.kr"}
            className="w-full text-[12px] border border-slate-200 rounded-md px-3 py-2 mono"
          />
        </CardBody></Card>

        <div className="flex items-center justify-end gap-3">
          <Link href="/leads">
            <Button variant="secondary">취소</Button>
          </Link>
          <Button variant="primary" tone="approve">📤 캠페인 시작</Button>
        </div>
      </form>
    </div>
  );
}
