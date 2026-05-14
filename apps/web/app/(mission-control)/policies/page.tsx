import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { getServerSession } from "@/lib/auth";
import { workspaceRepo, defaultPolicy } from "@ss/db";
import { type GateConfig, type WorkspacePolicy } from "@ss/contracts";

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
 *   · approveShipment     — before logistics agent + carrier handoff
 *                           (P3-C6 producer). Predicate: followerCountGte.
 *   · approveStageAdvance — Phase 4; still disabled.
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
  copilot: "에이전트가 제안만, 모든 액션은 사람이 확인",
  checkpointed: "에이전트가 실행하되 각 단계에 승인 게이트 (기본)",
  autonomous: "예외 시에만 escalate · 신뢰가 쌓인 후",
};

/**
 * Level → gate-defaults mapping. P4-C6: clicking "프리셋 적용" mass-sets
 * the 5 gates to match the chosen autonomy level — a 1-click "shift the
 * whole workspace's posture" instead of editing 5 toggles.
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
      approveShipment: { mode: "auto_unless", escalateIf: { followerCountGte: 1_000_000 } },
      approveStageAdvance: { mode: "auto" },
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
 * Tri-state mode toggle for a gate (always_ask / auto / auto_unless).
 * Pure presentational — names are scoped via the `gateKey` to match
 * the savePolicyAction schema keys.
 */
