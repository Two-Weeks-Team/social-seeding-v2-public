# terraform/modules/security/variables.tf
#
# Input contract for the social-seeding-v2 security module.
#
# Decisions of record:
#   D13 — Global multi-region active-active (US + EU + APAC) → 3 KMS keyrings
#   D19 — Identity Platform multi-tenant + Workforce Identity Federation
#   D20 — CMEK across all stores + Secret Manager + DLP redaction
#   D21 — Model Armor max policy (PI/JB/PII/RAI/custom regex)
#   D32 — Chronicle SecOps export sink
#   D37 — Binary Authorization (image-signing gate)
#   D38 — Workload Identity Federation (GitHub Actions, no SA keys)

variable "project_id" {
  description = "Numeric or alphanumeric GCP project ID that owns these security resources. Per O2 the canonical IDs are ss-v2-prod-{us|eu|ap} for active-active; this module is invoked once per project."
  type        = string
}

variable "project_number" {
  description = "Numeric project number (used to derive Google-managed service-account principals such as service-{number}@gcp-sa-secretmanager.iam.gserviceaccount.com). Required because the providers do not expose a stable, no-call accessor for it."
  type        = string
}

variable "org_id" {
  description = "Numeric organization ID (e.g. 123456789). Required for Workforce Identity Federation pools and Security Command Center sources (organization-scoped)."
  type        = string
}

variable "regions" {
  description = "Active-active region set per D13. The default mirrors SERVICE-INVENTORY §6 — US-central + EU-west + APAC-northeast. The first region is treated as the primary for global-scope resources (Identity Platform, Model Armor floor, BinAuthz)."
  type = object({
    us = string
    eu = string
    ap = string
  })
  default = {
    us = "us-central1"
    eu = "europe-west4"
    ap = "asia-northeast3"
  }
}

variable "labels" {
  description = "Labels stamped on every resource that supports them. Keep keys lowercase + hyphen-free (GCP rule)."
  type        = map(string)
  default = {
    product    = "social-seeding-v2"
    managed-by = "terraform"
    module     = "security"
  }
}

# ---------------------------------------------------------------------------
# Cloud KMS / CMEK (D20)
# ---------------------------------------------------------------------------

variable "cmek_key_rotation_period" {
  description = "Rotation period for CMEK keys (Spanner, AlloyDB, Firestore, Storage, BigQuery, Pub/Sub). Default 90 days. NIST SP 800-57 §5.3.5 recommends ≤2 years for symmetric storage keys; 90 d is the conservative default."
  type        = string
  default     = "7776000s" # 90 days
}

variable "enable_hsm_billing_root" {
  description = "If true, provision a Cloud HSM-protected key in the primary region for billing-data envelope encryption (D20). Default off (~$3.50/key/month + per-op fees) — flip on once Apigee per-view billing pipeline is live."
  type        = bool
  default     = false
}

variable "cmek_destroy_scheduled_duration" {
  description = "Soft-delete window before a CMEK version is irrecoverably destroyed. GCP default = 24h; we lengthen to 30 days so a misfire can be undone."
  type        = string
  default     = "2592000s" # 30 days
}

# ---------------------------------------------------------------------------
# Secret Manager (D20)
# ---------------------------------------------------------------------------

variable "seed_secrets" {
  description = "Seed secrets to create with placeholder values. Engineers must run `gcloud secrets versions add` to populate real values — never commit secret bodies. The 8 entries are mandated by D20 + SERVICE-INVENTORY §6: rapidapi (D14), gmail-oauth-refresh (D10), ig-token (D14 phase-2), chronicle (D32), pagerduty + slack (D32 alerting), idp-sdk (D19 admin), stripe (D28 billing)."
  type        = list(string)
  default = [
    "rapidapi",
    "gmail-oauth-refresh",
    "ig-token",
    "chronicle",
    "pagerduty",
    "slack",
    "idp-sdk",
    "stripe",
  ]
  validation {
    condition     = length(var.seed_secrets) == length(distinct(var.seed_secrets))
    error_message = "seed_secrets must be unique."
  }
}

# ---------------------------------------------------------------------------
# Identity Platform (D19)
# ---------------------------------------------------------------------------

variable "identity_platform_template_tenant_id" {
  description = "Display-name suffix used for the bootstrap tenant. Per D12 the production model is tenant-per-customer; this template tenant exists so the Mission Control onboarding flow can be exercised in CI without an admin call."
  type        = string
  default     = "template-tenant"
}

variable "identity_platform_google_oauth_client_id" {
  description = "Google OAuth client ID for the customer-facing tenant's Sign-in-with-Google button. Issued via GCP Console > APIs & Services > Credentials. Stored as a Terraform variable (not a secret) because the client_id is public; the client_secret comes from Secret Manager."
  type        = string
  default     = ""
}

variable "identity_platform_saml_idp_metadata_xml" {
  description = "Raw SAML 2.0 metadata XML for the optional customer SAML IdP. Empty by default — enterprise tenants supply their Okta/Azure-AD metadata at onboarding."
  type        = string
  default     = ""
  sensitive   = true
}

variable "identity_platform_oidc_issuer_uri" {
  description = "OIDC issuer URI for the optional customer OIDC IdP (e.g. https://login.microsoftonline.com/{tenant}/v2.0). Empty by default."
  type        = string
  default     = ""
}

