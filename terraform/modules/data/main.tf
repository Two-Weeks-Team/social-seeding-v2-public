# main.tf — data plane for social-seeding-v2.
#
# Implements decisions:
#   D13  global active-active (US + EU + APAC by default)
#   D15  hybrid OLTP: Spanner (core) + AlloyDB AI (analytics/feature) + Firestore Native (memory bank)
#   D16  Vertex AI Vector Search dedicated endpoint per region
#   D20  CMEK across every store; secrets via Secret Manager
#   D28  Per-view billing — Dataform repo + BigQuery dataset
#   D33  Lifecycle: PII 30d / audit 90d / memory 14d
#   D36  Pub/Sub Schema Registry seeded from AsyncAPI 3.0
#
# Naming convention: ${name_prefix}-${region}-<resource-kind>; multi-region
# resources use ${name_prefix}-mr-<resource-kind>.

locals {
  effective_labels = merge(
    var.labels,
    {
      environment = var.environment
    },
  )

  # Deletion protection is hard-on in prod; off everywhere else so terraform
  # destroy works during dev/staging tear-down.
  deletion_protection = var.environment == "prod" ? var.enable_deletion_protection : false

  # Pick the lexicographically-first region as the AlloyDB primary; the rest
  # are SECONDARY clusters with cross-region replication (D13).
  ordered_regions = sort(keys(var.regions))
  primary_region  = local.ordered_regions[0]
  replica_regions = slice(local.ordered_regions, 1, length(local.ordered_regions))

  # Convenience accessors.
  spanner_kms_key = var.cmek_keys["multi_region"]
}

# ---------------------------------------------------------------------------
# 0. Bootstrap data lookups
# ---------------------------------------------------------------------------

data "google_secret_manager_secret_version_access" "alloydb_password" {
  project = var.project_id
  secret  = var.alloydb_initial_password_secret
  # `version` omitted -> defaults to "latest".
}

# ---------------------------------------------------------------------------
# 1. Spanner — multi-region core (D13 + D15)
# ---------------------------------------------------------------------------
# One instance, two databases: `core` (tenants, campaigns, billing) and
# `audit` (90-day audit keys per D33). Both CMEK-encrypted with the same
# multi-region key.

resource "google_spanner_instance" "core" {
  project          = var.project_id
  name             = "${var.name_prefix}-mr-spanner"
  display_name     = "${var.name_prefix} core multi-region"
  config           = var.spanner_config.instance_config
  processing_units = var.spanner_config.processing_units
  edition          = var.spanner_config.edition

  labels = local.effective_labels

  force_destroy = !local.deletion_protection
}

resource "google_spanner_database" "core" {
  project                  = var.project_id
  instance                 = google_spanner_instance.core.name
  name                     = "core"
  database_dialect         = "GOOGLE_STANDARD_SQL"
  version_retention_period = "1h"
  deletion_protection      = local.deletion_protection

  encryption_config {
    kms_key_name = local.spanner_kms_key
  }

  # DDL is empty here — migrations live in `_scripts/db/spanner/` and are
  # applied via `gcloud spanner databases ddl update` outside Terraform so the
  # platform team can roll forward / back without touching plan output.
  ddl = []
}

resource "google_spanner_database" "audit" {
  project                  = var.project_id
  instance                 = google_spanner_instance.core.name
  name                     = "audit"
  database_dialect         = "GOOGLE_STANDARD_SQL"
  version_retention_period = "1h"
  deletion_protection      = local.deletion_protection

  encryption_config {
    kms_key_name = local.spanner_kms_key
  }

  ddl = []
}

# ---------------------------------------------------------------------------
# 2. AlloyDB — per-region analytics + AI/ScaNN feature store (D15)
# ---------------------------------------------------------------------------
# Topology:
#   - PRIMARY cluster in `local.primary_region` with one PRIMARY instance and
#     one READ_POOL instance (read replicas live in the same cluster).
#   - SECONDARY clusters in every other region with a SECONDARY instance
#     fed by cross-region replication.
#
# ScaNN-index DDL is intentionally out-of-band (see same rationale as Spanner)
# — Terraform creates the cluster, the `_scripts/db/alloydb/` SQL applies
# extensions + `CREATE INDEX ... USING scann`.

