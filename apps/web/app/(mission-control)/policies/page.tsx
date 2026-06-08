import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle, CardSubtitle, SectionLabel } from "@/components/ui/card";
import { StatusTag } from "@/components/ui/status-tag";
import { getServerSession } from "@/lib/auth";
import { workspaceRepo, defaultPolicy } from "@ss/db";
import { type GateConfig, type WorkspacePolicy } from "@ss/contracts";
import { gateKo } from "@/lib/labels";

/**
 * Autonomy policy editor. All 5 gates editable from one form:
 *   · approveShortlist    — after sourcing+vetting, before tracks persist.
 *                           Predicate: fitScoreLt (skip easy approvals).
 *   · approveOutreachSend — before each gmail.send for the first outreach.
 *                           Predicate: spamScoreGte + followerCountGte.
 *   · approveReplyResponse — before sending a drafted reply OR when the
 *                           classifier escalates negotiating/declined.
 *                           Predicate: replyClassIn (escalate certain
 *                           classifications even when mode='auto_unless')
 *                           + proposedRateUsdGte.
 *   · approveShipment     — before logistics agent + carrier handoff.
 *                           Predicate: followerCountGte.
 *   · approveStageAdvance — still disabled (coming soon).
 *
 * Save is a server action — no client JS. Changes affect new campaigns only;
 * in-flight runs read the policy snapshot taken at workflow.start (the
 * workflow's step.run("plan") captures it).
 */

const REPLY_CLASS_OPTIONS = [
  "interested",
  "needs_info",
  "negotiating",
  "not_now",
  "declined",
  "out_of_office",
  "unsubscribe",
  "unrelated",
] as const;

/** Reply-classification → operator label. Form value stays the enum string. */
const REPLY_CLASS_KO: Record<(typeof REPLY_CLASS_OPTIONS)[number], string> = {
  interested: "Interested",
  needs_info: "Needs info",
  negotiating: "Negotiating",
  not_now: "Not now",
  declined: "Declined",
  out_of_office: "Out of office auto-reply",
  unsubscribe: "Unsubscribe",
  unrelated: "Unrelated reply",
};

/** Autonomy level → operator label (the form `level` value stays the enum). */
const LEVEL_KO: Record<WorkspacePolicy["level"], string> = {
  copilot: "Copilot",
  checkpointed: "Checkpointed",
  autonomous: "Autonomous",
};

/** Gate-mode → operator label (the radio value stays the enum). */
const MODE_KO: Record<GateConfig["mode"], string> = {
  always_ask: "Always ask",
  auto: "Auto",
  auto_unless: "Auto unless",
};

