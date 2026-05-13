import { NextResponse, type NextRequest } from "next/server";
import { CampaignBriefSchema, Events } from "@ss/contracts";
import { campaignRepo } from "@ss/db";
import { inngest } from "@ss/workflows";

/**
 * Thin public API — the only thing the web layer does for campaigns is:
 * validate a brief, persist a draft, and emit `campaign/submitted`. From there
 * the durable workflow owns everything. (Contrast v1: 18 campaign routes
 * mutating state from the UI.)
 *
 * SKELETON — auth (Auth.js v5) + rate-limit wiring is task P0-5.
 */
export async function POST(req: NextRequest) {
  const parsed = CampaignBriefSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_brief", details: parsed.error.flatten() }, { status: 400 });
  }
  const brief = parsed.data;
  const campaign = await campaignRepo.create({ brief, status: "running", stage: "overview", tracks: [] });
  await inngest.send({ name: Events.CampaignSubmitted, data: { campaignId: campaign.id, brief } });
  return NextResponse.json({ id: campaign.id }, { status: 201 });
}

export async function GET() {
  // TODO(phase-1, task W2): require session, return campaignRepo.listByWorkspace(...)
  return NextResponse.json({ error: "not_implemented" }, { status: 501 });
}
