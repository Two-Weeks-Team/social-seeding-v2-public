# terraform/modules/security/outputs.tf
#
# Outputs consumed by sibling modules:
#   - modules/data        — CMEK key IDs for Spanner / AlloyDB / Firestore / BigQuery / Storage / Pub/Sub
#   - modules/observability — Chronicle dataset + Model Armor block metric
#   - modules/ai          — Model Armor template resource names for Agent Runtime wiring
#   - modules/devops      — BinAuthz attestor name + workload identity pool for GitHub Actions

# ---------------------------------------------------------------------------
# CMEK keys (D20)
# ---------------------------------------------------------------------------

output "kms_keyring_ids" {
  description = "Map of region key (us|eu|ap) → KMS keyring resource ID."
  value = {
    for region_key, ring in google_kms_key_ring.regional :
    region_key => ring.id
  }
}

output "cmek_key_ids" {
  description = "Map of \"<region_key>-<purpose>\" → CMEK key resource ID. Purposes: spanner, alloydb, firestore, storage, bigquery, pubsub. Sibling modules read by composing keys, e.g. cmek_key_ids[\"us-spanner\"]."
  value = {
    for k, key in google_kms_crypto_key.cmek :
    k => key.id
  }
}

output "billing_hsm_key_id" {
  description = "Resource ID of the optional Cloud HSM billing-root key (D20). Null when var.enable_hsm_billing_root = false."
  value       = var.enable_hsm_billing_root ? google_kms_crypto_key.billing_hsm[0].id : null
}

# ---------------------------------------------------------------------------
# Secret Manager (D20)
# ---------------------------------------------------------------------------

output "secret_ids" {
  description = "Map of seed secret short-name → fully-qualified Secret Manager resource ID."
  value = {
    for k, s in google_secret_manager_secret.seeds :
    k => s.id
  }
}

output "secret_names" {
  description = "Map of seed secret short-name → secret_id (e.g. \"rapidapi\" → \"ss-rapidapi\")."
  value = {
    for k, s in google_secret_manager_secret.seeds :
    k => s.secret_id
  }
}

# ---------------------------------------------------------------------------
# Identity Platform (D19)
# ---------------------------------------------------------------------------

output "identity_platform_template_tenant_name" {
  description = "Server-generated name of the template tenant. Mission Control passes this as tenantId when running its CI auth tests."
  value       = google_identity_platform_tenant.template.name
}

# ---------------------------------------------------------------------------
# Workforce Identity Federation (D19) — staff SSO
# ---------------------------------------------------------------------------

output "workforce_pool_name" {
  description = "Fully-qualified Workforce Pool name (locations/global/workforcePools/{id}). Null when not configured."
  value       = length(google_iam_workforce_pool.staff) > 0 ? google_iam_workforce_pool.staff[0].name : null
}

output "workforce_provider_name" {
  description = "Fully-qualified Workforce Pool Provider name. Null when not configured."
  value       = length(google_iam_workforce_pool_provider.staff_oidc) > 0 ? google_iam_workforce_pool_provider.staff_oidc[0].name : null
}

# ---------------------------------------------------------------------------
# Workload Identity Federation (D38) — GitHub Actions
# ---------------------------------------------------------------------------

output "workload_pool_name" {
  description = "Fully-qualified Workload Identity Pool name for GitHub Actions. Feed this + the provider name into the github/auth-action's workload_identity_provider input."
  value       = google_iam_workload_identity_pool.github.name
}

output "workload_provider_name" {
  description = "Fully-qualified Workload Identity Pool Provider name for GitHub Actions."
  value       = google_iam_workload_identity_pool_provider.github.name
}

# ---------------------------------------------------------------------------
# DLP (D20, D33)
# ---------------------------------------------------------------------------

output "dlp_pi_template_id" {
  description = "Resource ID of the PI inspect template. Reference from log sinks and Model Armor advanced configs."
  value       = google_data_loss_prevention_inspect_template.pi.id
}

output "dlp_pii_template_id" {
  description = "Resource ID of the PII inspect template (KR + JP + CN + US national IDs + generic PII)."
  value       = google_data_loss_prevention_inspect_template.pii.id
}

output "dlp_brand_template_id" {
  description = "Resource ID of the brand/competitor regex template."
  value       = google_data_loss_prevention_inspect_template.brand.id
}

# ---------------------------------------------------------------------------
# Model Armor (D21)
# ---------------------------------------------------------------------------

output "model_armor_input_template" {
  description = "Resource ID of the ss-input Model Armor template. Pass to Agent Runtime / Agent Gateway extension config."
  value       = google_model_armor_template.input.id
}

output "model_armor_output_template" {
  description = "Resource ID of the ss-output Model Armor template."
  value       = google_model_armor_template.output.id
}

output "model_armor_enforcement_mode" {
  description = "Effective enforcement mode (INSPECT_AND_BLOCK | INSPECT_ONLY) — exposed so the demo + Devpost write-up can attest the policy is enforcing, not just observing."
  value       = local.model_armor_enforcement_type
}

# ---------------------------------------------------------------------------
# Binary Authorization (D37)
# ---------------------------------------------------------------------------

output "binauthz_attestor_name" {
  description = "Short name of the production attestor. Cloud Build pipelines pass this to `gcloud container binauthz attestations sign-and-create`."
  value       = google_binary_authorization_attestor.prod.name
}

output "binauthz_policy_id" {
  description = "Resource ID of the project's Binary Authorization policy."
  value       = google_binary_authorization_policy.policy.id
}

# ---------------------------------------------------------------------------
# Security Command Center + Chronicle (D21, D32)
# ---------------------------------------------------------------------------

output "scc_source_name" {
  description = "Resource name of the ss-security-watch SCC source. Null when SCC is disabled."
  value       = length(google_scc_source.ss_security_watch) > 0 ? google_scc_source.ss_security_watch[0].name : null
}

output "chronicle_audit_dataset" {
  description = "BigQuery dataset that holds the audit-log mirror Chronicle ingests from."
  value       = google_bigquery_dataset.chronicle_audit.dataset_id
}

output "chronicle_audit_sink_writer" {
  description = "Writer-identity service account auto-created for the audit log sink. Used by external Chronicle Lift sinks if added later."
  value       = google_logging_project_sink.chronicle_audit.writer_identity
}

output "model_armor_block_metric_name" {
  description = "Log-based metric counting Model Armor MATCH_FOUND events. Alert policy lives in modules/observability."
  value       = google_logging_metric.model_armor_blocks.name
}