variable "identity_platform_oidc_client_id" {
  description = "OIDC client ID for the optional customer OIDC IdP. Empty by default."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Workforce Identity Federation — staff SSO (D19)
# ---------------------------------------------------------------------------

variable "workforce_pool_id" {
  description = "ID of the org-level Workforce Identity Pool used by staff (4-32 chars, [a-z0-9-]). Per D19 staff authenticate via Google Workspace or external IdP — never a local password."
  type        = string
  default     = "ss-staff"
}

variable "workforce_provider_id" {
  description = "Provider ID inside the staff workforce pool (4-32 chars, [a-z0-9-])."
  type        = string
  default     = "ss-staff-oidc"
}

variable "workforce_oidc_issuer_uri" {
  description = "OIDC issuer URI for staff SSO. Empty default disables the staff pool until the IdP is chosen (Google Workspace / Okta)."
  type        = string
  default     = ""
}

variable "workforce_oidc_client_id" {
  description = "OIDC client ID for staff SSO."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Workload Identity Federation — GitHub Actions (D38)
# ---------------------------------------------------------------------------

variable "workload_pool_id" {
  description = "ID of the project-level Workload Identity Pool that GitHub Actions federates into (4-32 chars, [a-z0-9-]). Per D38 this replaces JSON service-account keys."
  type        = string
  default     = "ss-github-actions"
}

variable "github_repo_owner" {
  description = "GitHub repository owner (org or user) allowed to federate. Used in attribute_condition to lock down which repo can mint tokens."
  type        = string
  default     = "ComBba"
}

variable "github_repo_name" {
  description = "GitHub repository name allowed to federate (without owner prefix). e.g. \"social-seeding-v2\"."
  type        = string
  default     = "social-seeding-v2"
}

# ---------------------------------------------------------------------------
# DLP / Sensitive Data Protection (D20, D33)
# ---------------------------------------------------------------------------

variable "dlp_min_likelihood" {
  description = "Minimum DLP match likelihood that produces a finding. POSSIBLE catches more (some FP); LIKELY is stricter. We start at POSSIBLE because false positives are cheaper than a missed PII leak."
  type        = string
  default     = "POSSIBLE"
  validation {
    condition     = contains(["VERY_UNLIKELY", "UNLIKELY", "POSSIBLE", "LIKELY", "VERY_LIKELY"], var.dlp_min_likelihood)
    error_message = "dlp_min_likelihood must be one of VERY_UNLIKELY, UNLIKELY, POSSIBLE, LIKELY, VERY_LIKELY."
  }
}

variable "dlp_competitor_patterns" {
  description = "Brand/competitor regex patterns the DLP brand template flags. Treated as case-insensitive substrings via regex. Per D21 these become the Model Armor SDP advanced config inputs."
  type        = list(string)
  default = [
    "(?i)acme[- ]rival",
    "(?i)contoso[- ]inc",
    "(?i)widgetco",
  ]
}

# ---------------------------------------------------------------------------
# Model Armor (D21) — see ARMOR-GATEWAY.md §1.7 + §6
# ---------------------------------------------------------------------------

variable "model_armor_input_template_id" {
  description = "Template ID for the INPUT-side Model Armor policy (`ss-input` per ARMOR-GATEWAY.md §1.7)."
  type        = string
  default     = "ss-input"
}

variable "model_armor_output_template_id" {
  description = "Template ID for the OUTPUT-side Model Armor policy (`ss-output` per ARMOR-GATEWAY.md §1.7)."
  type        = string
  default     = "ss-output"
}

variable "model_armor_enforce" {
  description = "When false, both templates run in INSPECT_ONLY (audit-only) mode — useful during the audit-only → enforce ramp called out in D21. When true (default), input + output both enforce INSPECT_AND_BLOCK."
  type        = bool
  default     = true
}

variable "model_armor_fail_open" {
  description = "If the Model Armor service errors, fail-open (allow request) vs. fail-closed (block). Set true for demos to avoid availability impact; set false for regulated workloads. Per ARMOR-GATEWAY.md §2.3."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Binary Authorization (D37)
# ---------------------------------------------------------------------------

variable "binauthz_attestor_name" {
  description = "Name of the attestor that signs production images. The Cloud Build pipeline (see modules/devops) attaches an attestation referencing this attestor after a successful image scan + SLSA provenance check."
  type        = string
  default     = "ss-prod-attestor"
}

variable "binauthz_whitelist_patterns" {
  description = "Image name patterns that bypass attestation (Google distroless base images, GKE system pods). Keep this list small."
  type        = list(string)
  default = [
    "gcr.io/google-containers/*",
    "gcr.io/google_containers/*",
    "gcr.io/gke-release/*",
    "k8s.gcr.io/*",
    "registry.k8s.io/*",
    "gcr.io/distroless/*",
    "gcr.io/projectsigstore/*",
  ]
}

# ---------------------------------------------------------------------------
# Security Command Center + Chronicle SecOps (D21, D32)
# ---------------------------------------------------------------------------

variable "enable_scc_premium" {
  description = "Whether to provision the SCC Premium custom source. Premium tier must be activated at the org level out-of-band; this flag governs only the Terraform-owned source resource."
  type        = bool
  default     = true
}

variable "chronicle_export_dataset_id" {
  description = "BigQuery dataset (in this project) that receives the Cloud Audit Logs sink destined for Chronicle SecOps ingestion (D32). Per D33 the table-level expiration is 90 days."
  type        = string
  default     = "v2_chronicle_audit_export"
}

variable "audit_log_retention_days" {
  description = "Retention floor in days for audit logs exported to BigQuery for Chronicle (D33 = 90 days)."
  type        = number
  default     = 90
  validation {
    condition     = var.audit_log_retention_days >= 30
    error_message = "audit_log_retention_days must be at least 30 (PIPA Article 23 floor)."
  }
}