async function savePolicyAction(formData: FormData): Promise<void> {
  "use server";
  const session = await getServerSession();
  if (!session) redirect("/sign-in");

  const ModeEnum = z.enum(["always_ask", "auto", "auto_unless"]);
  const PolicyForm = z.object({
    level: z.enum(["copilot", "checkpointed", "autonomous"]),
    "gate.approveShortlist.mode": ModeEnum,
    "gate.approveShortlist.fitScoreLt": z.coerce.number().min(0).max(1).optional(),
    "gate.approveOutreachSend.mode": ModeEnum,
    "gate.approveOutreachSend.spamScoreGte": z.coerce.number().min(0).max(10).optional(),
    "gate.approveOutreachSend.followerCountGte": z.coerce.number().int().nonnegative().optional(),
    "gate.approveReplyResponse.mode": ModeEnum,
    "gate.approveReplyResponse.proposedRateUsdGte": z.coerce.number().int().nonnegative().optional(),
    "gate.approveShipment.mode": ModeEnum,
    "gate.approveShipment.followerCountGte": z.coerce.number().int().nonnegative().optional(),
    "budgets.maxUsdPerCampaign": z.coerce.number().positive(),
    "budgets.maxUsdPerWorkspaceMonthly": z.coerce.number().positive(),
    "voice.toneNotes": z.string().max(2000).optional(),
    "voice.bannedPhrases": z.string().max(2000).optional(),
  });

  const raw: Record<string, unknown> = Object.fromEntries(formData.entries());
  // replyClassIn is multi-select via getAll
  const replyClassIn = formData.getAll("gate.approveReplyResponse.replyClassIn").map(String);

  const parsed = PolicyForm.safeParse(raw);
  if (!parsed.success) {
    // soft-fail: page reload shows latest persisted state (no toast yet)
    return;
  }
  const f = parsed.data;
  const existing = await workspaceRepo.getPolicy(session.workspaceId);

  function gateFor(
    mode: GateConfig["mode"],
    predicates: NonNullable<GateConfig["escalateIf"]>,
  ): GateConfig {
    const trimmed = Object.fromEntries(
      Object.entries(predicates).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)),
    ) as NonNullable<GateConfig["escalateIf"]>;
    const hasAny = Object.keys(trimmed).length > 0;
    return { mode, escalateIf: mode === "auto_unless" && hasAny ? trimmed : undefined };
  }

  const validReplyClasses = replyClassIn.filter((c) =>
    (REPLY_CLASS_OPTIONS as readonly string[]).includes(c),
  );

  const next: WorkspacePolicy = {
    ...existing,
    level: f.level,
    gates: {
      ...existing.gates,
      approveShortlist: gateFor(f["gate.approveShortlist.mode"], {
        fitScoreLt: f["gate.approveShortlist.fitScoreLt"],
      }),
      approveOutreachSend: gateFor(f["gate.approveOutreachSend.mode"], {
        spamScoreGte: f["gate.approveOutreachSend.spamScoreGte"],
        followerCountGte: f["gate.approveOutreachSend.followerCountGte"],
      }),
      approveReplyResponse: gateFor(f["gate.approveReplyResponse.mode"], {
        proposedRateUsdGte: f["gate.approveReplyResponse.proposedRateUsdGte"],
        ...(validReplyClasses.length > 0 ? { replyClassIn: validReplyClasses } : {}),
      }),
      approveShipment: gateFor(f["gate.approveShipment.mode"], {
        followerCountGte: f["gate.approveShipment.followerCountGte"],
      }),
    },
    budgets: {
      maxUsdPerCampaign: f["budgets.maxUsdPerCampaign"],
      maxUsdPerWorkspaceMonthly: f["budgets.maxUsdPerWorkspaceMonthly"],
    },
    voice: {
      ...existing.voice,
      toneNotes: f["voice.toneNotes"] ?? "",
      bannedPhrases: (f["voice.bannedPhrases"] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
    updatedAt: new Date(),
  };
  await workspaceRepo.savePolicy(next);
  revalidatePath("/policies");
}

const LEVEL_DESCRIPTIONS: Record<WorkspacePolicy["level"], string> = {
  copilot: "Agents only suggest; humans confirm every action",
  checkpointed: "Agents execute with approval gates at each stage (default)",
  autonomous: "Escalate only exceptions after trust is established",
};

/**
 * Level → gate-defaults mapping. Clicking a preset mass-sets the 5 gates to
 * match the chosen autonomy level — a 1-click "shift the whole workspace's
 * posture" instead of editing 5 toggles.
 *
 *  · copilot       — all 5 gates always_ask (max friction, max control)
 *  · checkpointed  — same as copilot for now; predicates left empty
 *  · autonomous    — most gates auto_unless with conservative thresholds;
 *                    stage-advance auto.
 */
function presetGatesFor(level: WorkspacePolicy["level"]): WorkspacePolicy["gates"] {
  if (level === "autonomous") {
    return {
      approveShortlist: { mode: "auto_unless", escalateIf: { fitScoreLt: 0.7 } },
      approveOutreachSend: { mode: "auto_unless", escalateIf: { spamScoreGte: 6 } },
      approveReplyResponse: {
        mode: "auto_unless",
        escalateIf: { replyClassIn: ["negotiating", "declined", "unsubscribe"] },
      },
      approveStageAdvance: { mode: "auto" },
      // The 3 required HITL gates stay always_ask even in the autonomous
      // preset (shipment/content/budget = irreversible/brand/money), each
      // with a non-blocking 24-business-hour timeout fallback.
      approveShipment: { mode: "always_ask", timeout: { businessHours: 24, onTimeout: "abandon" } },
      approveContent: { mode: "always_ask", timeout: { businessHours: 24, onTimeout: "auto_proceed" } },
      approveBudget: { mode: "always_ask", timeout: { businessHours: 24, onTimeout: "abandon" } },
    };
  }
  // copilot + checkpointed: all gates ask. The user can still loosen
  // individual gates from the form below — this is just the baseline.
  const ask = { mode: "always_ask" as const };
  return {
    approveShortlist: ask,
    approveOutreachSend: ask,
    approveReplyResponse: ask,
    approveShipment: ask,
    approveStageAdvance: ask,
    approveContent: ask,
    approveBudget: ask,
  };
}

async function applyPresetAction(formData: FormData): Promise<void> {
  "use server";
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  const level = z.enum(["copilot", "checkpointed", "autonomous"]).parse(formData.get("level"));
  const existing = await workspaceRepo.getPolicy(session.workspaceId);
  const next: WorkspacePolicy = {
    ...existing,
    level,
    gates: presetGatesFor(level),
    updatedAt: new Date(),
  };
  await workspaceRepo.savePolicy(next);
  revalidatePath("/policies");
}

/**
 * Tri-state mode toggle for a gate (always ask / auto / auto unless).
 * Pure presentational segmented control — radio `name` is scoped via the
 * `gateKey` to match the savePolicyAction schema keys exactly.
 */
function ModeToggle({
  gateKey,
  current,
}: {
  gateKey: "approveShortlist" | "approveOutreachSend" | "approveReplyResponse" | "approveShipment";
  current: GateConfig["mode"];
}) {
  return (
    <div className="inline-flex items-center gap-0.5 bg-surface-2 border border-line rounded-xl p-0.5">
      {(["always_ask", "auto", "auto_unless"] as const).map((mode) => (
        <label key={mode} className="cursor-pointer">
          <input
            type="radio"
            name={`gate.${gateKey}.mode`}
            value={mode}
            defaultChecked={current === mode}
            className="peer sr-only"
          />
          <span className="block px-3 py-1 text-[12px] text-ink-2 rounded-lg transition-colors peer-checked:bg-surface peer-checked:text-ink peer-checked:font-semibold peer-checked:shadow-soft">
            {MODE_KO[mode]}
          </span>
        </label>
      ))}
    </div>
  );
}

async function toggleV2RolloutAction(formData: FormData): Promise<void> {
  "use server";
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  // Only the workspace owner or an admin member can flip the rollout flag.
  // A non-owner member submitting the form (e.g. via a stale page they still
  // have permission to view) must not be able to redirect or roll back the
  // entire workspace. We treat unauthorized attempts as a silent no-op +
  // redirect back to /policies — no "forbidden" leak that confirms the
  // workspace exists vs the user's role.
  const allowed = await workspaceRepo.isOwnerOrAdmin(session.workspaceId, session.userId);
  if (!allowed) {
    revalidatePath("/policies");
    return;
  }
  const next = formData.get("enable") === "true";
  await workspaceRepo.setV2Enabled(session.workspaceId, next);
  revalidatePath("/policies");
}

/** Shared input class — C2 hairline field on the ivory surface. */
const FIELD =
  "mono bg-surface border border-line rounded-xl px-3 py-1.5 text-[13px] text-ink outline-none focus:border-brand-ink/40 tnum";

/** One labelled threshold row: human label + comparator + number field. */
function Threshold({
  label,
  hint,
  prefix,
  comparator,
  children,
}: {
  label: string;
  hint?: string;
  prefix?: string;
  comparator: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[12px] text-ink-2 font-medium">{label}</div>
      {hint ? <div className="text-[11px] text-ink-3 mt-0.5 leading-relaxed">{hint}</div> : null}
      <div className="mt-1.5 flex items-center gap-2 text-[12px]">
        {prefix ? <span className="text-ink-3">{prefix}</span> : null}
        <span className="text-ink-3">{comparator}</span>
        {children}
      </div>
    </div>
  );
}

export default async function PoliciesPage() {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");

  const [policy, v2Enabled, canRollout] = await Promise.all([
    workspaceRepo.getPolicy(session.workspaceId).then((p) => p ?? defaultPolicy(session.workspaceId)),
    workspaceRepo.isV2Enabled(session.workspaceId),
    workspaceRepo.isOwnerOrAdmin(session.workspaceId, session.userId),
  ]);
  const sl = policy.gates.approveShortlist;
  const os = policy.gates.approveOutreachSend;
  const rr = policy.gates.approveReplyResponse;
  const sh = policy.gates.approveShipment;

  return (
    <div className="max-w-3xl mx-auto px-8 py-8">
      <header className="mb-6">
        <h1 className="text-[24px] font-bold tracking-[-0.01em] text-ink">Autonomy policy</h1>
        <p className="mt-1 text-[13.5px] text-ink-2 leading-relaxed">
          Decide how much agents can handle. Changes apply to new campaigns only and do not affect campaigns already in progress.
        </p>
      </header>

      {/* Active version switch — writes the rollout flag on the shared workspace doc.
          Sibling card (not nested in the save form). */}
      <Card className="mb-5">
        <CardBody>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <SectionLabel>Active version switch</SectionLabel>
                <StatusTag tone={v2Enabled ? "ok" : "neutral"} size="sm">
                  {v2Enabled ? "New version active" : "Legacy version active"}
                </StatusTag>
              </div>
              <div className="mt-1.5 text-[12.5px] text-ink-2 leading-relaxed">
                Decide whether workspace users should land on the new operations screen.
              </div>
            </div>
            {canRollout ? (
              <form action={toggleV2RolloutAction}>
                <input type="hidden" name="enable" value={v2Enabled ? "false" : "true"} />
                <Button variant="secondary" tone={v2Enabled ? "warn" : "approve"}>
                  {v2Enabled ? "← Switch to legacy" : "→ Switch to new version"}
                </Button>
              </form>
            ) : (
              <span className="text-[11px] text-ink-3 whitespace-nowrap">Admins only</span>
            )}
          </div>
        </CardBody>
      </Card>

      {/*
        Presets card lives OUTSIDE the save form because the per-preset buttons
        are their own <form action=applyPresetAction>. Nested forms are invalid
        HTML and would SSR-render the inner forms as no-ops while truncating the
        outer save form mid-way. Keep them as sibling cards.
      */}
      <Card className="mb-5">
        <CardBody>
          <div className="flex items-start justify-between gap-4 mb-3">
            <div className="min-w-0">
              <SectionLabel className="mb-1">One-click presets</SectionLabel>
              <div className="text-[12.5px] text-ink-2 leading-relaxed">
                Pick a level to update all gates at once. You can still tune individual gates below.
              </div>
            </div>
            <span className="text-[11px] text-ink-3 whitespace-nowrap">
              Current <span className="font-semibold text-ink-2">{LEVEL_KO[policy.level]}</span>
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {(["copilot", "checkpointed", "autonomous"] as const).map((lvl) => (
              <form key={lvl} action={applyPresetAction}>
                <input type="hidden" name="level" value={lvl} />
                <Button
                  variant="secondary"
                  tone={lvl === "autonomous" ? "approve" : lvl === "copilot" ? "warn" : "neutral"}
                >
                  Apply {LEVEL_KO[lvl]}
                </Button>
              </form>
            ))}
          </div>
        </CardBody>
      </Card>

      <form action={savePolicyAction} className="space-y-5">
        {/* ── Level radio (the form's own `level` field — independent of the
              preset buttons above) ──────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>Autonomy level</CardTitle>
            <span className="text-[11px] text-ink-3">Applied on save</span>
          </CardHeader>
          <CardBody>
            <div className="grid grid-cols-3 gap-3">
              {(["copilot", "checkpointed", "autonomous"] as const).map((lvl) => {
                const isCurrent = policy.level === lvl;
                return (
                  <label
                    key={lvl}
                    className={`border rounded-2xl p-3.5 cursor-pointer transition-colors ${
                      isCurrent
                        ? "border-brand-ink/40 bg-brand-soft/40"
                        : "border-line hover:bg-surface-2"
                    }`}
                  >
                    <input
                      type="radio"
                      name="level"
                      value={lvl}
                      defaultChecked={isCurrent}
                      className="sr-only"
                    />
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-bold text-ink">{LEVEL_KO[lvl]}</span>
                      {lvl === "checkpointed" && (
                        <span className="text-[10px] uppercase tracking-[0.06em] text-brand-ink font-semibold">Default</span>
                      )}
                    </div>
                    <div className="mt-1.5 text-[11.5px] text-ink-2 leading-relaxed">
                      {LEVEL_DESCRIPTIONS[lvl]}
                    </div>
                  </label>
                );
              })}
            </div>
          </CardBody>
        </Card>

        {/* ── Gates ───────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>Gate behavior</CardTitle>
            <CardSubtitle>How human confirmation is requested at each stage</CardSubtitle>
          </CardHeader>
          <CardBody className="space-y-3">
            {/* approveShortlist */}
            <Card flat className="bg-surface-2/40">
              <CardBody>
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <div className="text-[14px] font-bold text-ink">{gateKo("approveShortlist")}</div>
                    <div className="text-[12px] text-ink-3 mt-0.5">After sourcing and vetting, before the candidate list is finalized</div>
                  </div>
                  <ModeToggle gateKey="approveShortlist" current={sl.mode} />
                </div>
                <Threshold
                  label="Ask a human when fit is low"
                  hint="In auto-unless mode, ask a human when the fit score is below this value."
                  comparator="Ask when below <"
                >
                  <input
                    type="number"
                    name="gate.approveShortlist.fitScoreLt"
                    min={0}
                    max={1}
                    step={0.05}
                    defaultValue={sl.escalateIf?.fitScoreLt ?? 0.6}
                    className={`${FIELD} w-20`}
                  />
                </Threshold>
              </CardBody>
            </Card>

            {/* approveOutreachSend */}
            <Card flat className="bg-surface-2/40">
              <CardBody>
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <div className="text-[14px] font-bold text-ink">{gateKo("approveOutreachSend")}</div>
                    <div className="text-[12px] text-ink-3 mt-0.5">Right before the first outreach email is sent to a creator</div>
                  </div>
                  <ModeToggle gateKey="approveOutreachSend" current={os.mode} />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <Threshold
                    label="Ask when spam risk is high"
                    hint="Escalate to a human when the email spam score is at or above this value."
                    comparator="Ask when at least ≥"
                  >
                    <input
                      type="number"
                      name="gate.approveOutreachSend.spamScoreGte"
                      min={0}
                      max={10}
                      step={1}
                      defaultValue={os.escalateIf?.spamScoreGte ?? 5}
                      className={`${FIELD} w-20`}
                    />
                  </Threshold>
                  <Threshold
                    label="Ask for major influencers"
                    hint="A human reviews creators whose follower count is at or above this value."
                    comparator="Followers at least ≥"
                  >
                    <input
                      type="number"
                      name="gate.approveOutreachSend.followerCountGte"
                      min={0}
                      step={10_000}
                      defaultValue={os.escalateIf?.followerCountGte ?? 500_000}
                      className={`${FIELD} w-32`}
                    />
                  </Threshold>
                </div>
              </CardBody>
            </Card>

            {/* approveReplyResponse */}
            <Card flat className="bg-surface-2/40">
              <CardBody>
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <div className="text-[14px] font-bold text-ink">{gateKo("approveReplyResponse")}</div>
                    <div className="text-[12px] text-ink-3 mt-0.5">
                      Before sending an automatic reply · negotiating or declined replies are escalated to a human
                    </div>
                  </div>
                  <ModeToggle gateKey="approveReplyResponse" current={rr.mode} />
                </div>
                <div className="space-y-4">
                  <Threshold
                    label="Ask when the proposed rate is high"
                    hint="A human reviews creator-proposed rates at or above this amount."
                    prefix="$"
                    comparator="Ask when at least ≥"
                  >
                    <input
                      type="number"
                      name="gate.approveReplyResponse.proposedRateUsdGte"
                      min={0}
                      step={50}
                      defaultValue={rr.escalateIf?.proposedRateUsdGte ?? 500}
                      className={`${FIELD} w-24`}
                    />
                  </Threshold>
                  <div>
                    <div className="text-[12px] text-ink-2 font-medium">Reply types humans always review</div>
                    <div className="text-[11px] text-ink-3 mt-0.5 leading-relaxed">Replies classified as selected types are escalated instead of auto-answered.</div>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {REPLY_CLASS_OPTIONS.map((cls) => {
                        const checked = (rr.escalateIf?.replyClassIn ?? ["negotiating", "declined", "unsubscribe"]).includes(cls);
                        return (
                          <label
                            key={cls}
                            className="inline-flex items-center gap-1.5 border border-line rounded-xl px-2.5 py-1 text-[12px] text-ink-2 cursor-pointer hover:bg-surface-2 transition-colors has-[:checked]:bg-brand-soft has-[:checked]:text-brand-ink has-[:checked]:border-brand-ink/30 has-[:checked]:font-semibold"
                          >
                            <input
                              type="checkbox"
                              name="gate.approveReplyResponse.replyClassIn"
                              value={cls}
                              defaultChecked={checked}
                              className="sr-only"
                            />
                            {REPLY_CLASS_KO[cls]}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </CardBody>
            </Card>

            {/* approveShipment */}
            <Card flat className="bg-surface-2/40">
              <CardBody>
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <div className="text-[14px] font-bold text-ink">{gateKo("approveShipment")}</div>
                    <div className="text-[12px] text-ink-3 mt-0.5">
                      Right before warehouse pickup — a human checks the address and items before shipment
                    </div>
                  </div>
                  <ModeToggle gateKey="approveShipment" current={sh.mode} />
                </div>
                <Threshold
                  label="Ask for major influencers or high-value samples"
                  hint="A human reviews shipment before sending when follower count is at or above this value."
                  comparator="Followers at least ≥"
                >
                  <input
                    type="number"
                    name="gate.approveShipment.followerCountGte"
                    min={0}
                    step={10_000}
                    defaultValue={sh.escalateIf?.followerCountGte ?? 100_000}
                    className={`${FIELD} w-32`}
                  />
                </Threshold>
              </CardBody>
            </Card>

            {/* Disabled gate — coming soon */}
            <div className="border border-dashed border-line rounded-2xl px-4 py-3 flex justify-between items-center">
              <span className="text-[13px] text-ink-3">{gateKo("approveStageAdvance")}</span>
              <span className="text-[11px] text-ink-3 bg-surface-2 rounded-full px-2.5 py-0.5 font-medium">Soon</span>
            </div>
          </CardBody>
        </Card>

        {/* ── Budgets ────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>Budget</CardTitle>
            <CardSubtitle>Limits and alerts</CardSubtitle>
          </CardHeader>
          <CardBody>
            <div className="grid grid-cols-2 gap-4">
              <label className="block">
                <span className="block text-[13px] font-medium text-ink">Max cost per campaign</span>
                <span className="block text-[11px] text-ink-3 mt-0.5">Block when the limit is exceeded</span>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="text-ink-3 text-[12px]">$</span>
                  <input
                    type="number"
                    name="budgets.maxUsdPerCampaign"
                    min={1}
                    step={1}
                    defaultValue={policy.budgets.maxUsdPerCampaign}
                    className={`${FIELD} w-32`}
                  />
                </div>
              </label>
              <label className="block">
                <span className="block text-[13px] font-medium text-ink">Monthly workspace max cost</span>
                <span className="block text-[11px] text-ink-3 mt-0.5">Alert threshold when exceeded</span>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="text-ink-3 text-[12px]">$</span>
                  <input
                    type="number"
                    name="budgets.maxUsdPerWorkspaceMonthly"
                    min={1}
                    step={1}
                    defaultValue={policy.budgets.maxUsdPerWorkspaceMonthly}
                    className={`${FIELD} w-32`}
                  />
                </div>
              </label>
            </div>
          </CardBody>
        </Card>

        {/* ── Brand voice ────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>Brand voice</CardTitle>
            <CardSubtitle>Applied to outreach writing · soon</CardSubtitle>
          </CardHeader>
          <CardBody>
            <label className="block mb-3">
              <span className="block text-[13px] font-medium text-ink mb-1.5">Tone notes</span>
              <textarea
                name="voice.toneNotes"
                rows={2}
                defaultValue={policy.voice.toneNotes}
                placeholder="Example: polite but concise. Avoid bragging. Keep the first line under 14 characters."
                className="w-full bg-surface border border-line rounded-xl p-2.5 text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-brand-ink/40"
              />
            </label>
            <label className="block">
              <span className="block text-[13px] font-medium text-ink mb-1.5">Banned phrases <span className="text-ink-3 font-normal">(comma-separated)</span></span>
              <input
                name="voice.bannedPhrases"
                type="text"
                defaultValue={policy.voice.bannedPhrases.join(", ")}
                placeholder="Example: unbelievable, miracle deal, dear influencer"
                className="w-full bg-surface border border-line rounded-xl p-2.5 text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-brand-ink/40"
              />
            </label>
          </CardBody>
        </Card>

        <div className="flex justify-end gap-2">
          <Button type="reset" variant="ghost">Reset</Button>
          <Button type="submit" variant="primary">Save policy</Button>
        </div>
      </form>
    </div>
  );
}
