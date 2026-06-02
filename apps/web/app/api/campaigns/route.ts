import { NextResponse, type NextRequest } from "next/server";
import { CampaignBriefSchema, Events } from "@ss/contracts";
import { campaignRepo } from "@ss/db";
import { inngest } from "@ss/workflows";
import { denyIfDemo, getSessionOr401 } from "@/lib/auth";
import { promptGuard, PromptGuardError } from "@/lib/prompt-guard";

/**
 * Thin public API — the only thing the web layer does for campaigns is:
 * authenticate, run prompt-guard on the user-supplied text, validate the brief
 * (pinning workspaceId/createdBy to the session), persist a draft, and emit
 * `campaign/submitted`. From there the durable workflow owns everything.
 * (Contrast v1: 18 campaign routes mutating state from the UI.)
 */
export async function POST(req: NextRequest) {
  const auth = await getSessionOr401(req);
  if (!auth.ok) return auth.response;
  const { session } = auth;
  const denied = denyIfDemo(session);
  if (denied) return denied;

  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  // run prompt-guard on the free-text fields the agents will eventually see
  try {
    const bp = (raw.brandProduct ?? {}) as Record<string, unknown>;
    if (typeof bp.description === "string") promptGuard(bp.description, "brandProduct.description");
    if (typeof bp.name === "string") promptGuard(bp.name, "brandProduct.name");
    if (Array.isArray(bp.keyClaims)) {
      for (let i = 0; i < bp.keyClaims.length; i++) {
        const c = bp.keyClaims[i];
        if (typeof c === "string") promptGuard(c, `brandProduct.keyClaims[${i}]`);
      }
    }
  } catch (err) {
    if (err instanceof PromptGuardError) {
      return NextResponse.json({ error: "prompt_guard", reason: err.reason }, { status: 400 });
    }
    throw err;
  }

  // pin authorship + workspace to the session — never trust the body for these
  const briefInput = { ...raw, workspaceId: session.workspaceId, createdBy: session.userId };
  const parsed = CampaignBriefSchema.safeParse(briefInput);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_brief", details: parsed.error.flatten() }, { status: 400 });
  }
  const brief = parsed.data;

  const campaign = await campaignRepo.create({ brief, status: "running", stage: "overview", tracks: [] });
  await inngest.send({ name: Events.CampaignSubmitted, data: { campaignId: campaign.id, brief } });
  return NextResponse.json({ id: campaign.id }, { status: 201 });
}

export async function GET(req: NextRequest) {
  const auth = await getSessionOr401(req);
  if (!auth.ok) return auth.response;
  const campaigns = await campaignRepo.listByWorkspace(auth.session.workspaceId);
  return NextResponse.json({ campaigns });
}
