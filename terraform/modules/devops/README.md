# `modules/devops` — Cloud Build / Cloud Deploy / Artifact Registry / Workstations / Binary Authorization / WIF

Terraform module that provisions the **build → attest → deploy** spine for
`social-seeding-v2`, plus the dev environments engineers and Tier-3 worker
agents (per **D38**) use day-to-day.

Decision anchors (`gcp-research/decisions/DECISIONS.md`):

| D-ID | Decision | What this module does |
|---|---|---|
| **D13** | Global multi-region active-active (US + EU + APAC) | 1 Artifact Registry repo per (region, format) + 1 Cloud Deploy target per region |
| **D17** | Vertex AI Agent Runtime is the managed agent target | Cloud Deploy targets are Cloud Run today; phase-2 swaps to a custom target type when Agent Runtime gets a Cloud Deploy adapter |
| **D32** | Cloud Monitoring + PagerDuty + Slack + Chronicle | Optional Pub/Sub subscriptions on `cloud-builds` and `clouddeploy-operations` topics; downstream fan-out lives in the integration module |
| **D37** | 5-layer test pyramid + per-PR (8-stage, 12-min) + nightly | Inline 8-stage Cloud Build trigger on PR; webhook-driven Cloud Build trigger on Scheduler cron for nightly; Binary Authorization gate requires SLSA L3 attestation before deploy |
| **D38** | M3 PM + leads + workers hierarchy | Two Workstations configs: `ss-v2-engineer` (humans) and `ss-v2-agent-worker` (Tier-3 worker bots) |
| **D39** | $1500 GCP credits | Defaults sized to fit MATRIX §7 budget (~$140/night nightly · ~$10/day PR-eval) with ~30% headroom |

Service inventory mapping (`gcp-research/decisions/SERVICE-INVENTORY.md` §8):
covers every "✅" row except Cloud Scheduler (provisioned here only for the
nightly trigger — the broader scheduler fleet lives in the integration
module), Cloud Tasks, Eventarc Advanced, Apigee X, and Apigee API Hub. Those
belong to integration / network-security modules respectively.

## What it creates

```
project/
├── APIs enabled (12)        — cloudbuild, clouddeploy, artifactregistry,
│                             containeranalysis, binaryauthorization,
│                             workstations, iam, iamcredentials, sts,
│                             cloudkms, cloudaicompanion, pubsub
├── service accounts (3)     — cloud_build, cloud_deploy, workstations
│
├── Artifact Registry        — len(regions) × len(formats) repos
│   └── default 3×3 = 9      — DOCKER + PYTHON + NPM in US + EU + APAC
│
├── Cloud Build
│   ├── private pool         — VPC-attached, /29 peered range
│   ├── per-PR trigger       — inline 8-stage (MATRIX §7.1)
│   ├── nightly trigger      — git_file_source cloudbuild.nightly.yaml
│   ├── Scheduler cron       — fires nightly webhook at 02:00 UTC
│   └── Secret Manager       — nightly webhook secret
│
├── Cloud Deploy
│   ├── delivery pipeline    — serial per-region canary 10→50→100
│   ├── regional targets     — one Cloud Run target per region in var.regions
│   └── freeze policy        — optional, gated on var.deploy_freeze_windows
│
├── Cloud Workstations
│   ├── cluster              — private, VPC-attached, in primary_region
│   ├── config: engineer     — e2-standard-8, 1h idle / 10h running
│   └── config: agent-worker — e2-standard-4, 30m idle, warm pool of 2
│
├── Binary Authorization
│   ├── KMS keyring + key    — EC_SIGN_P256_SHA256, prevent_destroy
│   ├── attestor             — references the KMS key + Container Analysis note
│   └── policy               — REQUIRE_ATTESTATION default + whitelist for
│                             Google-managed system images
│
└── Workload Identity Federation (optional, default ON)
    ├── pool                 — ss-v2-github-pool
    └── provider             — github-actions, locked to owner/repo
```

## Usage