resource "google_alloydb_cluster" "primary" {
  provider = google-beta

  project    = var.project_id
  cluster_id = "${var.name_prefix}-${local.primary_region}-alloydb"
  location   = var.regions[local.primary_region].location

  database_version    = "POSTGRES_16"
  cluster_type        = "PRIMARY"
  deletion_protection = local.deletion_protection
  labels              = local.effective_labels

  network_config {
    network = var.vpc_networks[local.primary_region]
  }

  encryption_config {
    kms_key_name = var.cmek_keys[local.primary_region]
  }

  initial_user {
    user     = "alloydbadmin"
    password = data.google_secret_manager_secret_version_access.alloydb_password.secret_data
  }

  automated_backup_policy {
    enabled       = true
    location      = var.regions[local.primary_region].location
    backup_window = "1800s"

    weekly_schedule {
      days_of_week = ["MONDAY", "THURSDAY"]
      start_times {
        hours = 2
      }
    }

    quantity_based_retention {
      count = 14
    }

    encryption_config {
      kms_key_name = var.cmek_keys[local.primary_region]
    }
  }

  continuous_backup_config {
    enabled              = true
    recovery_window_days = 14

    encryption_config {
      kms_key_name = var.cmek_keys[local.primary_region]
    }
  }
}

resource "google_alloydb_instance" "primary" {
  provider = google-beta

  cluster       = google_alloydb_cluster.primary.name
  instance_id   = "${var.name_prefix}-${local.primary_region}-alloydb-primary"
  instance_type = "PRIMARY"

  machine_config {
    cpu_count = var.regions[local.primary_region].alloydb_cpu_count
  }

  database_flags = {
    # Required for AlloyDB AI's google_ml_integration + ScaNN extensions.
    "alloydb.iam_authentication"          = "on"
    "google_ml_integration.enable_model_support" = "on"
  }

  labels = local.effective_labels
}

resource "google_alloydb_instance" "primary_read_pool" {
  provider = google-beta

  cluster       = google_alloydb_cluster.primary.name
  instance_id   = "${var.name_prefix}-${local.primary_region}-alloydb-reads"
  instance_type = "READ_POOL"

  read_pool_config {
    node_count = 2
  }

  machine_config {
    cpu_count = var.regions[local.primary_region].alloydb_replica_cpu
  }

  labels = local.effective_labels

  depends_on = [google_alloydb_instance.primary]
}

# Cross-region SECONDARY clusters — one per non-primary region.
resource "google_alloydb_cluster" "secondary" {
  provider = google-beta

  for_each = toset(local.replica_regions)

  project    = var.project_id
  cluster_id = "${var.name_prefix}-${each.key}-alloydb"
  location   = var.regions[each.key].location

  database_version    = "POSTGRES_16"
  cluster_type        = "SECONDARY"
  deletion_protection = local.deletion_protection
  deletion_policy     = local.deletion_protection ? "DEFAULT" : "FORCE"
  labels              = local.effective_labels

  network_config {
    network = var.vpc_networks[each.key]
  }

  encryption_config {
    kms_key_name = var.cmek_keys[each.key]
  }

  secondary_config {
    primary_cluster_name = google_alloydb_cluster.primary.name
  }

  continuous_backup_config {
    enabled              = true
    recovery_window_days = 14

    encryption_config {
      kms_key_name = var.cmek_keys[each.key]
    }
  }
}

resource "google_alloydb_instance" "secondary" {
  provider = google-beta

  for_each = google_alloydb_cluster.secondary

  cluster       = each.value.name
  instance_id   = "${var.name_prefix}-${each.key}-alloydb-secondary"
  instance_type = "SECONDARY"

  machine_config {
    cpu_count = var.regions[each.key].alloydb_replica_cpu
  }

  labels = local.effective_labels
}

# ---------------------------------------------------------------------------
# 3. Firestore Native — per-region (Agent Memory Bank backing, D15 + D33)
# ---------------------------------------------------------------------------
# Firestore is region-locked per database; for active-active we create one
# database per region. The Agent Memory Bank picks its regional database via
# the `database_id` parameter on Memory Bank creation.
#
# TTL for the 14-day memory expiry is enforced via Firestore TTL policies on
# the `expireAt` field — managed in `_scripts/db/firestore/ttl-policies.json`
# rather than HCL (Terraform's `google_firestore_field` requires the
# collection to exist, which is a runtime concern).

