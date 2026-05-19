# `modules/data` — social-seeding-v2 data plane

Provisions the hybrid OLTP + analytics + memory + vector + cache layer for
`social-seeding-v2`, sized for the global active-active topology decided in
`gcp-research/decisions/DECISIONS.md`.

## Decisions implemented

| D-ID | Decision | How this module realises it |
|------|----------|------------------------------|
| **D13** | Global active-active (US + EU + APAC) | One AlloyDB cluster, one Firestore DB, one Vector index endpoint, one BigQuery dataset, one Memorystore Valkey, one GCS bucket pair per region in `var.regions`. |
| **D15** | Hybrid OLTP: Spanner + AlloyDB AI + Firestore Native | `google_spanner_instance` (multi-region, default `nam-eur-asia1`) with two databases + `google_alloydb_cluster` (PRIMARY in `local.primary_region`, SECONDARY everywhere else) + `google_firestore_database` per region. |
| **D16** | Vertex AI Vector Search dedicated endpoint | `google_vertex_ai_index` (STREAM_UPDATE, tree-AH) + `google_vertex_ai_index_endpoint` per region. ScaNN inside AlloyDB is provisioned by SQL DDL out-of-band (kept out of HCL so platform team can roll indexes forward without re-planning). |
| **D20** | CMEK across all stores, secrets in Secret Manager | Every store binds to `var.cmek_keys[<region>]`; AlloyDB bootstrap password is read from a Secret Manager secret name (the actual material never reaches state). |
| **D28** | $0.01/view billing | `google_bigquery_dataset.billing` per region + `google_dataform_repository.billing` for transformations. |
| **D33** | PII 30d / audit 90d / memory 14d | GCS lifecycle rules on `assets/` and `pii/` prefixes; `retention_policy` on audit archive; BigQuery `default_partition_expiration_ms = 90d`; Firestore TTL field (`memory_bank_ttl_days` output) consumed by the runtime. |
| **D36** | AsyncAPI 3.0 → Pub/Sub Schema Registry | `google_pubsub_schema` for each channel defined in `gcp-research/specs/_common/shared.asyncapi.yaml`. 7 channels seeded by default. |

## Resource shape

For `regions = { us-central1 = … , europe-west4 = … , asia-northeast3 = … }`:

| Kind | Count | Notes |
|------|-------|-------|
| `google_spanner_instance` | 1 | Multi-region `nam-eur-asia1`, Enterprise Plus. |
| `google_spanner_database` | 2 | `core` + `audit`. |
| `google_alloydb_cluster` | 3 | 1 PRIMARY + 2 SECONDARY (cross-region replication). |
| `google_alloydb_instance` | 4 | PRIMARY + READ_POOL (primary region) + 2× SECONDARY. |
| `google_firestore_database` | 3 | ENTERPRISE edition, PITR enabled. |
| `google_vertex_ai_index` | 3 | STREAM_UPDATE, tree-AH, 768 dims by default. |
| `google_vertex_ai_index_endpoint` | 3 | Dedicated endpoint, PSC-wired. |
| `google_storage_bucket` | 9 | 3× vector-seed + 3× assets + 3× audit-archive. |
| `google_bigquery_dataset` | 6 | analytics + billing per region. |
| `google_memorystore_instance` (Valkey 8) | 3 | CLUSTER mode, IAM_AUTH, CMEK. |
| `google_dataform_repository` | 1 | In primary region. |
| `google_pubsub_schema` | 7 | AsyncAPI 3.0 seeds. |

Total ≈ **52 resources** at `len(regions) == 3`.

## Providers

Requires both `hashicorp/google` and `hashicorp/google-beta` (≥ 6.20.0). The
following resources explicitly use `google-beta` because they touch
beta-only fields as of the 2026-05 provider release:

- `google_alloydb_cluster`, `google_alloydb_instance` — ScaNN auto-index hooks,
  `automated_backup_policy.encryption_config`.
- `google_vertex_ai_index`, `google_vertex_ai_index_endpoint` — encryption
  spec on the index, PSC config nuance.
- `google_memorystore_instance` — Valkey 8 GA, but the IAM_AUTH +
  `desired_auto_created_endpoints` shape is currently flagged Beta.

## Inputs (highlights)

| Variable | Purpose |
|----------|---------|
| `project_id` | The single project hosting the data plane. |
| `name_prefix` | Default `ss-v2`. Prepended to every resource. |
| `environment` | `prod` / `staging` / `dev`. Toggles `deletion_protection`. |
| `regions` | Map of region label → per-region tuning (CPU counts, vector dims, shard size). 1 to 5 entries. |
| `cmek_keys` | Map of region label → KMS CryptoKey resource ID. MUST include a `multi_region` entry for the Spanner instance. |
| `spanner_config` | `{ instance_config, processing_units, edition }`. Defaults to `nam-eur-asia1` / 1000 PU / ENTERPRISE_PLUS. |
| `vpc_networks` | Map of region → VPC self-link. Provided by the networking module. |
| `alloydb_initial_password_secret` | Secret Manager **secret ID** (not version) holding the bootstrap password. |
| `lifecycle_days` | Override D33 defaults if needed. |
| `asyncapi_schema_seeds` | Override the default 7-channel seed list. |

