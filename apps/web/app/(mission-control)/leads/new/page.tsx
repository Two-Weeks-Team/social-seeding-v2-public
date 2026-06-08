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
 * /leads/new — new lead campaign brief form (C2 redesign). Operator pastes a list of
 * companies + the offer brief. On submit: leadCampaignRepo.create + emit the
 * lead-campaign event; the workflow takes over (company import -> research ->
 * proposal prep -> cold email). Presentation only — the action + field names are unchanged.
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
  //   "Company name | https://homepage.url"
  //   "Company name" (homepage omitted; rows without URLs are skipped by the workflow)
  const leadInputs = f.leadList
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, url] = line.split("|").map((s) => s.trim());
      return {
        companyName: name || "(Unnamed company)",
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
        <Link href="/leads" className="text-[12px] text-ink-3 hover:text-ink-2">← Lead campaigns</Link>
        <h1 className="mt-2 text-[24px] font-bold tracking-[-0.01em]">New lead campaign</h1>
        <p className="mt-1 text-[13.5px] text-ink-2 max-w-[560px]">
          Share the companies you want to pitch and your offer. Agents research each company, prepare pitch angles, and send cold email.
        </p>
      </header>

      {error && (
        <DiagnosticBanner
          tone="warn"
          title={error === "invalid" ? "Check the input values." : "The company list is empty."}
          className="mb-5"
        >
          {error === "invalid"
            ? "Some required fields are missing or incorrectly formatted. Check the campaign name, pitch summary, target replies, and deadline."
            : "Enter at least one company, one per line."}
        </DiagnosticBanner>
      )}

      <form action={createLeadCampaignAction} className="space-y-4">
        {/* ── brief ─────────────────────────────────────────── */}
        <Card><CardBody>
          <SectionLabel className="mb-3">Campaign summary</SectionLabel>
          <label htmlFor="name" className={LABEL}>Campaign name</label>
          <input
            id="name"
            name="name"
            required
            minLength={2}
            maxLength={120}
            placeholder="Pitch K-beauty brands"
            className={FIELD}
          />
        </CardBody></Card>

        <Card><CardBody>
          <SectionLabel className="mb-3">What we offer</SectionLabel>
          <label htmlFor="ourProduct.name" className={LABEL}>Product name</label>
          <input
            id="ourProduct.name"
            name="ourProduct.name"
            required
            defaultValue="Social Seeding"
            className={`${FIELD} mb-4`}
          />
          <label htmlFor="ourProduct.pitchSummary" className={LABEL}>One-line pitch (10+ chars)</label>
          <input
            id="ourProduct.pitchSummary"
            name="ourProduct.pitchSummary"
            required
            minLength={10}
            defaultValue="TikTok influencer marketing platform"
            className={`${FIELD} mb-4`}
          />
          <label htmlFor="ourProduct.keyClaims" className={LABEL}>Key strengths (comma-separated)</label>
          <input
            id="ourProduct.keyClaims"
            name="ourProduct.keyClaims"
            placeholder="Find creators by hashtag fit, automate reply handling"
            className={FIELD}
          />
        </CardBody></Card>

        <Card><CardBody>
          <SectionLabel className="mb-3">Target + cold email</SectionLabel>
          <label htmlFor="targeting.countries" className={LABEL}>Target countries (country codes, comma-separated)</label>
          <input
            id="targeting.countries"
            name="targeting.countries"
            required
            defaultValue="KR"
            className={`${FIELD} mono mb-4`}
          />
          <label htmlFor="outreach.toneNotes" className={LABEL}>Email tone notes (optional)</label>
          <input
            id="outreach.toneNotes"
            name="outreach.toneNotes"
            placeholder="Concise, no exaggeration"
            className={`${FIELD} mb-4`}
          />
          <label htmlFor="outreach.maxSendsPerBatch" className={LABEL}>Max emails per batch</label>
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
          <SectionLabel className="mb-3">Goals</SectionLabel>
          <label htmlFor="goals.targetReplies" className={LABEL}>Target replies</label>
          <input
            id="goals.targetReplies"
            name="goals.targetReplies"
            type="number"
            min="1"
            required
            defaultValue="5"
            className={`${FIELD} mono w-32 mb-4`}
          />
          <label htmlFor="goals.deadline" className={LABEL}>Deadline</label>
          <input
            id="goals.deadline"
            name="goals.deadline"
            type="date"
            required
            className={`${FIELD} mono w-52 mb-4`}
          />
          <label htmlFor="goals.budgetUsd" className={LABEL}>Budget (USD, optional)</label>
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
          <SectionLabel className="mb-3">Company list (max 200)</SectionLabel>
          <p className="text-[12.5px] text-ink-2 mb-2.5">
            Enter one company per line. Format: <span className="mono text-ink">Company name | https://homepage.url</span>
            <span className="text-ink-3"> · Rows without a homepage are hard to research and will be skipped automatically.</span>
          </p>
          <textarea
            name="leadList"
            required
            rows={10}
            placeholder={"Glow Tonic | https://glow-tonic.com\nHydra Co | https://hydra.example\nFresh Beauty | https://fresh.example"}
            className={`${FIELD} mono text-[12px] leading-relaxed`}
          />
        </CardBody></Card>

        <div className="flex items-center justify-end gap-3 pt-1">
          <Link href="/leads"><Button variant="secondary">Cancel</Button></Link>
          <Button variant="primary" type="submit">Start campaign →</Button>
        </div>
      </form>
    </div>
  );
}