resource "google_firestore_database" "regional" {
  for_each = var.regions

  project                           = var.project_id
  name                              = "${var.name_prefix}-${each.key}-memory"
  location_id                       = each.value.firestore_location
  type                              = "FIRESTORE_NATIVE"
  database_edition                  = "ENTERPRISE"
  concurrency_mode                  = "OPTIMISTIC"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
  app_engine_integration_mode       = "DISABLED"
  delete_protection_state           = local.deletion_protection ? "DELETE_PROTECTION_ENABLED" : "DELETE_PROTECTION_DISABLED"
  deletion_policy                   = local.deletion_protection ? "ABANDON" : "DELETE"

  cmek_config {
    kms_key_name = var.cmek_keys[each.key]
  }
}

# ---------------------------------------------------------------------------
# 4. Vertex AI Vector Search — index + dedicated endpoint per region (D16)
# ---------------------------------------------------------------------------
# - One STREAM_UPDATE index per region (incremental upserts from Agent Memory
#   Bank, no batch GCS reload needed at steady state).
# - One dedicated index endpoint per region (better isolation + DNS than the
#   shared regional endpoint).
# - Seed GCS bucket holds the empty contents-delta-uri so the index creates
#   cleanly; agents upsert datapoints via the API thereafter.

resource "google_storage_bucket" "vector_seed" {
  for_each = var.regions

  project       = var.project_id
  name          = "${var.name_prefix}-${each.key}-${var.vector_index_seed_bucket_suffix}"
  location      = upper(each.value.location)
  storage_class = "STANDARD"

  uniform_bucket_level_access = true
  force_destroy               = !local.deletion_protection

  versioning {
    enabled = true
  }

  encryption {
    default_kms_key_name = var.cmek_keys[each.key]
  }

  labels = local.effective_labels
}

resource "google_vertex_ai_index" "regional" {
  provider = google-beta

  for_each = var.regions

  project      = var.project_id
  region       = each.value.location
  display_name = "${var.name_prefix}-${each.key}-creator-index"
  description  = "Creator + brand embeddings for region ${each.key}. D16 — Vertex AI Vector Search."

  metadata {
    contents_delta_uri = "gs://${google_storage_bucket.vector_seed[each.key].name}/contents"

    config {
      dimensions                  = each.value.vector_index_dimensions
      approximate_neighbors_count = 150
      shard_size                  = each.value.vector_index_shard_size
      distance_measure_type       = each.value.vector_distance_measure

      algorithm_config {
        tree_ah_config {
          leaf_node_embedding_count    = 1000
          leaf_nodes_to_search_percent = 7
        }
      }
    }
  }

  index_update_method = "STREAM_UPDATE"

  encryption_spec {
    kms_key_name = var.cmek_keys[each.key]
  }

  labels = local.effective_labels
}

resource "google_vertex_ai_index_endpoint" "regional" {
  provider = google-beta

  for_each = var.regions

  project      = var.project_id
  region       = each.value.location
  display_name = "${var.name_prefix}-${each.key}-creator-endpoint"
  description  = "Dedicated Vector Search endpoint for region ${each.key}. D16."

  # `public_endpoint_enabled` is intentionally false. The runtime path is
  # Private Service Connect; the security module sets up the PSC config on the
  # endpoint via a separate `google_vertex_ai_index_endpoint_deployed_index`
  # resource after IAM is wired.
  public_endpoint_enabled = false
  network                 = var.vpc_networks[each.key]

  encryption_spec {
    kms_key_name = var.cmek_keys[each.key]
  }

  labels = local.effective_labels
}

# ---------------------------------------------------------------------------
# 5. BigQuery — per-region analytics + billing dataset (D28 + D33)
# ---------------------------------------------------------------------------
# Two datasets per region:
#   - `${prefix}_${region}_analytics`  : campaign telemetry, eval results
#   - `${prefix}_${region}_billing`    : per-view billing facts (Dataform target)
# Both apply `default_partition_expiration_ms = 90d` per D33.

resource "google_bigquery_dataset" "analytics" {
  for_each = var.regions

  project    = var.project_id
  dataset_id = "${replace(var.name_prefix, "-", "_")}_${replace(each.key, "-", "_")}_analytics"
  location   = coalesce(each.value.bigquery_location, each.value.location)

  description                     = "Telemetry + eval analytics for ${each.key}. D33 90-day partition expiry."
  default_partition_expiration_ms = var.lifecycle_days.bigquery_partition_expire * 24 * 60 * 60 * 1000
  default_table_expiration_ms     = null
  max_time_travel_hours           = 48 # tighter than default 168h to cut storage cost

  default_encryption_configuration {
    kms_key_name = var.cmek_keys[each.key]
  }

  labels = local.effective_labels
}

