# scripts/ops — D46 state-driven auto-scale operations

> **Decision anchor**: **D46** (DECISIONS.md:140) — "Essential-asset retention +
> state-driven auto-scale budget design". The static옵션 A/B/C tier framing is
> retired. **Traffic decides cost.** Only the assets a judge actually touches
> stay reachable; everything heavier is created on demand and destroyed right
> after. See also `gcp-research/goal-mode/UNIFIED-TRACK3-PLAN.md` §3 and
> D39 ($1,500 credit cap), D31 (SLO), D32 (alerting/IR).

## The three essential assets (and nothing else)

| Service | Project | Region | Scale policy | Warm-up path |
|---|---|---|---|---|
| `ss-landing` | `ss-shared-infra` | us-central1 | Cloud Run min=0 / max=10 | `/` |
| `ss-v2-web` (Mission Control) | `ss-v2-prod` | us-central1 | Cloud Run min=0 / max=10 | `/api/healthz` |
| `ss-mcp-server` (Track 3 A2A) | `ss-mcp-prod` | us-central1 | Cloud Run min=0 / max=10 | `/` |

The inventory lives in **`_services.sh`** (single source of truth, sourced by
the other scripts).

> ⚠️ **Hard safety rail** (CLAUDE.md): the production `social-seeding-backend`
> (port **8080**, project `social-seeding`) is **not** in this inventory and
> must **never** be added. Every script here only ever touches the three
> SS-v2 challenge services above. Only the operator starts/stops 8080.

Idle cost of the three at min=0 is ~$0 (Cloud Run bills per request + per
instance-second; with no instance pinned and no traffic, the bill is the
near-zero base). Expected cumulative through judging ≈ **$1–5/mo** — under ~3%
of the D39 $1,500 cap.

## Scripts

### `scale-down.sh` — force min=0

The manual lever (and the target of the `cost_watch` `scale_down` runbook) that
asserts `--min-instances=0` across the fleet.

```bash
./scale-down.sh                       # all three services
./scale-down.sh --dry-run             # show what would change, change nothing
./scale-down.sh ss-v2-web             # one service by name
./scale-down.sh ss-landing:ss-shared-infra   # explicit service:project
```

Idempotent — services already at min=0 are reported and skipped. Never touches
max-instances, never deletes a service.

### `warm-up.sh` — judging-window keep-alive cron

Creates three Cloud Scheduler jobs (`ss-warmup-<svc>`) in `ss-shared-infra`,
each an hourly `GET` to the service's warm-up path. An hourly ping defeats
Cloud Run cold-start during judging without paying for a pinned `min=1`
instance for ~6 weeks. **Created PAUSED by default** so building the cron today
costs nothing and fires no premature pings.

```bash
./warm-up.sh create            # create the 3 jobs, PAUSED (safe to run now)
./warm-up.sh status            # list the jobs + their PAUSED/ENABLED state
./warm-up.sh resume            # ENABLE (do this at the start of judging)
./warm-up.sh pause             # PAUSE  (idle cost back to ~$0)
./warm-up.sh delete            # remove the jobs (after judging)
./warm-up.sh create --dry-run  # print gcloud calls, change nothing
```

**Window**: `2026-06-05 → 2026-06-20` (from `_services.sh`). The schedule is
defined now; the jobs are dormant until you `resume`. Cloud Scheduler's free
tier covers 3 jobs at no cost.

### `teardown-heavy.sh` — destroy expensive stores after a demo

Targeted `terraform destroy` of the always-on-expensive resources (Spanner,
AlloyDB, KMS) so they contribute $0 to the idle bill. **Dry-run by default**;
a real destroy needs `--apply` plus a typed env-name confirmation, because
Spanner/AlloyDB drops are irreversible.

```bash
./teardown-heavy.sh                    # dry-run plan-destroy on dev (default)
./teardown-heavy.sh --env prod         # dry-run plan-destroy on prod
./teardown-heavy.sh --env dev --apply  # REAL destroy (prompts to confirm)
./teardown-heavy.sh --kms-only         # narrow to just the KMS key ring
```

Targets (resolved from `terraform/modules/{data,security}`):
`module.data.google_spanner_instance.core`,
`module.data.google_alloydb_cluster.{primary,secondary}`,
`module.security.google_kms_key_ring.regional`.

Today these resources **do not exist** (state-driven: created on demand for a
demo). In that case the plan-destroy is a no-op that exits 0 — the script is
safe to keep wired ahead of any `terraform apply`.

## The `cost_watch` auto-guard (code, not a shell script)

The autonomous side of D46 lives in
`packages/agents-adk/src/ss_agents/agents/cost_watch.py`:

```
billing_query  →  evaluate_cost_watch (50/75/90/95 ladder)  →  pubsub_alert (per crossing)
                                                              →  (≥90%) runbook_execute("scale_down")
```

`cost_guard()` ties the three capabilities together for one tick;
`cost_guard_from_billing()` owns the `billing_query` read and measures spend
against the D39 $1,500 cap (or an explicit per-tenant budget). At the 90%
banner crossing it auto-invokes the `scale_down` runbook — the live runbook
wraps `scale-down.sh`. Defaults to `dry_run=True`; a live flip requires
`CAPABILITY_LAYER_MODE=live` **and** an explicit `dry_run=False` opt-in
(enforced by `runbook_execute`'s mutating-kind guardrail). Unit tests:
`packages/agents-adk/tests/agents/test_cost_watch.py::TestCostGuard`.

## Runbook — when to pull which lever

| Situation | Action |
|---|---|
| Normal operation, no demo | All min=0 (the default). Nothing to do. |
| Just deployed / changed a service | `./scale-down.sh` to confirm min=0. |
| **Judging window starts (2026-06-05)** | `./warm-up.sh resume` — hourly keep-alive on; cold-start latency gone. |
| **Judging window ends (2026-06-20)** | `./warm-up.sh pause` (or `delete`) — idle cost back to ~$0. |
| Recording a demo that needs Spanner/AlloyDB | `terraform apply` the heavy targets, record, then `./teardown-heavy.sh --apply` immediately after. |
| Spend approaching the cap | `cost_watch` auto-fires `scale_down` at 90%; or run `./scale-down.sh` manually. |
| Cost spiked unexpectedly | `./scale-down.sh` (instant min=0), then `./teardown-heavy.sh --env <env>` (dry-run first) to check for stray heavy stores. |

## Verification commands

```bash
# Confirm all three are at min=0:
./scale-down.sh --dry-run

# Confirm warm-up cron exists and is dormant:
./warm-up.sh status

# Confirm teardown is a safe no-op today:
./teardown-heavy.sh --env dev   # dry-run

# Confirm the cost guard wiring is green:
(cd ../../packages/agents-adk && .venv/bin/python -m pytest \
  tests/agents/test_cost_watch.py::TestCostGuard -q)
```