## Outputs (highlights)

The module exposes everything downstream modules need to wire the data plane
without re-deriving names:

- **Connection strings**: `spanner_core_database`, `spanner_audit_database`,
  `alloydb_jdbc_urls`, `firestore_database_ids`, `valkey_endpoints`.
- **Endpoint URLs**: `vector_endpoint_resource_names`,
  `vector_endpoint_ids` — consumed by the `ai` module to wire deployed indexes.
- **CMEK references**: `cmek_key_refs` — a single map for audit evidence.
- **Lifecycle echo**: `memory_bank_ttl_days` — consumed by the runtime to
  populate Firestore TTL fields per D33.

All connection strings carrying IPs are marked `sensitive = true`.

## Pre-requisites

1. **Project APIs enabled** (handled by a separate bootstrap module):
   `spanner.googleapis.com`, `alloydb.googleapis.com`,
   `firestore.googleapis.com`, `aiplatform.googleapis.com`,
   `bigquery.googleapis.com`, `storage.googleapis.com`,
   `memorystore.googleapis.com`, `dataform.googleapis.com`,
   `pubsub.googleapis.com`, `cloudkms.googleapis.com`,
   `secretmanager.googleapis.com`, `servicenetworking.googleapis.com`.
2. **KMS keyrings** — one regional ring per region + one multi-region ring
   for the Spanner key. Owned by the `security` module.
3. **VPCs** — one per region with `service-networking` private connection
   established. Owned by the `networking` module.
4. **AlloyDB bootstrap secret** — `gcloud secrets create alloydb-bootstrap
   --replication-policy=automatic`, then version-add the password. The
   secret name (not version) is passed via
   `alloydb_initial_password_secret`.
5. **IAM grants** — the Vertex AI service agent, AlloyDB service agent,
   Spanner service agent, BigQuery service agent, Firestore service agent,
   GCS service agent, Memorystore service agent, and Dataform service
   agent must each have
   `roles/cloudkms.cryptoKeyEncrypterDecrypter` on the CMEK key they use.
   The `security` module provisions these bindings; this module assumes
   they exist.

## DDL out of band

Two stores have schemas that are intentionally not in HCL:

- **Spanner**: Tables, secondary indexes, foreign keys live in
  `_scripts/db/spanner/<version>.sql` and are applied via
  `gcloud spanner databases ddl update`. This lets the platform team roll
  forward / back without `terraform apply` cycles.
- **AlloyDB**: `CREATE EXTENSION google_ml_integration; CREATE EXTENSION
  vector; CREATE EXTENSION alloydb_scann;` plus `CREATE INDEX ... USING
  scann` live in `_scripts/db/alloydb/<version>.sql`. Same rationale.

`google_alloydb_instance` does set `database_flags.alloydb.iam_authentication =
on` and `google_ml_integration.enable_model_support = on` so the extensions
load on first connect.

## Cost shape (rough, $1500 D39 budget)

Steady-state idle (no traffic, but everything running for the judging window):

| Resource | $/day | Notes |
|----------|-------|-------|
| Spanner ENTERPRISE_PLUS, 1000 PU, nam-eur-asia1 | ~$22 | Single biggest line item. Drop to 100 PU between rehearsals. |
| AlloyDB primary 4 vCPU + 2-node read pool 2 vCPU + 2× secondary 2 vCPU | ~$18 | Bring secondary clusters to 0 if budget tightens. |
| Memorystore Valkey HIGHMEM_MEDIUM 1-shard 1-replica × 3 | ~$5 | Pin to SHARED_CORE_NANO if needed. |
| Firestore (idle) | ~$0 | Pay per read/write. |
| Vector Search index endpoint × 3 | ~$5 | Dedicated endpoints have a small standing cost. |
| BigQuery / GCS / Dataform / Pub/Sub (idle) | ~$0 | Storage-only. |
| **Total idle / day** | **~$50** | × 30-day judging window ≈ $1,500. |

D39's $1,500 covers the judging window exactly. For pre-submission
rehearsal weeks, drop Spanner PU + AlloyDB CPU counts via
`spanner_config.processing_units` and per-region `alloydb_cpu_count`.

## Examples

See [`examples/basic`](./examples/basic) for a one-region dev-grade
invocation.

## Validation

```bash
cd terraform/modules/data
terraform init -backend=false
terraform validate
```

`terraform validate` is intentionally minimal — full `plan` requires the
networking + security modules to have applied first. The CI gate is
`terraform validate` per module, then `terraform plan` against the env
composition in `terraform/envs/<env>/`.