resource "google_bigquery_dataset" "billing" {
  for_each = var.regions

  project    = var.project_id
  dataset_id = "${replace(var.name_prefix, "-", "_")}_${replace(each.key, "-", "_")}_billing"
  location   = coalesce(each.value.bigquery_location, each.value.location)

  description                     = "Per-view billing facts ($0.01/view per D28). Dataform target."
  default_partition_expiration_ms = var.lifecycle_days.bigquery_partition_expire * 24 * 60 * 60 * 1000
  max_time_travel_hours           = 48

  default_encryption_configuration {
    kms_key_name = var.cmek_keys[each.key]
  }

  labels = local.effective_labels
}

# ---------------------------------------------------------------------------
# 6. Cloud Storage — per-region assets + audit archive (D33)
# ---------------------------------------------------------------------------
# Two buckets per region:
#   - assets   (signed-URL uploads from Mission Control; PII retained 30d)
#   - audit    (audit log archive sink; retained 90d before delete)

resource "google_storage_bucket" "assets" {
  for_each = var.regions

  project       = var.project_id
  name          = "${var.name_prefix}-${each.key}-assets"
  location      = upper(each.value.location)
  storage_class = "STANDARD"

  uniform_bucket_level_access = true
  force_destroy               = !local.deletion_protection

  soft_delete_policy {
    retention_duration_seconds = 7 * 24 * 60 * 60 # 7d, GCS default
  }

  versioning {
    enabled = true
  }

  encryption {
    default_kms_key_name = var.cmek_keys[each.key]
  }

  # D33: PII assets must be deleted after 30 days.
  lifecycle_rule {
    condition {
      age            = var.lifecycle_days.storage_nearline_at
      matches_prefix = ["assets/"]
    }
    action {
      type          = "SetStorageClass"
      storage_class = "NEARLINE"
    }
  }
  lifecycle_rule {
    condition {
      age            = var.lifecycle_days.pii_assets_retention
      matches_prefix = ["pii/"]
    }
    action {
      type = "Delete"
    }
  }
  lifecycle_rule {
    condition {
      age = 365
    }
    action {
      type = "Delete"
    }
  }

  labels = local.effective_labels
}

resource "google_storage_bucket" "audit_archive" {
  for_each = var.regions

  project       = var.project_id
  name          = "${var.name_prefix}-${each.key}-audit"
  location      = upper(each.value.location)
  storage_class = "STANDARD"

  uniform_bucket_level_access = true
  force_destroy               = !local.deletion_protection

  retention_policy {
    # Hold audit logs immutable for 90 days (D33 + Chronicle SIEM ingest window).
    retention_period = var.lifecycle_days.audit_archive_retention * 24 * 60 * 60
  }

  versioning {
    enabled = true
  }

  encryption {
    default_kms_key_name = var.cmek_keys[each.key]
  }

  # After the 90-day hold lifts, transition to ARCHIVE class then delete.
  lifecycle_rule {
    condition {
      age = var.lifecycle_days.audit_archive_retention + 1
    }
    action {
      type          = "SetStorageClass"
      storage_class = "ARCHIVE"
    }
  }
  lifecycle_rule {
    condition {
      age = var.lifecycle_days.audit_archive_retention + 275 # ≈1 year total
    }
    action {
      type = "Delete"
    }
  }

  labels = local.effective_labels
}

# ---------------------------------------------------------------------------
# 7. Memorystore for Valkey 8 — per-region hot cache (D15 ancillary)
# ---------------------------------------------------------------------------
# Holds: session state, hot vector top-N, MCP per-request scratch (DATA.md §10).

