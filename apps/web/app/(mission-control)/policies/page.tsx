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
 *   · approveStageAdvance — still disabled (곧).
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

/** Reply-classification → operator Korean. Form value stays the enum string. */
const REPLY_CLASS_KO: Record<(typeof REPLY_CLASS_OPTIONS)[number], string> = {
  interested: "관심 있음",
  needs_info: "정보 요청",
  negotiating: "협상 중",
  not_now: "지금은 아님",
  declined: "거절",
  out_of_office: "부재중 자동응답",
  unsubscribe: "수신 거부",
  unrelated: "무관한 회신",
};

/** Autonomy level → operator Korean (the form `level` value stays the enum). */
const LEVEL_KO: Record<WorkspacePolicy["level"], string> = {
  copilot: "코파일럿",
  checkpointed: "체크포인트",
  autonomous: "자율 운영",
};

/** Gate-mode → operator Korean (the radio value stays the enum). */
const MODE_KO: Record<GateConfig["mode"], string> = {
  always_ask: "항상 확인",
  auto: "자동 진행",
  auto_unless: "조건부 자동",
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
  copilot: "에이전트가 제안만, 모든 액션은 사람이 확인",
  checkpointed: "에이전트가 실행하되 각 단계에 승인 게이트 (기본)",
  autonomous: "예외 시에만 사람에게 넘김 · 신뢰가 쌓인 후",
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
 * Tri-state mode toggle for a gate (항상 확인 / 자동 진행 / 조건부 자동).
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

/** One labelled threshold row: human Korean label + comparator + number field. */
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
        <h1 className="text-[24px] font-bold tracking-[-0.01em] text-ink">자율성 정책</h1>
        <p className="mt-1 text-[13.5px] text-ink-2 leading-relaxed">
          에이전트에게 어디까지 맡길지 정합니다. 변경 사항은 새 캠페인부터 적용됩니다 (진행 중 캠페인은 영향 없음).
        </p>
      </header>

      {/* 활성 버전 전환 — writes the rollout flag on the shared workspace doc.
          Sibling card (not nested in the save form). */}
      <Card className="mb-5">
        <CardBody>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <SectionLabel>활성 버전 전환</SectionLabel>
                <StatusTag tone={v2Enabled ? "ok" : "neutral"} size="sm">
                  {v2Enabled ? "새 버전 사용 중" : "이전 버전 사용 중"}
                </StatusTag>
              </div>
              <div className="mt-1.5 text-[12.5px] text-ink-2 leading-relaxed">
                이 워크스페이스 사용자를 새 운영 화면으로 안내할지 결정합니다.
              </div>
            </div>
            {canRollout ? (
              <form action={toggleV2RolloutAction}>
                <input type="hidden" name="enable" value={v2Enabled ? "false" : "true"} />
                <Button variant="secondary" tone={v2Enabled ? "warn" : "approve"}>
                  {v2Enabled ? "← 이전 버전으로" : "→ 새 버전으로 전환"}
                </Button>
              </form>
            ) : (
              <span className="text-[11px] text-ink-3 whitespace-nowrap">관리자만 변경 가능</span>
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
              <SectionLabel className="mb-1">원클릭 프리셋</SectionLabel>
              <div className="text-[12.5px] text-ink-2 leading-relaxed">
                레벨을 누르면 5개 게이트가 일괄로 그 레벨에 맞게 세팅됩니다. 개별 게이트는 아래에서 다시 조정할 수 있습니다.
              </div>
            </div>
            <span className="text-[11px] text-ink-3 whitespace-nowrap">
              현재 <span className="font-semibold text-ink-2">{LEVEL_KO[policy.level]}</span>
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
                  {LEVEL_KO[lvl]} 적용
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
            <CardTitle>자율 수준</CardTitle>
            <span className="text-[11px] text-ink-3">저장 시 적용</span>
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
                        <span className="text-[10px] uppercase tracking-[0.06em] text-brand-ink font-semibold">기본</span>
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
            <CardTitle>게이트별 동작</CardTitle>
            <CardSubtitle>각 단계에서 사람 확인을 어떻게 받을지</CardSubtitle>
          </CardHeader>
          <CardBody className="space-y-3">
            {/* approveShortlist */}
            <Card flat className="bg-surface-2/40">
              <CardBody>
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <div className="text-[14px] font-bold text-ink">{gateKo("approveShortlist")}</div>
                    <div className="text-[12px] text-ink-3 mt-0.5">소싱·검증이 끝나고 후보 리스트를 확정하기 전</div>
                  </div>
                  <ModeToggle gateKey="approveShortlist" current={sl.mode} />
                </div>
                <Threshold
                  label="적합도가 낮으면 사람에게 확인"
                  hint="조건부 자동일 때, 적합도 점수가 아래 값보다 낮으면 사람에게 묻습니다."
                  comparator="아래 미만이면 확인 <"
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
                    <div className="text-[12px] text-ink-3 mt-0.5">크리에이터에게 첫 아웃리치 메일을 보내기 직전</div>
                  </div>
                  <ModeToggle gateKey="approveOutreachSend" current={os.mode} />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <Threshold
                    label="스팸 위험이 높으면 확인"
                    hint="메일 스팸 점수가 이 값 이상이면 사람에게 넘깁니다."
                    comparator="이상이면 확인 ≥"
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
                    label="대형 인플루언서는 확인"
                    hint="팔로워 수가 이 값 이상이면 사람이 직접 검토합니다."
                    comparator="명 이상이면 확인 ≥"
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
                      회신을 자동으로 보내기 전 · 협상·거절로 분류된 회신은 사람에게 넘김
                    </div>
                  </div>
                  <ModeToggle gateKey="approveReplyResponse" current={rr.mode} />
                </div>
                <div className="space-y-4">
                  <Threshold
                    label="제안 단가가 높으면 확인"
                    hint="크리에이터가 제안한 단가가 이 금액 이상이면 사람이 확인합니다."
                    prefix="$"
                    comparator="이상이면 확인 ≥"
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
                    <div className="text-[12px] text-ink-2 font-medium">항상 사람이 검토할 회신 종류</div>
                    <div className="text-[11px] text-ink-3 mt-0.5 leading-relaxed">선택한 종류로 분류된 회신은 자동 응답하지 않고 사람에게 넘깁니다.</div>
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
                      창고 픽업 직전 — 배송 처리 전에 사람이 주소·품목을 확인
                    </div>
                  </div>
                  <ModeToggle gateKey="approveShipment" current={sh.mode} />
                </div>
                <Threshold
                  label="대형 인플루언서·고가 샘플은 확인"
                  hint="팔로워 수가 이 값 이상이면 사람이 발송 전에 확인합니다."
                  comparator="명 이상이면 확인 ≥"
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

            {/* Disabled gate — coming soon (곧) */}
            <div className="border border-dashed border-line rounded-2xl px-4 py-3 flex justify-between items-center">
              <span className="text-[13px] text-ink-3">{gateKo("approveStageAdvance")}</span>
              <span className="text-[11px] text-ink-3 bg-surface-2 rounded-full px-2.5 py-0.5 font-medium">곧</span>
            </div>
          </CardBody>
        </Card>

        {/* ── Budgets ────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>예산</CardTitle>
            <CardSubtitle>한도와 알림</CardSubtitle>
          </CardHeader>
          <CardBody>
            <div className="grid grid-cols-2 gap-4">
              <label className="block">
                <span className="block text-[13px] font-medium text-ink">캠페인당 최대 비용</span>
                <span className="block text-[11px] text-ink-3 mt-0.5">한도 초과 시 차단</span>
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
                <span className="block text-[13px] font-medium text-ink">월별 워크스페이스 최대 비용</span>
                <span className="block text-[11px] text-ink-3 mt-0.5">알림 임계 (초과 시 안내)</span>
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
            <CardTitle>브랜드 보이스</CardTitle>
            <CardSubtitle>아웃리치 작성에 반영됩니다 · 곧</CardSubtitle>
          </CardHeader>
          <CardBody>
            <label className="block mb-3">
              <span className="block text-[13px] font-medium text-ink mb-1.5">톤 노트</span>
              <textarea
                name="voice.toneNotes"
                rows={2}
                defaultValue={policy.voice.toneNotes}
                placeholder="예: 정중하되 간결. 한국어 존댓말. 자랑 톤 금지. 첫 줄 ≤ 14자."
                className="w-full bg-surface border border-line rounded-xl p-2.5 text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-brand-ink/40"
              />
            </label>
            <label className="block">
              <span className="block text-[13px] font-medium text-ink mb-1.5">금지 표현 <span className="text-ink-3 font-normal">(쉼표로 구분)</span></span>
              <input
                name="voice.bannedPhrases"
                type="text"
                defaultValue={policy.voice.bannedPhrases.join(", ")}
                placeholder="예: 대박, 갓성비, 인플루언서님"
                className="w-full bg-surface border border-line rounded-xl p-2.5 text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-brand-ink/40"
              />
            </label>
          </CardBody>
        </Card>

        <div className="flex justify-end gap-2">
          <Button type="reset" variant="ghost">되돌리기</Button>
          <Button type="submit" variant="primary">정책 저장</Button>
        </div>
      </form>
    </div>
  );
}
