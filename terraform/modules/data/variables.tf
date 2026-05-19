# variables.tf — input contract for the data module.
#
# The module is multi-region (D13 active-active) and CMEK-everywhere (D20).
# Callers must:
#   1. Provide ONE Spanner multi-region instance config (default nam-eur-asia1).
#   2. Provide N per-region descriptors for AlloyDB / Firestore / Vector Search /
#      BigQuery / GCS / Memorystore. The map key is the logical region label and
#      MUST match a CMEK key handed in via `cmek_keys` so encryption_config can
#      bind to a same-region KMS CryptoKey.
#   3. Provide pre-created VPC selflinks (one per region) — this module does NOT
#      provision networking; the `networking` module owns that.

variable "project_id" {
  description = "GCP project hosting all data-plane resources."
  type        = string
}

variable "name_prefix" {
  description = "Short prefix prepended to every resource (e.g. \"ss-v2\"). Lowercase alnum + hyphen, <= 12 chars."
  type        = string
  default     = "ss-v2"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,11}$", var.name_prefix))
    error_message = "name_prefix must be lowercase alphanumeric + hyphen, 3-12 chars, start with a letter."
  }
}

variable "environment" {
  description = "Environment label (prod | staging | dev). Applied to labels and disables deletion_protection for non-prod."
  type        = string
  default     = "prod"

  validation {
    condition     = contains(["prod", "staging", "dev"], var.environment)
    error_message = "environment must be one of prod, staging, dev."
  }
}

variable "regions" {
  description = <<-EOT
    Per-region descriptors. Map key is the region label (e.g. us-central1).
    Every region MUST also be present as a key in `cmek_keys` and `vpc_networks`.
    The first region in alphabetical order is treated as the AlloyDB cross-region replica primary.
  EOT
  type = map(object({
    location                 = string                 # GCP region, e.g. us-central1
    firestore_location       = string                 # nam5/eur3 multi-region OR single-region (asia-northeast3, etc.)
    alloydb_cpu_count        = optional(number, 4)    # primary instance vCPU
    alloydb_replica_cpu      = optional(number, 2)    # read replica vCPU
    valkey_shard_count       = optional(number, 1)
    valkey_replica_count     = optional(number, 1)
    valkey_node_type         = optional(string, "HIGHMEM_MEDIUM")
    valkey_engine_version    = optional(string, "VALKEY_8_0") # Valkey 8 = vector-search GA per DATA.md §10.3

    vector_index_dimensions  = optional(number, 768)  # text-embedding-005 default
    vector_index_shard_size  = optional(string, "SHARD_SIZE_SMALL")
    vector_distance_measure  = optional(string, "COSINE_DISTANCE")
    bigquery_location        = optional(string)       # falls back to location
  }))

  validation {
    condition     = length(var.regions) >= 1 && length(var.regions) <= 5
    error_message = "Provide between 1 and 5 regions."
  }
}

variable "cmek_keys" {
  description = <<-EOT
    Per-region CMEK CryptoKey resource IDs, format
    projects/<p>/locations/<region>/keyRings/<ring>/cryptoKeys/<key>.
    The map MUST contain one entry per region in `regions` plus one with the key
    `multi_region` for the Spanner multi-region instance (the KMS key for that
    one is itself a multi-region key — e.g. in `nam-eur-asia1`).
    Provided by the `security` module's KMS keyrings (D20).
  EOT
  type = map(string)

  validation {
    condition     = contains(keys(var.cmek_keys), "multi_region")
    error_message = "cmek_keys must contain a `multi_region` entry for the Spanner multi-region instance."
  }
}

variable "spanner_config" {
  description = "Spanner multi-region instance config."
  type = object({
    instance_config  = optional(string, "nam-eur-asia1")
    processing_units = optional(number, 1000) # 1 node ≈ 1000 PU; bump for prod hot path
    edition          = optional(string, "ENTERPRISE_PLUS")
  })
  default = {}
}

variable "vpc_networks" {
  description = <<-EOT
    Per-region VPC selflinks (projects/<p>/global/networks/<n>) used for
    AlloyDB private networking and Memorystore service-connect. The
    `networking` module owns provisioning.
  EOT
  type = map(string)
}

variable "alloydb_initial_password_secret" {
  description = "Secret Manager secret ID (not version) that holds the AlloyDB postgres bootstrap password. The actual access path is `secret_id/versions/latest`. Module reads via data source — never inlined."
  type        = string
}

variable "lifecycle_days" {
  description = "Data lifecycle thresholds (days). Defaults map to D33: PII 30 / audit 90 / memory 14."
  type = object({
    pii_assets_retention      = optional(number, 30)
    audit_archive_retention   = optional(number, 90)
    memory_bank_ttl           = optional(number, 14) # surfaced as an output for Firestore TTL policy
    bigquery_partition_expire = optional(number, 90)
    storage_nearline_at       = optional(number, 30)
    storage_archive_at        = optional(number, 60)
  })
  default = {}
}

variable "vector_index_seed_bucket_suffix" {
  description = "Suffix for the per-region GCS bucket that holds the Vector Search content-delta-uri seed object. The module creates `${name_prefix}-${region}-${suffix}`."
  type        = string
  default     = "vector-seed"
}

variable "asyncapi_schema_seeds" {
  description = <<-EOT
    Pub/Sub Schema Registry seeds derived from `specs/_common/shared.asyncapi.yaml`.
    Each entry creates a `google_pubsub_schema` resource using AVRO type by default.
    Default value seeds the 7 lifecycle channels documented in shared.asyncapi.yaml.
  EOT
  type = list(object({
    schema_id  = string
    type       = optional(string, "AVRO")
    definition = string
  }))
  default = []
}

variable "labels" {
  description = "Common labels merged onto every resource."
  type        = map(string)
  default = {
    managed-by = "terraform"
    module     = "data"
    decision   = "d15-d16-d33"
  }
}

variable "enable_deletion_protection" {
  description = "Hard guard on Spanner / AlloyDB / Firestore. Auto-disabled when environment != prod."
  type        = bool
  default     = true
}