resource "google_memorystore_instance" "valkey" {
  provider = google-beta

  for_each = var.regions

  project     = var.project_id
  instance_id = "${var.name_prefix}-${each.key}-valkey"
  location    = each.value.location

  shard_count   = each.value.valkey_shard_count
  replica_count = each.value.valkey_replica_count
  node_type     = each.value.valkey_node_type

  engine_version          = each.value.valkey_engine_version
  mode                    = "CLUSTER"
  transit_encryption_mode = "SERVER_AUTHENTICATION"
  authorization_mode      = "IAM_AUTH"

  kms_key = var.cmek_keys[each.key]

  engine_configs = {
    "maxmemory-policy" = "allkeys-lru"
  }

  persistence_config {
    mode = "RDB"
    rdb_config {
      rdb_snapshot_period = "ONE_HOUR"
    }
  }

  desired_auto_created_endpoints {
    network    = var.vpc_networks[each.key]
    project_id = var.project_id
  }

  deletion_protection_enabled = local.deletion_protection
  labels                      = local.effective_labels
}

# ---------------------------------------------------------------------------
# 8. Dataform repository — per-view billing transformations (D28)
# ---------------------------------------------------------------------------
# Single repo (BigQuery is multi-region for transformations; one Dataform repo
# can target multiple datasets). Kept in the primary region for simplicity.

resource "google_dataform_repository" "billing" {
  project = var.project_id
  region  = var.regions[local.primary_region].location
  name    = "${var.name_prefix}-billing-transforms"

  display_name = "${var.name_prefix} per-view billing transforms"
  kms_key_name = var.cmek_keys[local.primary_region]
  labels       = local.effective_labels

  workspace_compilation_overrides {
    default_database = var.project_id
    schema_suffix    = "_prod"
  }
}

# ---------------------------------------------------------------------------
# 9. Pub/Sub Schema Registry seeds (D36)
# ---------------------------------------------------------------------------
# Seeded from `gcp-research/specs/_common/shared.asyncapi.yaml`. Callers can
# extend via the `asyncapi_schema_seeds` variable; the defaults below cover the
# 7 lifecycle channels that exist as of 2026-05-19.

locals {
  # Each default seed = (channel, record name, namespace, extra fields beyond
  # the common envelope). The common envelope is `tenant_id`, `event_id`,
  # `occurred_at` (timestamp-micros). Keeping the schema list data-driven lets
  # callers extend via `var.asyncapi_schema_seeds` without touching HCL.
  asyncapi_common_fields = [
    { name = "tenant_id", type = "string" },
    { name = "event_id", type = "string" },
    { name = "occurred_at", type = { type = "long", logicalType = "timestamp-micros" } },
  ]

  asyncapi_extra_fields = {
    "agent.lifecycle.invoked"     = [{ name = "agent_id", type = "string" }, { name = "run_id", type = "string" }, { name = "input_hash", type = "string" }]
    "agent.lifecycle.completed"   = [{ name = "agent_id", type = "string" }, { name = "run_id", type = "string" }, { name = "status", type = "string" }, { name = "cost_usd_micro", type = "long" }]
    "agent.lifecycle.escalated"   = [{ name = "agent_id", type = "string" }, { name = "run_id", type = "string" }, { name = "reason", type = "string" }]
    "agent.cost.recorded"         = [{ name = "model", type = "string" }, { name = "tokens_in", type = "long" }, { name = "tokens_out", type = "long" }, { name = "usd_micro", type = "long" }]
    "system.armor.input_blocked"  = [{ name = "agent_id", type = "string" }, { name = "run_id", type = "string" }, { name = "policy", type = "string" }]
    "system.armor.output_blocked" = [{ name = "agent_id", type = "string" }, { name = "run_id", type = "string" }, { name = "policy", type = "string" }]
    "watchdog.anomaly.detected"   = [{ name = "metric", type = "string" }, { name = "value", type = "double" }, { name = "threshold", type = "double" }]
  }

  default_asyncapi_seeds = [
    for channel, extras in local.asyncapi_extra_fields : {
      schema_id = channel
      type      = "AVRO"
      definition = jsonencode({
        type      = "record"
        name      = join("", [for s in split(".", channel) : title(s)])
        namespace = "com.socialseed.${join(".", slice(split(".", channel), 0, length(split(".", channel)) - 1))}"
        fields    = concat(local.asyncapi_common_fields, extras)
      })
    }
  ]

  asyncapi_seeds = length(var.asyncapi_schema_seeds) > 0 ? var.asyncapi_schema_seeds : local.default_asyncapi_seeds
}

resource "google_pubsub_schema" "asyncapi" {
  for_each = { for s in local.asyncapi_seeds : s.schema_id => s }

  project    = var.project_id
  name       = "${var.name_prefix}-${replace(each.value.schema_id, ".", "-")}"
  type       = each.value.type
  definition = each.value.definition
}
