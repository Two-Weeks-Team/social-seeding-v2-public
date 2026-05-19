# `modules/security` — social-seeding-v2 security baseline

> **Owner**: TF-Module-4 (security)
> **Decisions**: D13, D19, D20, D21, D32, D33, D37, D38
> **Sources**: `gcp-research/decisions/DECISIONS.md`, `gcp-research/decisions/SERVICE-INVENTORY.md` §6, `gcp-research/model-armor/ARMOR-GATEWAY.md`, `gcp-research/network-security/NETSEC.md`
> **Providers**: `hashicorp/google ~> 6.20`, `hashicorp/google-beta ~> 6.20`

## What this module provisions

A single invocation creates the entire security control plane for one v2 project (e.g. `ss-v2-prod-us`). Run it once per active-active region project per **D13**, or once per environment (dev/staging/prod) when stacking on a single shared org.

| # | Resource group | Count | Decision | Notes |
|---|---|---|---|---|
| 1 | API enablement (`google_project_service`) | 15 | — | Idempotent; `disable_on_destroy = false`. |
| 2 | KMS keyrings (`google_kms_key_ring`) | **3** (US + EU + APAC) | D13, D20 | One ring per region. |
| 3 | CMEK keys (`google_kms_crypto_key`) | **18** (3 × 6) | D20 | Spanner, AlloyDB, Firestore, Storage, BigQuery, Pub/Sub — per ring. `prevent_destroy = true`. |
| 4 | Cloud HSM billing root (`google_kms_crypto_key`) | 0 or 1 | D20 | Gated by `var.enable_hsm_billing_root`. Lives in the primary (US) ring. |
| 5 | KMS Encrypter/Decrypter grants | 18 + 3 | D20 | One per CMEK key (data-plane SAs) + Secret Manager SA on each regional storage key. |
| 6 | Secret Manager seeds (`google_secret_manager_secret` + `_secret_version`) | **8** + 8 | D20 | `rapidapi`, `gmail-oauth-refresh`, `ig-token`, `chronicle`, `pagerduty`, `slack`, `idp-sdk`, `stripe`. **User-managed** replication across the three regions; each replica CMEK-protected. Placeholder values — engineers MUST overwrite via `gcloud secrets versions add`. |
| 7 | Identity Platform config + template tenant | 1 + 1 | D19 | `allow_tenants = true` (multi-tenant per D12). Template tenant exists for CI; production tenants are created at customer-signup time. |
| 8 | Identity Platform IdPs | 0-3 | D19 | Google / SAML / OIDC; each gated by the matching `identity_platform_*` variable being non-empty so we never ship a half-configured IdP. |
| 9 | Workforce Identity Federation pool + provider | 0 or 1 + 1 | D19 | Org-level (`organizations/{org_id}`). Gated by `var.workforce_oidc_issuer_uri`. Staff SSO. |
| 10 | Workload Identity Federation pool + provider | 1 + 1 | D38 | Project-level. GitHub Actions OIDC, locked to `{owner}/{repo}` via `attribute_condition`. |
| 11 | DLP inspect templates (`google_data_loss_prevention_inspect_template`) | **3** | D20, D33 | `ss-pi` (payment + credentials), `ss-pii` (KR `KOREA_RRN` + JP `JAPAN_INDIVIDUAL_NUMBER` + CN `CHINA_RESIDENT_ID_NUMBER` + US `US_SOCIAL_SECURITY_NUMBER` + generic PII + custom `INF-NNNNNNNN` regex), `ss-brand` (competitor regex set). |
| 12 | Model Armor templates (`google_model_armor_template`) | **2** | D21 | `ss-input` (MEDIUM+ thresholds, INSPECT_AND_BLOCK) and `ss-output` (HIGH thresholds). Each wired to the matching DLP template via `sdp_settings.advanced_config.inspect_template`. Provider = `google-beta`. |
| 13 | Model Armor floor setting | 1 | D21 | Project-level lock — no future template can disable PI/JB enforcement. |
| 14 | Binary Authorization attestor + Container Analysis note | 1 + 1 | D37 | Attestor name: `ss-prod-attestor`. |
| 15 | Binary Authorization policy | 1 | D37 | `REQUIRE_ATTESTATION` + `ENFORCED_BLOCK_AND_AUDIT_LOG` on the default rule. Applies to Cloud Run, Agent Runtime images, **and** any GKE cluster (`global_policy_evaluation_mode = ENABLE`). Whitelists Google distroless + GKE system images. |
| 16 | SCC custom source (`google_scc_source`) | 0 or 1 | D21, D32 | `ss-security-watch`. Org-level. Premium activation happens out-of-band. |
| 17 | Chronicle audit export | 1 BQ dataset + 1 log sink + 1 IAM member + 1 metric | D32, D33 | BQ dataset CMEK-protected; sink covers Cloud Audit Logs + Model Armor sanitize-ops + IAM + Identity Platform; log-based metric `model_armor_blocks` powers the surge alert in `modules/observability`. |