```hcl
module "devops" {
  source = "../modules/devops"

  project_id      = "ss-v2-prod-shared"
  primary_region  = "us-central1"
  regions         = ["us-central1", "europe-west1", "asia-northeast3"]

  github_owner      = "ComBba"
  github_repository = "social-seeding-v2"

  # Workstations live in the project VPC so integration tests reach
  # Spanner / Firestore over Private Service Connect.
  workstations_network    = module.networking.vpc_self_link
  workstations_subnetwork = module.networking.subnet_self_links["us-central1"]

  # D32 — fan failures out to PagerDuty + Slack via integration module.
  notification_pubsub_topic = module.integration.alert_router_push_url

  labels = {
    environment = "prod"
    team        = "platform"
  }
}
```

## Inputs

See [`variables.tf`](./variables.tf). Required: `project_id`, `github_owner`,
`github_repository`, `workstations_network`, `workstations_subnetwork`.

## Outputs

See [`outputs.tf`](./outputs.tf). Key exports for sibling modules:

- `cloud_build_service_account_email`, `cloud_deploy_service_account_email`,
  `workstations_service_account_email` — for IAM bindings in `data` / `ai`
  modules.
- `artifact_registry_repos` — map keyed by `<region>-<format>` → repo URL.
- `cloud_deploy_target_names` — map keyed by region → target name; compute
  module wires its Cloud Run services into these.
- `binary_authorization_attestor_id` + `binary_authorization_kms_key_id` —
  consumed by inline Cloud Build attestation steps in `cloudbuild.yaml`.
- `workload_identity_provider` — paste into GitHub Actions
  `google-github-actions/auth@v2` workflows. No JSON keys.

## Cost guardrails (D39)

| Surface | Sized to | Per-month estimate |
|---|---|---|
| Artifact Registry storage | 9 repos × ~5 GB each (cleanup keeps 50 tags) | ~$10 |
| Cloud Build per-PR | 25 PRs/day × 12 min × e2-standard-4 | ~$120 |
| Cloud Build nightly | 30 nights × 4.5 h × e2-standard-4 (plus eval cost) | ~$140 build minutes (eval $$ lives in `ai` module) |
| Cloud Deploy releases | 10 releases/month × verify + render minutes | ~$15 |
| Cloud Workstations | 5 engineers × 8 h × 20 days + 2 warm worker slots | ~$280 |
| Binary Authorization | Per-evaluation, ~10k/month | ~$5 |
| **Subtotal** | | **~$570 / month** |

Stays inside the SERVICE-INVENTORY §14 DevOps envelope. The biggest knob is
`workstations_engineer_machine_type` — switching to `e2-standard-4` cuts the
workstation line by ~50%.

## Caveats / known landmines

1. **`cloudbuild.nightly.yaml` must exist in repo `main`** for the nightly
   trigger to do anything. Module does not provision it — that belongs in
   application code so the M3 optimizer (D38) can evolve it without
   `terraform apply`.
2. **Binary Authorization policy is project-wide**. Once applied, every Cloud
   Run service in `var.project_id` requires attestation. If you share the
   project with non-attested workloads (e.g. a hand-deployed scratch service),
   add them to `admission_whitelist_patterns` or move them to a separate
   project.
3. **WIF locks to one GitHub repo**. To support multiple repos, expand
   `attribute_condition` in `wif.tf` to an `in` clause — pre-prod fork-test
   PRs from forks will still be blocked, which is the intended behavior.
4. **Cloud Deploy `regional` targets currently render Cloud Run only.** When
   Vertex AI Agent Runtime ships a Cloud Deploy custom target, swap the
   `run {}` block for the new type. The serial-pipeline shape per D17 stays
   the same.
5. **`google.golang.org/grpc v1.80.0` advisory** (CVE GO-2026-4762, surfaced
   in workspace `CLAUDE.md`) applies to downstream Go services, not this
   module — but Artifact Analysis on the resulting images will flag the CVE
   automatically. Patch path is v1.81.0.

## Examples

- [`examples/basic`](./examples/basic) — minimum-viable invocation with a
  fake VPC for plan-only validation. Run `terraform init && terraform validate`
  inside to smoke-test the module after edits.
