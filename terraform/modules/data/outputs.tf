# outputs.tf — connection strings + endpoint URLs + CMEK key refs.
# Downstream modules (compute, ai, integration) consume these to wire
# Agent Runtime, Cloud Run, and Dataflow without re-deriving names.

# Spanner -------------------------------------------------------------------

output "spanner_instance_name" {
  description = "Spanner instance name."
  value       = google_spanner_instance.core.name
}

output "spanner_core_database" {
  description = "Connection string for the Spanner `core` database."
  value       = "projects/${var.project_id}/instances/${google_spanner_instance.core.name}/databases/${google_spanner_database.core.name}"
}

output "spanner_audit_database" {
  description = "Connection string for the Spanner `audit` database."
  value       = "projects/${var.project_id}/instances/${google_spanner_instance.core.name}/databases/${google_spanner_database.audit.name}"
}

# AlloyDB -------------------------------------------------------------------

output "alloydb_primary_region" {
  description = "Region hosting the AlloyDB PRIMARY cluster."
  value       = local.primary_region
}

output "alloydb_clusters" {
  description = "Map region -> AlloyDB cluster resource name (primary + secondaries)."
  value = merge(
    { (local.primary_region) = google_alloydb_cluster.primary.name },
    { for r, c in google_alloydb_cluster.secondary : r => c.name },
  )
}

output "alloydb_jdbc_urls" {
  description = "Map region -> JDBC URL. PRIMARY for primary_region, SECONDARY elsewhere."
  value = merge(
    { (local.primary_region) = "jdbc:postgresql://${google_alloydb_instance.primary.ip_address}:5432/postgres" },
    { for r, i in google_alloydb_instance.secondary : r => "jdbc:postgresql://${i.ip_address}:5432/postgres" },
  )
  sensitive = true
}

output "alloydb_primary_read_pool_ip" {
  description = "Private IP of the AlloyDB primary-region READ_POOL."
  value       = google_alloydb_instance.primary_read_pool.ip_address
  sensitive   = true
}

# Firestore -----------------------------------------------------------------

output "firestore_database_ids" {
  description = "Map region -> Firestore database ID (short name agents pass to the SDK)."
  value       = { for r, db in google_firestore_database.regional : r => db.name }
}

# Vertex AI Vector Search ---------------------------------------------------

output "vector_index_ids" {
  description = "Map region -> Vertex AI Index ID."
  value       = { for r, idx in google_vertex_ai_index.regional : r => idx.id }
}

output "vector_endpoint_ids" {
  description = "Map region -> Vertex AI Index Endpoint ID (for `gcloud ai index-endpoints deploy-index`)."
  value       = { for r, ep in google_vertex_ai_index_endpoint.regional : r => ep.id }
}

output "vector_endpoint_resource_names" {
  description = "Map region -> fully-qualified Index Endpoint name (for SDK calls)."
  value       = { for r, ep in google_vertex_ai_index_endpoint.regional : r => ep.name }
}

# BigQuery ------------------------------------------------------------------

output "bigquery_analytics_datasets" {
  description = "Map region -> analytics dataset ID."
  value       = { for r, ds in google_bigquery_dataset.analytics : r => ds.dataset_id }
}

output "bigquery_billing_datasets" {
  description = "Map region -> per-view billing dataset ID (D28)."
  value       = { for r, ds in google_bigquery_dataset.billing : r => ds.dataset_id }
}

# Cloud Storage -------------------------------------------------------------

output "asset_buckets" {
  description = "Map region -> assets bucket name."
  value       = { for r, b in google_storage_bucket.assets : r => b.name }
}

output "audit_archive_buckets" {
  description = "Map region -> audit-archive bucket name (90-day retention lock per D33)."
  value       = { for r, b in google_storage_bucket.audit_archive : r => b.name }
}

output "vector_seed_buckets" {
  description = "Map region -> GCS bucket holding the Vector Search content-delta seed."
  value       = { for r, b in google_storage_bucket.vector_seed : r => b.name }
}

# Memorystore Valkey --------------------------------------------------------

output "valkey_endpoints" {
  description = "Map region -> Valkey discovery endpoint host:port."
  value = {
    for r, v in google_memorystore_instance.valkey :
    r => length(v.discovery_endpoints) > 0 ? "${v.discovery_endpoints[0].address}:${v.discovery_endpoints[0].port}" : ""
  }
  sensitive = true
}

# Dataform + Pub/Sub schemas ------------------------------------------------

output "dataform_repository_name" {
  description = "Dataform repository for the per-view billing transforms (D28)."
  value       = google_dataform_repository.billing.name
}

output "asyncapi_schema_ids" {
  description = "Map AsyncAPI channel -> Pub/Sub schema ID (D36)."
  value       = { for k, s in google_pubsub_schema.asyncapi : k => s.id }
}

# CMEK + lifecycle echo -----------------------------------------------------

output "cmek_key_refs" {
  description = "CMEK keys actually bound to each store — audit evidence for D20 + D33."
  value = {
    spanner       = local.spanner_kms_key
    alloydb       = { for r in keys(var.regions) : r => var.cmek_keys[r] }
    firestore     = { for r in keys(var.regions) : r => var.cmek_keys[r] }
    vector_search = { for r in keys(var.regions) : r => var.cmek_keys[r] }
    bigquery      = { for r in keys(var.regions) : r => var.cmek_keys[r] }
    storage       = { for r in keys(var.regions) : r => var.cmek_keys[r] }
    valkey        = { for r in keys(var.regions) : r => var.cmek_keys[r] }
    dataform      = var.cmek_keys[local.primary_region]
  }
}

output "memory_bank_ttl_days" {
  description = "Echo of the configured 14-day memory TTL — runtime writes Firestore TTL fields with this offset (D33)."
  value       = var.lifecycle_days.memory_bank_ttl
}