**Total resource count**: ~70 (varies by feature gates), HCL ≈700 lines.

## Where each Decision shows up

- **D13** Multi-region active-active → `var.regions` (us/eu/ap) drives KMS keyrings and Secret Manager replication.
- **D19** Identity Platform multi-tenant + Workforce IF → `google_identity_platform_config` (with `multi_tenant.allow_tenants = true`), `google_identity_platform_tenant.template`, three optional IdP resources, `google_iam_workforce_pool.staff`.
- **D20** CMEK + Secret Manager + DLP → §2-7, §11.
- **D21** Model Armor max policy → §8 (input MEDIUM+ / output HIGH, INSPECT_AND_BLOCK, project floor). Audit-only mode (`INSPECT_ONLY`) is available via `var.model_armor_enforce = false` for the audit-only → enforce ramp called out in D21.
- **D32** Chronicle SecOps → §11 (BQ dataset + sink).
- **D33** Lifecycle (PII 30d / audit 90d / memory 14d) → `var.audit_log_retention_days` (defaults to 90).
- **D37** Binary Authorization → §9.
- **D38** Workload Identity Federation → §6.

## Inputs (highlights)

| Variable | Default | Why |
|---|---|---|
| `project_id` | — (required) | Per-region project ID per O2. |
| `project_number` | — (required) | Used to derive `service-{n}@gcp-sa-*.iam.gserviceaccount.com` principals. |
| `org_id` | — (required) | Workforce pools + SCC sources are org-scoped. |
| `regions.{us,eu,ap}` | `us-central1`, `europe-west4`, `asia-northeast3` | D13 active-active set. |
| `seed_secrets` | 8 names | Edit if a service rolls out a new credential. |
| `enable_hsm_billing_root` | `false` | Flip on after Apigee per-view billing pipeline lands. |
| `model_armor_enforce` | `true` | Set `false` to roll out templates in shadow mode first. |
| `binauthz_attestor_name` | `ss-prod-attestor` | Referenced by the Cloud Build pipeline in `modules/devops`. |
| `github_repo_owner` / `github_repo_name` | `ComBba` / `social-seeding-v2` | Locks Workload IF federation to exactly this repo. |
| `enable_scc_premium` | `true` | Premium activation itself is org-level + out-of-band. |
| `audit_log_retention_days` | `90` | Floor enforced by validation (PIPA Art. 23). |

See `variables.tf` for the full list with rationale.

## Outputs (consumed by sibling modules)

- `cmek_key_ids["us-spanner"]`, `["us-firestore"]`, `["eu-bigquery"]`, … → fed to `modules/data` for per-region store creation.
- `secret_ids["rapidapi"]` → fed to `modules/compute` and `modules/ai` env-var/secret mount.
- `workforce_pool_name` + `workload_pool_name` → fed to `modules/devops` Cloud Build trigger principals.
- `model_armor_input_template` + `model_armor_output_template` → fed to `modules/ai` Agent Gateway / Agent Runtime extension config.
- `binauthz_attestor_name` → fed to `modules/devops` Cloud Build attestation step.
- `model_armor_block_metric_name` + `chronicle_audit_dataset` → fed to `modules/observability` alert policy + Chronicle pull connector.

## Operational notes

### Secret material lives outside Terraform state

This module creates **placeholder** secret versions (`REPLACE_ME_VIA_GCLOUD`). The first action after `terraform apply` is:

```bash
echo -n "${RAPIDAPI_KEY}" | gcloud secrets versions add ss-rapidapi --data-file=-
echo -n "${SLACK_WEBHOOK}" | gcloud secrets versions add ss-slack --data-file=-
# … one per seed secret
```