function ModeToggle({
  gateKey,
  current,
}: {
  gateKey: "approveShortlist" | "approveOutreachSend" | "approveReplyResponse" | "approveShipment";
  current: GateConfig["mode"];
}) {
  return (
    <div className="flex items-center gap-1 bg-slate-100 border border-slate-200 rounded-md p-0.5 w-fit">
      {(["always_ask", "auto", "auto_unless"] as const).map((mode) => (
        <label key={mode} className="cursor-pointer">
          <input
            type="radio"
            name={`gate.${gateKey}.mode`}
            value={mode}
            defaultChecked={current === mode}
            className="peer sr-only"
          />
          <span className="block px-3 py-1 text-[12px] text-slate-600 rounded peer-checked:bg-white peer-checked:text-slate-900 peer-checked:shadow-sm peer-checked:font-medium transition-colors">
            {mode}
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
  // P6 codex review P1#1: only the workspace owner or an admin member
  // can flip the v2 rollout flag. A non-owner member submitting the
  // form (e.g. via a stale page they still have permission to view)
  // must not be able to redirect or roll back the entire workspace.
  // We treat unauthorized attempts as a silent no-op + redirect back
  // to /policies — no "forbidden" leak that confirms the workspace
  // exists vs the user's role.
  const allowed = await workspaceRepo.isOwnerOrAdmin(session.workspaceId, session.userId);
  if (!allowed) {
    revalidatePath("/policies");
    return;
  }
  const next = formData.get("enable") === "true";
  await workspaceRepo.setV2Enabled(session.workspaceId, next);
  revalidatePath("/policies");
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
        <h1 className="text-[22px] font-semibold text-slate-900">자율성 정책</h1>
        <p className="mt-1 text-[13px] text-slate-500">
          에이전트에게 어디까지 맡길지 정합니다. 변경 사항은 새 캠페인부터 적용됩니다 (진행 중 캠페인은 영향 없음).
        </p>
      </header>

      {/* P6-C2 — v1 → v2 rollout toggle. Writes `v2Enabled` on the
          shared workspaces doc; v1's frontend reads it to redirect
          users into v2. Sibling card (not nested in the save form). */}
      <Card className="mb-5"><CardBody>
        <div className="flex items-start justify-between gap-4">
          <div>
            <SectionLabel className="mb-1">v1 → v2 롤아웃</SectionLabel>
            <div className="text-[12px] text-slate-600 leading-relaxed">
              이 워크스페이스의 v1 프론트엔드 사용자를 v2로 리디렉트할지 결정합니다.
              <span className="text-slate-400 ml-1">
                현재 상태:{" "}
                <Badge variant={v2Enabled ? "emerald" : "slate"}>
                  {v2Enabled ? "v2 활성화" : "v1 사용 중"}
                </Badge>
              </span>
            </div>
          </div>
          {canRollout ? (
            <form action={toggleV2RolloutAction}>
              <input type="hidden" name="enable" value={v2Enabled ? "false" : "true"} />
              <Button
                variant="secondary"
                tone={v2Enabled ? "warn" : "approve"}
              >
                {v2Enabled ? "← v1으로 롤백" : "→ v2 활성화"}
              </Button>
            </form>
          ) : (
            <span className="text-[11px] text-slate-500 whitespace-nowrap">
              owner / admin only
            </span>
          )}
        </div>
      </CardBody></Card>

      {/*
        P4 codex review P2#2: presets card lives OUTSIDE the save form
        because the per-preset buttons are their own <form action=
        applyPresetAction>. Nested forms are invalid HTML and would have
        SSR-rendered the inner forms as no-ops while truncating the outer
        save form mid-way. Keep them as sibling cards.
      */}
      <Card className="mb-5">
        <CardBody>
          <div className="flex items-start justify-between gap-4 mb-3">
            <div>
              <SectionLabel className="mb-1">원클릭 프리셋 적용</SectionLabel>
              <div className="text-[12px] text-slate-600 leading-relaxed">
                레벨을 누르면 5개 게이트가 일괄로 그 레벨에 맞게 세팅됩니다.
                <span className="text-slate-400 ml-1">
                  개별 게이트는 아래 폼에서 다시 조정 가능합니다.
                </span>
              </div>
            </div>
            <span className="text-[10px] text-slate-500 whitespace-nowrap">
              현재: <span className="mono font-medium">{policy.level}</span>
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
                  {lvl} 적용
                </Button>
              </form>
            ))}
          </div>
        </CardBody>
      </Card>

      <form action={savePolicyAction} className="space-y-5">
        {/* ── Level radio (the form's own `level` field — independent
              of the preset buttons above) ──────────────────────────── */}
        <Card>
          <CardBody>
            <div className="flex items-center justify-between mb-3">
              <SectionLabel>자율 수준 (저장 시 적용)</SectionLabel>
              <span className="text-[10px] text-slate-500">
                현재: <span className="mono font-medium">{policy.level}</span>
              </span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {(["copilot", "checkpointed", "autonomous"] as const).map((lvl) => {
                const isCurrent = policy.level === lvl;
                return (
                  <label
                    key={lvl}
                    className={`border rounded-lg p-3 cursor-pointer transition-colors ${
                      isCurrent
                        ? "border-blue-500 bg-blue-50/30"
                        : "border-slate-200 hover:border-slate-300"
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
                      <span className="text-[14px] font-medium text-slate-900">{lvl}</span>
                      {lvl === "checkpointed" && !isCurrent && <Badge variant="slate">기본</Badge>}
                    </div>
                    <div className="mt-1 text-[11px] text-slate-600 leading-relaxed">
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
          <CardBody>
            <SectionLabel className="mb-3">게이트별 동작</SectionLabel>

            {/* approveShortlist */}
            <div className="border border-slate-200 rounded-md p-4 mb-3">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="text-[14px] font-medium text-slate-900">approveShortlist</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">sourcing + vetting 끝나고 후보 리스트 확정 전</div>
                </div>
              </div>
              <ModeToggle gateKey="approveShortlist" current={sl.mode} />
              <div className="mt-3">
                <label className="block text-[11px] text-slate-600 mb-1">
                  <span className="mono">auto_unless</span> 시 escalate 조건: fitScore가 아래 미만이면 사람한테 묻습니다
                </label>
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="mono text-slate-500">fitScoreLt &lt;</span>
                  <input
                    type="number"
                    name="gate.approveShortlist.fitScoreLt"
                    min={0}
                    max={1}
                    step={0.05}
                    defaultValue={sl.escalateIf?.fitScoreLt ?? 0.6}
                    className="mono w-20 border border-slate-200 rounded px-2 py-1 text-[12px]"
                  />
                </div>
              </div>
            </div>

            {/* approveOutreachSend */}
            <div className="border border-slate-200 rounded-md p-4 mb-3">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="text-[14px] font-medium text-slate-900">approveOutreachSend</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">creator-track 의 첫 outreach 발송 전 (gmail.send 직전)</div>
                </div>
              </div>
              <ModeToggle gateKey="approveOutreachSend" current={os.mode} />
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-slate-600 mb-1">
                    spam score가 이상이면 escalate
                  </label>
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className="mono text-slate-500">spamScoreGte ≥</span>
                    <input
                      type="number"
                      name="gate.approveOutreachSend.spamScoreGte"
                      min={0}
                      max={10}
                      step={1}
                      defaultValue={os.escalateIf?.spamScoreGte ?? 5}
                      className="mono w-20 border border-slate-200 rounded px-2 py-1 text-[12px]"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] text-slate-600 mb-1">
                    팔로워가 이상이면 escalate (대형 인플루언서는 사람이 봐야)
                  </label>
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className="mono text-slate-500">followerCountGte ≥</span>
                    <input
                      type="number"
                      name="gate.approveOutreachSend.followerCountGte"
                      min={0}
                      step={10_000}
                      defaultValue={os.escalateIf?.followerCountGte ?? 500_000}
                      className="mono w-32 border border-slate-200 rounded px-2 py-1 text-[12px]"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* approveReplyResponse */}
            <div className="border border-slate-200 rounded-md p-4 mb-3">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="text-[14px] font-medium text-slate-900">approveReplyResponse</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    회신 자동 발송 전 OR 분류기가 negotiating/declined 로 escalate 한 경우
                  </div>
                </div>
              </div>
              <ModeToggle gateKey="approveReplyResponse" current={rr.mode} />
              <div className="mt-3 space-y-3">
                <div>
                  <label className="block text-[11px] text-slate-600 mb-1">
                    제안된 단가가 이상이면 escalate
                  </label>
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className="mono text-slate-500">proposedRateUsdGte ≥</span>
                    <span className="mono text-slate-500">$</span>
                    <input
                      type="number"
                      name="gate.approveReplyResponse.proposedRateUsdGte"
                      min={0}
                      step={50}
                      defaultValue={rr.escalateIf?.proposedRateUsdGte ?? 500}
                      className="mono w-24 border border-slate-200 rounded px-2 py-1 text-[12px]"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] text-slate-600 mb-1">
                    이 분류는 항상 사람 검토 (체크된 클래스만 escalate)
                  </label>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {REPLY_CLASS_OPTIONS.map((cls) => {
                      const checked = (rr.escalateIf?.replyClassIn ?? ["negotiating", "declined", "unsubscribe"]).includes(cls);
                      return (
                        <label
                          key={cls}
                          className="inline-flex items-center gap-1 border border-slate-200 rounded px-2 py-1 text-[11px] cursor-pointer hover:border-slate-300"
                        >
                          <input
                            type="checkbox"
                            name="gate.approveReplyResponse.replyClassIn"
                            value={cls}
                            defaultChecked={checked}
                            className="cursor-pointer"
                          />
                          <span className="mono">{cls}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {/* approveShipment (Phase 3 C6 producer) */}
            <div className="border border-slate-200 rounded-md p-4 mb-3">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="text-[14px] font-medium text-slate-900">approveShipment</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    창고에서 패키지 픽업 직전 — logistics 에이전트 실행 + carrier 핸드오프 전에 사람이 주소 + 품목 확인
                  </div>
                </div>
              </div>
              <ModeToggle gateKey="approveShipment" current={sh.mode} />
              <div className="mt-3">
                <label className="block text-[11px] text-slate-600 mb-1">
                  팔로워가 이상이면 escalate (대형 인플루언서 / 비싼 샘플은 사람이 확인)
                </label>
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="mono text-slate-500">followerCountGte ≥</span>
                  <input
                    type="number"
                    name="gate.approveShipment.followerCountGte"
                    min={0}
                    step={10_000}
                    defaultValue={sh.escalateIf?.followerCountGte ?? 100_000}
                    className="mono w-32 border border-slate-200 rounded px-2 py-1 text-[12px]"
                  />
                </div>
              </div>
            </div>

            {/* Phase-4 gate still disabled */}
            <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-slate-500">
              <div className="border border-dashed border-slate-200 rounded px-3 py-2 flex justify-between items-center">
                <span className="mono text-slate-400">approveStageAdvance</span>
                <Badge variant="slate" className="!text-[10px]">Phase 4</Badge>
              </div>
            </div>
          </CardBody>
        </Card>

        {/* ── Budgets ────────────────────────────────────────────────── */}
        <Card>
          <CardBody>
            <SectionLabel className="mb-3">예산 (hard / soft)</SectionLabel>
            <div className="grid grid-cols-2 gap-4">
              <label className="block">
                <span className="block text-[13px] text-slate-900">캠페인당 최대 USD</span>
                <span className="block text-[11px] text-slate-500 mt-0.5">hard cap · 초과 시 BudgetExceededError</span>
                <div className="mt-1 flex items-center gap-2">
                  <span className="mono text-slate-500">$</span>
                  <input
                    type="number"
                    name="budgets.maxUsdPerCampaign"
                    min={1}
                    step={1}
                    defaultValue={policy.budgets.maxUsdPerCampaign}
                    className="mono w-32 border border-slate-200 rounded px-2 py-1 text-[13px]"
                  />
                </div>
              </label>
              <label className="block">
                <span className="block text-[13px] text-slate-900">월별 워크스페이스 최대 USD</span>
                <span className="block text-[11px] text-slate-500 mt-0.5">soft cap · 알림 (COST_ALERT_THRESHOLDS)</span>
                <div className="mt-1 flex items-center gap-2">
                  <span className="mono text-slate-500">$</span>
                  <input
                    type="number"
                    name="budgets.maxUsdPerWorkspaceMonthly"
                    min={1}
                    step={1}
                    defaultValue={policy.budgets.maxUsdPerWorkspaceMonthly}
                    className="mono w-32 border border-slate-200 rounded px-2 py-1 text-[13px]"
                  />
                </div>
              </label>
            </div>
          </CardBody>
        </Card>

        {/* ── Brand voice ────────────────────────────────────────────── */}
        <Card>
          <CardBody>
            <SectionLabel className="mb-3">브랜드 보이스 <span className="text-slate-400 font-normal normal-case tracking-normal">(outreach-writer 에이전트에 주입 — Phase 2)</span></SectionLabel>
            <label className="block mb-3">
              <span className="block text-[13px] text-slate-900 mb-1">톤 노트</span>
              <textarea
                name="voice.toneNotes"
                rows={2}
                defaultValue={policy.voice.toneNotes}
                placeholder="예: 정중하되 간결. 한국어 존댓말. 자랑 톤 금지. 첫 줄 ≤ 14자."
                className="w-full border border-slate-200 rounded p-2 text-[13px]"
              />
            </label>
            <label className="block">
              <span className="block text-[13px] text-slate-900 mb-1">금지 표현 (쉼표 구분)</span>
              <input
                name="voice.bannedPhrases"
                type="text"
                defaultValue={policy.voice.bannedPhrases.join(", ")}
                placeholder="예: 대박, 갓성비, 인플루언서님"
                className="w-full border border-slate-200 rounded p-2 text-[13px]"
              />
            </label>
          </CardBody>
        </Card>

        <div className="flex justify-end gap-2">
          <Button type="reset">되돌리기</Button>
          <Button type="submit" variant="primary">정책 저장</Button>
        </div>
      </form>
    </div>
  );
}
