# SMOKE-TEST P6 — Phase 6 partial closure (post review-fix pass)

> Logged 2026-05-14 after the codex review fix pass on Phase 6
> (commits `aa97c90`..`c1b84d8`). Goal: confirm the v1→v2 workspace
> importer runs end-to-end (dry-run + live + idempotent + include-
> canceled) and that the v2-rollout flag round-trips correctly. P6-C4
> (retire v1 backend) is intentionally deferred — it's irreversible
> infrastructure work requiring explicit go-ahead.

## What ran

```bash
# 0. dev-mongo on 127.0.0.1:27027
set -a; source .mongo-dev/dev-env; set +a
export MONGODB_DB=ss_smoke_p6

# 1. Seed 5 v1-shaped `workspaces` rows in mongosh:
#    · ws-0: active, BUSINESS plan
#    · ws-1: active, FREE plan
#    · ws-2: active, FREE plan
#    · ws-3: canceledAt = 2024-06-01
#    · ws-4: cleanupMutationAt = 2024-08-01 (point-of-no-return)

# 2. Dry-run the importer
MONGODB_URI=... MONGODB_DB=ss_smoke_p6 pnpm exec tsx scripts/import-v1-workspaces.ts --dry-run
#   v1 → v2 workspace importer — db="ss_smoke_p6" [DRY-RUN]
#   Scanned          3      ← ws-3 + ws-4 filtered out at Mongo query
#   Created          3 (would)
#   Already imported 0
#   Skipped canceled 0
#   Failures         0
#   (would create: ws-0, ws-1, ws-2)

# 3. Confirm dry-run wrote nothing
mongosh ss_smoke_p6 --eval 'db.v2_workspace_policies.countDocuments()'
#   0

# 4. Live run
MONGODB_URI=... MONGODB_DB=ss_smoke_p6 pnpm exec tsx scripts/import-v1-workspaces.ts
#   Scanned 3, Created 3, ...

# 5. Confirm 3 v2_workspace_policies rows; each carries the default
#    policy (level='checkpointed', all 5 gates 'always_ask').

# 6. Re-run for idempotency
MONGODB_URI=... pnpm exec tsx scripts/import-v1-workspaces.ts
#   Scanned 3, Created 0, Already imported 3, Failures 0

# 7. --include-canceled run
MONGODB_URI=... pnpm exec tsx scripts/import-v1-workspaces.ts --include-canceled
#   Scanned 4, Created 1 (ws-3), Already imported 3,
#   Skipped canceled 0, Failures 0
#   ← ws-4 (cleanupMutationAt) STILL filtered out at the Mongo query.
```

## What passed

- **Importer dry-run** correctly skipped 2 of 5 seeded workspaces
  (canceledAt + cleanupMutationAt) at the Mongo filter level, listed
  the 3 actionable ones in the preview, wrote nothing.
- **Live run** created 3 `v2_workspace_policies` rows. Sample row:
    ```
    workspaceId: <ws-0 id>
    level: 'checkpointed'
    gates: { approveShortlist/OutreachSend/ReplyResponse/Shipment/
             StageAdvance: { mode: 'always_ask' } }  ← every gate asks
    budgets: { maxUsdPerCampaign: 25, maxUsdPerWorkspaceMonthly: 200 }
    voice: { toneNotes: '', signatureBlock: '', bannedPhrases: [] }
    ```
- **Idempotency**: re-running on the same DB scanned 3 again,
  created 0, all 3 fell into `alreadyImported`. No duplicate rows.
- **`--include-canceled`** added 1 new scan (ws-3, the canceledAt
  one), correctly imported it; the cleanupMutationAt workspace (ws-4)
  stayed out at the Mongo filter level — that's the
  point-of-no-return guarantee.
- **Concurrency safety (codex P2#3)**: `createPolicyIfMissing` uses
  `$setOnInsert`, so a policy created by an operator (via MC's
  `/policies`) OR another importer run between the snapshot-read and
  the write is preserved verbatim. The unit test in
  `imports.v1-workspaces.test.ts` pins this with a custom
  `autonomous`-level policy that survives a parallel default import.
- **v2-rollout flag** unit-tested (`imports.v2-rollout.test.ts`,
  14 tests): isV2Enabled defaults to false / setV2Enabled flips +
  writes the right timestamp / write is additive (other v1 fields
  untouched) / missing+malformed ids return false / owner+admin role
  check works.

## What this didn't prove

- **v1 frontend reading the flag**: the v2-side write + read is
  verified. The v1-side code that actually consumes `v2Enabled` to
  redirect users → v2 is a v1-repo change (carried in
  `~/social-seeding/FREEZE.md` as a P6 prereq). Not in v2's scope.
- **A real Atlas migration**: smoke ran against dev-mongo with
  hand-seeded rows. The actual cutover would run against the shared
  production Atlas cluster — read-only on `workspaces` and additive
  on `v2_workspace_policies`, but operationally the run order matters
  (init-indexes first, then importer dry-run, then live, then per-
  workspace `setV2Enabled(true)` from MC).
- **Per-workspace owner-gate from the UI**: the unit tests cover
  every isOwnerOrAdmin branch; the policies-page server action gates
  on it; visual confirmation that the UI hides the button for
  non-owners is curl-friendly but a real check would need an
  authenticated browser session as a non-owner.

## P6-C4 deferred (retire v1 backend)

Retirement of v1's Go/LangGraph backend is irreversible infra work —
not done autonomously. Open decisions for the operator:
- which v1 workspaces opt INTO v2 first (per `v2Enabled` rollout)
- how long the side-by-side window is (1 week / 1 month / longer)
- which v1 admin views are genuinely needed in v2 vs droppable

## Outcome

P6-C1 (importer) and P6-C2 (rollout flag) close cleanly. 314 tests
pass (96 workflows · 157 capabilities · 64 agents · 4 observability
— added 22 over P6). The v1 → v2 migration **tool** is ready;
running the actual migration is an operator decision.