`lifecycle.ignore_changes = [secret_data]` is set so subsequent applies don't overwrite the operator-supplied value.

The same pattern applies to:
- Identity Platform IdP `client_secret` fields (ignored after creation)
- Workforce Pool Provider `oidc.client_secret` (ignored after creation)

### CMEK keys cannot be destroyed by Terraform

`prevent_destroy = true` is set on all 18 CMEK keys and the HSM billing root. If you need to remove a key:

1. Migrate all data off the key (re-encrypt with a new key) — **destroy is irreversible**.
2. Remove the `prevent_destroy` block in a deliberate commit.
3. `terraform apply` to destroy the key resource.
4. After 30 days (`destroy_scheduled_duration`) the key material is purged from KMS.

### Model Armor ramp

Per D21 the ramp is audit-only → enforce. The recommended sequence:

1. `model_armor_enforce = false` for the first deploy → templates created in `INSPECT_ONLY`.
2. Operator watches the `model_armor_blocks` metric for a week + tunes the SDP templates.
3. `model_armor_enforce = true` → flips both templates to `INSPECT_AND_BLOCK`.

The project floor (`google_model_armor_floor_setting`) is always on so no engineer can ship a new template without PI/JB enforcement.

### Binary Authorization first-time bootstrap

A fresh project will fail Cloud Run / GKE deploys until the first attestation is signed. The bootstrap order is:

1. `terraform apply` this module (creates attestor + policy).
2. Cloud Build pipeline (in `modules/devops`) builds + scans the first image and produces an attestation.
3. Cloud Run / Agent Runtime / GKE accepts that image.

For emergency rollback the whitelist in `var.binauthz_whitelist_patterns` is your only escape hatch — keep it tight.

### Workforce IF — disabled by default

`google_iam_workforce_pool.staff` is gated by `var.workforce_oidc_issuer_uri` being non-empty. Until the org picks an IdP (Google Workspace vs Okta vs Azure AD), the pool is **not created** to avoid a half-configured staff SSO. Once decided, set the variable + `terraform apply` — the pool is org-scoped and outlives any single project.

## Smoke test

After `terraform apply`:

```bash
# 1. KMS keyrings + keys
gcloud kms keyrings list --location=us-central1 --project=$PROJECT_ID | grep ss-us-keyring
gcloud kms keys list --keyring=ss-us-keyring --location=us-central1 --project=$PROJECT_ID
# expected: 6 keys (ss-spanner-cmek, ss-alloydb-cmek, …, ss-pubsub-cmek)

# 2. Secret Manager (placeholders are present but empty until gcloud-add)
gcloud secrets list --project=$PROJECT_ID --filter="name~ss-"
# expected: 8 secrets, each with one version containing the sentinel.

# 3. Identity Platform tenant
gcloud identity tenants list --project=$PROJECT_ID

# 4. Model Armor templates + floor
gcloud beta model-armor templates describe ss-input --project=$PROJECT_ID --location=us-central1
gcloud beta model-armor templates describe ss-output --project=$PROJECT_ID --location=us-central1
gcloud beta model-armor floor-settings describe --project=$PROJECT_ID

# 5. Binary Authorization
gcloud container binauthz attestors describe ss-prod-attestor --project=$PROJECT_ID
gcloud container binauthz policy export --project=$PROJECT_ID

# 6. Workload Identity Pool (GitHub Actions)
gcloud iam workload-identity-pools describe ss-github-actions --location=global --project=$PROJECT_ID

# 7. Chronicle export dataset
bq ls --project_id=$PROJECT_ID | grep v2_chronicle_audit_export
```

## See also

- `gcp-research/model-armor/ARMOR-GATEWAY.md` §1.7 (worked example) and §6 (Terraform reference template this module is derived from).
- `gcp-research/network-security/NETSEC.md` §1.5 (VPC-SC perimeter — owned by `modules/networking`, but Secret Manager / KMS / DLP / Vertex AI must be inside the perimeter).
- `modules/observability` for the actual alert policy on `model_armor_blocks` and the surge runbook.
- `modules/devops` for the Cloud Build pipeline that signs attestations against `ss-prod-attestor`.
- `examples/basic` for a minimum-viable invocation against a single dev project.
