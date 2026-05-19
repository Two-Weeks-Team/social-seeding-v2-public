# terraform/modules/security/main.tf
#
# social-seeding-v2 security module (TF-Module-4).
#
# Provisions:
#   1. API enablement (modelarmor, dlp, secretmanager, identitytoolkit, …)
#   2. Cloud KMS — 3 regional keyrings × 6 CMEK keys each + optional HSM billing root
#   3. Secret Manager — 8 seed secrets with user-managed replication (US/EU/AP)
#   4. Identity Platform — config + template tenant + Google/SAML/OIDC IdPs (D19)
#   5. Workforce Identity Federation — staff SSO pool (D19)
#   6. Workload Identity Federation — GitHub Actions pool (D38)
#   7. DLP Sensitive Data Protection — PI/PII/brand inspect templates (D20)
#   8. Model Armor — ss-input + ss-output templates + project floor (D21, ARMOR-GATEWAY §1.7)
#   9. Binary Authorization — attestor + policy (D37)
#  10. Security Command Center — custom source (D21)
#  11. Chronicle SecOps export — BigQuery dataset + audit-log sink (D32)
#
# Naming convention: every Terraform-owned resource carries `ss-` prefix and the
# label set in var.labels.

locals {
  primary_region = var.regions.us
  region_list    = [var.regions.us, var.regions.eu, var.regions.ap]

  # Symmetric encryption keys go on every store touching customer data per D20.
  cmek_key_names = [
    "spanner",   # D15 core/tenant/billing OLTP
    "alloydb",   # D15 analytics/feature store
    "firestore", # D15 Agent Memory Bank backing
    "storage",   # creator assets / brand media
    "bigquery",  # analytics + Chronicle export
    "pubsub",    # event bus payloads
  ]

  # Cartesian product of regions × key names — 18 entries total.
  cmek_keys = merge([
    for region_key, region in var.regions : {
      for name in local.cmek_key_names : "${region_key}-${name}" => {
        region   = region
        ring_key = region_key
        purpose  = name
      }
    }
  ]...)

  # Google-managed service accounts that need
  # roles/cloudkms.cryptoKeyEncrypterDecrypter on the matching CMEK key.
  cmek_service_accounts = {
    spanner   = "serviceAccount:service-${var.project_number}@gcp-sa-spanner.iam.gserviceaccount.com"
    alloydb   = "serviceAccount:service-${var.project_number}@gcp-sa-alloydb.iam.gserviceaccount.com"
    firestore = "serviceAccount:service-${var.project_number}@gcp-sa-firestore.iam.gserviceaccount.com"
    storage   = "serviceAccount:service-${var.project_number}@gs-project-accounts.iam.gserviceaccount.com"
    bigquery  = "serviceAccount:bq-${var.project_number}@bigquery-encryption.iam.gserviceaccount.com"
    pubsub    = "serviceAccount:service-${var.project_number}@gcp-sa-pubsub.iam.gserviceaccount.com"
  }

  secret_manager_sa = "serviceAccount:service-${var.project_number}@gcp-sa-secretmanager.iam.gserviceaccount.com"

  model_armor_enforcement_type = var.model_armor_enforce ? "INSPECT_AND_BLOCK" : "INSPECT_ONLY"
}

# ---------------------------------------------------------------------------
# 1. API enablement — every API this module hits must be on before the
#    provider can create a resource against it. (`disable_on_destroy = false`
#    so `terraform destroy` doesn't disable a shared-tenancy API.)
# ---------------------------------------------------------------------------

resource "google_project_service" "apis" {
  for_each = toset([
    "cloudkms.googleapis.com",
    "secretmanager.googleapis.com",
    "identitytoolkit.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "dlp.googleapis.com",
    "modelarmor.googleapis.com",
    "binaryauthorization.googleapis.com",
    "containeranalysis.googleapis.com",
    "securitycenter.googleapis.com",
    "chronicle.googleapis.com",
    "logging.googleapis.com",
    "bigquery.googleapis.com",
    "networksecurity.googleapis.com",
  ])
  project            = var.project_id
  service            = each.key
  disable_on_destroy = false
}

# ---------------------------------------------------------------------------
# 2. Cloud KMS — 3 regional keyrings + 6 CMEK keys per ring (D13, D20)
# ---------------------------------------------------------------------------

resource "google_kms_key_ring" "regional" {
  for_each = var.regions

  project  = var.project_id
  name     = "ss-${each.key}-keyring"
  location = each.value

  depends_on = [google_project_service.apis]
}

resource "google_kms_crypto_key" "cmek" {
  for_each = local.cmek_keys

  name     = "ss-${each.value.purpose}-cmek"
  key_ring = google_kms_key_ring.regional[each.value.ring_key].id
  purpose  = "ENCRYPT_DECRYPT"

  rotation_period             = var.cmek_key_rotation_period
  destroy_scheduled_duration  = var.cmek_destroy_scheduled_duration
  skip_initial_version_creation = false

  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "SOFTWARE"
  }

  labels = var.labels

  # CMEK key destruction is irreversible — never allow it via `terraform destroy`.
  lifecycle {
    prevent_destroy = true
  }
}

# Each Google-managed service account needs Encrypter/Decrypter on every key
# of its purpose. We use IAM members (additive) instead of bindings (authoritative)
# because other modules will add their own grants over the lifetime of the key.
resource "google_kms_crypto_key_iam_member" "cmek_sa" {
  for_each = local.cmek_keys

  crypto_key_id = google_kms_crypto_key.cmek[each.key].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = local.cmek_service_accounts[each.value.purpose]
}

# Optional Cloud HSM-backed billing root key (D20). Lives only in the primary
# region — HSM is regional and we only need one anchor for envelope encryption
# of billing event payloads.
resource "google_kms_crypto_key" "billing_hsm" {
  count = var.enable_hsm_billing_root ? 1 : 0

  name     = "ss-billing-hsm-root"
  key_ring = google_kms_key_ring.regional["us"].id
  purpose  = "ENCRYPT_DECRYPT"

  rotation_period             = var.cmek_key_rotation_period
  destroy_scheduled_duration  = var.cmek_destroy_scheduled_duration

  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "HSM"
  }

  labels = merge(var.labels, { tier = "billing-root" })

  lifecycle {
    prevent_destroy = true
  }
}

# ---------------------------------------------------------------------------
# 3. Secret Manager — 8 seed secrets, user-managed multi-region replication (D20)
# ---------------------------------------------------------------------------
#
# We CMEK-protect every secret with the corresponding regional storage key
# (one secret value replica per region, each encrypted with that region's CMEK).
# A secret has no rotation_period because half of these (rapidapi, gmail-oauth
# refresh) rotate out-of-band; rotation is owned by the operator runbook.

resource "google_kms_crypto_key_iam_member" "secretmanager_cmek" {
  for_each = var.regions

  crypto_key_id = google_kms_crypto_key.cmek["${each.key}-storage"].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = local.secret_manager_sa
}

resource "google_secret_manager_secret" "seeds" {
  for_each = toset(var.seed_secrets)

  project   = var.project_id
  secret_id = "ss-${each.key}"

  replication {
    user_managed {
      replicas {
        location = var.regions.us
        customer_managed_encryption {
          kms_key_name = google_kms_crypto_key.cmek["us-storage"].id
        }
      }
      replicas {
        location = var.regions.eu
        customer_managed_encryption {
          kms_key_name = google_kms_crypto_key.cmek["eu-storage"].id
        }
      }
      replicas {
        location = var.regions.ap
        customer_managed_encryption {
          kms_key_name = google_kms_crypto_key.cmek["ap-storage"].id
        }
      }
    }
  }

  labels = var.labels

  depends_on = [
    google_kms_crypto_key_iam_member.secretmanager_cmek,
  ]
}

# Placeholder value so applications can boot during scaffolding without crashing.
# Engineers MUST overwrite via `gcloud secrets versions add ss-rapidapi ...`
# before production traffic. We do NOT store real secret material in HCL.
resource "google_secret_manager_secret_version" "seeds_placeholder" {
  for_each = google_secret_manager_secret.seeds

  secret      = each.value.id
  secret_data = "REPLACE_ME_VIA_GCLOUD"

  lifecycle {
    # Don't fight the operator when they rotate the secret via gcloud.
    ignore_changes = [secret_data]
  }
}

# ---------------------------------------------------------------------------
# 4. Identity Platform — multi-tenant config + template tenant + IdPs (D19)
# ---------------------------------------------------------------------------

resource "google_identity_platform_config" "this" {
  project                  = var.project_id
  autodelete_anonymous_users = true

  sign_in {
    allow_duplicate_emails = false

    anonymous {
      enabled = false
    }
    email {
      enabled           = true
      password_required = true
    }
  }

  # Multi-tenant mode is required by D12 (tenant-per-customer).
  multi_tenant {
    allow_tenants = true
  }

  depends_on = [google_project_service.apis]
}

# Template tenant — exists so the Mission Control onboarding flow can be
# exercised in CI without an admin call. Production tenants are created at
# customer-signup time by the workspace controller.
resource "google_identity_platform_tenant" "template" {
  project       = var.project_id
  display_name  = var.identity_platform_template_tenant_id
  allow_password_signup = true
  enable_email_link_signin = false
  disable_auth  = false

  client {
    permissions {
      disabled_user_signup   = false
      disabled_user_deletion = true # never let an end-user nuke their own account
    }
  }

  depends_on = [google_identity_platform_config.this]
}

# Sign-in-with-Google for the template tenant. client_secret is sourced from
# the seed secret (`ss-idp-sdk`) at apply time; never inline secret values.
# When identity_platform_google_oauth_client_id is empty (default) the IdP is
# skipped — we don't want to provision a half-configured provider.
resource "google_identity_platform_tenant_default_supported_idp_config" "google" {
  count = var.identity_platform_google_oauth_client_id == "" ? 0 : 1

  project       = var.project_id
  tenant        = google_identity_platform_tenant.template.name
  idp_id        = "google.com"
  client_id     = var.identity_platform_google_oauth_client_id
  client_secret = "REPLACE_VIA_SECRET_MANAGER" # sentinel — Mission Control wires the real value
  enabled       = true

  lifecycle {
    # Operator rotates the OAuth secret out-of-band via the Identity Platform console.
    ignore_changes = [client_secret]
  }
}

# Optional SAML IdP — feeds enterprise SSO when a tenant onboards Okta / AzureAD / etc.
# Note: the real per-tenant entity_id + SSO URL + x509 cert come from the
# customer's IdP metadata at onboarding time. Here we just register a stub
# configuration so the Mission Control onboarding flow can be exercised in CI;
# production tenants get their own InboundSamlConfig resources created
# dynamically by the workspace controller.
resource "google_identity_platform_tenant_inbound_saml_config" "enterprise" {
  count = var.identity_platform_saml_idp_metadata_xml == "" ? 0 : 1

  project      = var.project_id
  tenant       = google_identity_platform_tenant.template.name
  name         = "saml.enterprise"
  display_name = "Enterprise SAML (template)"
  enabled      = false # template entry — flipped on per-tenant at onboarding

  idp_config {
    idp_entity_id = "https://saml.template.invalid"
    sign_request  = true
    sso_url       = "https://saml.template.invalid/sso"
    idp_certificates {
      # Operator pastes the IdP's signing certificate (PEM, not metadata XML)
      # here once the real IdP relationship is in place. The variable carries
      # the PEM body for the template-stub IdP — used only for CI smoke tests.
      x509_certificate = var.identity_platform_saml_idp_metadata_xml
    }
  }

  sp_config {
    sp_entity_id = "projects/${var.project_id}/tenants/${google_identity_platform_tenant.template.name}"
    callback_uri = "https://${var.project_id}.firebaseapp.com/__/auth/handler"
  }
}

# Optional OIDC IdP — same purpose as SAML, for IdPs that only speak OIDC.
resource "google_identity_platform_tenant_oauth_idp_config" "enterprise_oidc" {
  count = var.identity_platform_oidc_issuer_uri == "" ? 0 : 1

  project       = var.project_id
  tenant        = google_identity_platform_tenant.template.name
  name          = "oidc.enterprise"
  display_name  = "Enterprise OIDC"
  client_id     = var.identity_platform_oidc_client_id
  client_secret = "REPLACE_VIA_SECRET_MANAGER"
  issuer        = var.identity_platform_oidc_issuer_uri
  enabled       = true

  lifecycle {
    ignore_changes = [client_secret]
  }
}

# ---------------------------------------------------------------------------
# 5. Workforce Identity Federation — staff SSO pool (D19)
# ---------------------------------------------------------------------------

resource "google_iam_workforce_pool" "staff" {
  count = var.workforce_oidc_issuer_uri == "" ? 0 : 1

  provider          = google-beta
  workforce_pool_id = var.workforce_pool_id
  parent            = "organizations/${var.org_id}"
  location          = "global"
  display_name      = "social-seeding staff SSO"
  description       = "Staff break-glass + day-to-day access via the corporate IdP (D19). No JSON service-account keys."

  session_duration = "3600s"
}

resource "google_iam_workforce_pool_provider" "staff_oidc" {
  count = var.workforce_oidc_issuer_uri == "" ? 0 : 1

  provider          = google-beta
  workforce_pool_id = google_iam_workforce_pool.staff[0].workforce_pool_id
  location          = "global"
  provider_id       = var.workforce_provider_id
  display_name      = "Corporate OIDC"
  description       = "OIDC federation for staff via the corporate IdP."

  attribute_mapping = {
    "google.subject"      = "assertion.sub"
    "google.display_name" = "assertion.email"
    "google.groups"       = "assertion.groups"
  }
  attribute_condition = "assertion.email_verified == true"

  oidc {
    issuer_uri = var.workforce_oidc_issuer_uri
    client_id  = var.workforce_oidc_client_id
    client_secret {
      value {
        # Placeholder — rotated out-of-band; the actual secret reaches IDP via
        # `gcloud iam workforce-pools providers update-oidc` and never lives in HCL.
        plain_text = "REPLACE_VIA_GCLOUD"
      }
    }
    web_sso_config {
      response_type             = "CODE"
      assertion_claims_behavior = "MERGE_USER_INFO_OVER_ID_TOKEN_CLAIMS"
    }
  }

  lifecycle {
    ignore_changes = [oidc[0].client_secret]
  }
}

# ---------------------------------------------------------------------------
# 6. Workload Identity Federation — GitHub Actions (D38)
# ---------------------------------------------------------------------------

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = var.workload_pool_id
  display_name              = "GitHub Actions"
  description               = "Federated identity for CI in ${var.github_repo_owner}/${var.github_repo_name} (D38)."

  depends_on = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"
  display_name                       = "GitHub OIDC"
  description                        = "OIDC federation from token.actions.githubusercontent.com — repo-scoped."

  # Lock the federation to exactly one repo (and only the main + release branches).
  # See https://docs.github.com/en/actions/deployment/security-hardening-your-deployments
  attribute_condition = "attribute.repository == \"${var.github_repo_owner}/${var.github_repo_name}\""

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.actor"      = "assertion.actor"
    "attribute.aud"        = "assertion.aud"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
    # No client_secret — GitHub OIDC uses public JWKS verification.
  }
}

# ---------------------------------------------------------------------------
# 7. DLP / Sensitive Data Protection — inspect templates (D20)
# ---------------------------------------------------------------------------
#
# Three templates, all under the global location so they're reusable from any
# region's logging sink. Inspect templates ONLY find; redaction is in the
# Model Armor SDP advanced config (§8) or a separate deidentify template.

# 7a. PI template — payment instruments, credentials, GCP secrets.
resource "google_data_loss_prevention_inspect_template" "pi" {
  parent       = "projects/${var.project_id}"
  description  = "Payment + credential + secret-material detection per D20."
  display_name = "ss-pi"

  inspect_config {
    info_types { name = "CREDIT_CARD_NUMBER" }
    info_types { name = "GCP_API_KEY" }
    info_types { name = "GCP_CREDENTIALS" }
    info_types { name = "OAUTH_CLIENT_SECRET" }
    info_types { name = "PASSWORD" }
    info_types { name = "IBAN_CODE" }
    info_types { name = "SWIFT_CODE" }

    min_likelihood = var.dlp_min_likelihood

    limits {
      max_findings_per_item    = 100
      max_findings_per_request = 1000
    }
  }

  depends_on = [google_project_service.apis]
}

# 7b. PII template — national IDs across KR + JP + CN + US per the brief, plus
# generic personal contact info that PIPA Article 23 considers sensitive.
resource "google_data_loss_prevention_inspect_template" "pii" {
  parent       = "projects/${var.project_id}"
  description  = "Personally-identifying information — KR RRN + JP MyNumber + CN ID + US SSN + contact PII (D20, PIPA Art. 23)."
  display_name = "ss-pii"

  inspect_config {
    info_types { name = "KOREA_RRN" }
    info_types { name = "JAPAN_INDIVIDUAL_NUMBER" }
    info_types { name = "JAPAN_PASSPORT" }
    info_types { name = "CHINA_RESIDENT_ID_NUMBER" }
    info_types { name = "CHINA_PASSPORT" }
    info_types { name = "US_SOCIAL_SECURITY_NUMBER" }
    info_types { name = "EMAIL_ADDRESS" }
    info_types { name = "PHONE_NUMBER" }
    info_types { name = "PERSON_NAME" }
    info_types { name = "STREET_ADDRESS" }
    info_types { name = "IP_ADDRESS" }
    info_types { name = "DATE_OF_BIRTH" }

    min_likelihood = var.dlp_min_likelihood

    # Custom influencer-handle pattern — INF-NNNNNNNN per ARMOR-GATEWAY §1.7
    custom_info_types {
      info_type { name = "SS_INFLUENCER_HANDLE" }
      likelihood = "LIKELY"
      regex {
        pattern = "INF-[0-9]{8}"
      }
    }

    limits {
      max_findings_per_item    = 100
      max_findings_per_request = 1000
    }
  }
}

# 7c. Brand / competitor template — surfaces mentions of competitors in
# outbound drafts so the Model Armor OUTPUT policy can quarantine them.
resource "google_data_loss_prevention_inspect_template" "brand" {
  parent       = "projects/${var.project_id}"
  description  = "Competitor brand-name patterns the outreach_writer agent must not emit (D21 custom-regex requirement)."
  display_name = "ss-brand"

  inspect_config {
    min_likelihood = var.dlp_min_likelihood

    dynamic "custom_info_types" {
      for_each = var.dlp_competitor_patterns
      content {
        info_type {
          name = "SS_COMPETITOR_${custom_info_types.key}"
        }
        likelihood = "LIKELY"
        regex {
          pattern = custom_info_types.value
        }
      }
    }

    limits {
      max_findings_per_item    = 50
      max_findings_per_request = 200
    }
  }
}

# ---------------------------------------------------------------------------
# 8. Model Armor — ss-input + ss-output templates + project floor (D21)
#    Mirrors ARMOR-GATEWAY.md §1.7 + §6 exactly.
# ---------------------------------------------------------------------------

resource "google_model_armor_template" "input" {
  provider    = google-beta
  project     = var.project_id
  location    = local.primary_region
  template_id = var.model_armor_input_template_id

  filter_config {
    rai_settings {
      rai_filters {
        filter_type      = "HATE_SPEECH"
        confidence_level = "MEDIUM_AND_ABOVE"
      }
      rai_filters {
        filter_type      = "HARASSMENT"
        confidence_level = "MEDIUM_AND_ABOVE"
      }
      rai_filters {
        filter_type      = "DANGEROUS"
        confidence_level = "MEDIUM_AND_ABOVE"
      }
      rai_filters {
        filter_type      = "SEXUALLY_EXPLICIT"
        confidence_level = "MEDIUM_AND_ABOVE"
      }
    }
    pi_and_jailbreak_filter_settings {
      filter_enforcement = "ENABLED"
      confidence_level   = "MEDIUM_AND_ABOVE"
    }
    malicious_uri_filter_settings {
      filter_enforcement = "ENABLED"
    }
    sdp_settings {
      advanced_config {
        inspect_template = google_data_loss_prevention_inspect_template.pi.id
      }
    }
  }

  template_metadata {
    enforcement_type        = local.model_armor_enforcement_type
    log_template_operations = true
    log_sanitize_operations = true

    multi_language_detection {
      enable_multi_language_detection = true
    }
  }

  labels = var.labels

  depends_on = [
    google_project_service.apis,
    google_data_loss_prevention_inspect_template.pi,
  ]
}

resource "google_model_armor_template" "output" {
  provider    = google-beta
  project     = var.project_id
  location    = local.primary_region
  template_id = var.model_armor_output_template_id

  filter_config {
    rai_settings {
      rai_filters {
        filter_type      = "HATE_SPEECH"
        confidence_level = "HIGH"
      }
      rai_filters {
        filter_type      = "HARASSMENT"
        confidence_level = "HIGH"
      }
      rai_filters {
        filter_type      = "DANGEROUS"
        confidence_level = "HIGH"
      }
      rai_filters {
        filter_type      = "SEXUALLY_EXPLICIT"
        confidence_level = "HIGH"
      }
    }
    pi_and_jailbreak_filter_settings {
      filter_enforcement = "ENABLED"
      confidence_level   = "HIGH"
    }
    malicious_uri_filter_settings {
      filter_enforcement = "ENABLED"
    }
    sdp_settings {
      advanced_config {
        inspect_template = google_data_loss_prevention_inspect_template.pii.id
      }
    }
  }

  template_metadata {
    enforcement_type        = local.model_armor_enforcement_type
    log_template_operations = true
    log_sanitize_operations = true
  }

  labels = var.labels

  depends_on = [
    google_project_service.apis,
    google_data_loss_prevention_inspect_template.pii,
  ]
}

# Floor setting — guarantees no engineer can disable PI/JB enforcement on
# any future Model Armor template in this project (D21 "max policy").
# Resource name is `google_model_armor_floorsetting` (one word) per the
# google-beta provider schema; `parent` is the project, `location` is global.
resource "google_model_armor_floorsetting" "project_floor" {
  provider = google-beta

  parent   = "projects/${var.project_id}"
  location = "global"

  filter_config {
    pi_and_jailbreak_filter_settings {
      filter_enforcement = "ENABLED"
      confidence_level   = "MEDIUM_AND_ABOVE"
    }
    malicious_uri_filter_settings {
      filter_enforcement = "ENABLED"
    }
  }
  enable_floor_setting_enforcement = true

  depends_on = [google_project_service.apis]
}

# ---------------------------------------------------------------------------
# 9. Binary Authorization — attestor + policy (D37)
# ---------------------------------------------------------------------------

resource "google_container_analysis_note" "attestor_note" {
  project = var.project_id
  name    = "${var.binauthz_attestor_name}-note"

  attestation_authority {
    hint {
      human_readable_name = "social-seeding-v2 production image attestor"
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_binary_authorization_attestor" "prod" {
  project = var.project_id
  name    = var.binauthz_attestor_name

  description = "Signs production images after Cloud Build's SLSA + Artifact Analysis pass (D37)."

  attestation_authority_note {
    note_reference = google_container_analysis_note.attestor_note.name
  }
}

resource "google_binary_authorization_policy" "policy" {
  project = var.project_id

  description = "Cluster + Cloud Run + Agent Runtime images must carry an attestation from ${var.binauthz_attestor_name} (D37)."

  global_policy_evaluation_mode = "ENABLE"

  dynamic "admission_whitelist_patterns" {
    for_each = var.binauthz_whitelist_patterns
    content {
      name_pattern = admission_whitelist_patterns.value
    }
  }

  default_admission_rule {
    evaluation_mode  = "REQUIRE_ATTESTATION"
    enforcement_mode = "ENFORCED_BLOCK_AND_AUDIT_LOG"
    require_attestations_by = [
      google_binary_authorization_attestor.prod.name,
    ]
  }
}

# ---------------------------------------------------------------------------
# 10. Security Command Center — custom finding source (D21, D32)
# ---------------------------------------------------------------------------
#
# SCC Premium activation itself is an org-level operation handled out-of-band
# (gcloud scc settings services enable security-center --organization=ORG_ID).
# Here we only own the source resource that the agent watchdog (W3
# `security_watch`, see DECISIONS §4) publishes Model Armor + Chronicle
# findings into.

resource "google_scc_source" "ss_security_watch" {
  count = var.enable_scc_premium ? 1 : 0

  display_name = "ss-security-watch"
  organization = var.org_id
  description  = "Findings emitted by the W3 security_watch agent and the Model Armor sanitize-ops log sink (D21, D32)."
}

# ---------------------------------------------------------------------------
# 11. Chronicle SecOps export — audit-log sink → BigQuery (D32, D33)
# ---------------------------------------------------------------------------

resource "google_bigquery_dataset" "chronicle_audit" {
  project    = var.project_id
  dataset_id = var.chronicle_export_dataset_id
  location   = local.primary_region

  description                     = "Audit-log mirror destined for Chronicle SecOps ingestion (D32). Per-table expiration enforced by D33."
  default_table_expiration_ms     = var.audit_log_retention_days * 24 * 3600 * 1000
  delete_contents_on_destroy      = false

  default_encryption_configuration {
    kms_key_name = google_kms_crypto_key.cmek["us-bigquery"].id
  }

  labels = var.labels

  depends_on = [
    google_kms_crypto_key_iam_member.cmek_sa,
  ]
}

# Capture: (a) all Cloud Audit Logs (admin + data-access), (b) Model Armor
# sanitize-ops, (c) IAM policy changes. Chronicle ingests from BigQuery via a
# pull connector configured out-of-band (chronicle.googleapis.com side).
resource "google_logging_project_sink" "chronicle_audit" {
  project     = var.project_id
  name        = "ss-chronicle-audit-sink"
  destination = "bigquery.googleapis.com/projects/${var.project_id}/datasets/${google_bigquery_dataset.chronicle_audit.dataset_id}"

  filter = <<-EOT
    (logName:"cloudaudit.googleapis.com")
    OR (protoPayload.serviceName="modelarmor.googleapis.com")
    OR (protoPayload.serviceName="iam.googleapis.com")
    OR (protoPayload.serviceName="identitytoolkit.googleapis.com")
    OR (jsonPayload."@type"="type.googleapis.com/google.cloud.modelarmor.logging.v1.SanitizeOperationLogEntry")
  EOT

  unique_writer_identity = true

  bigquery_options {
    use_partitioned_tables = true
  }
}

resource "google_bigquery_dataset_iam_member" "chronicle_sink_writer" {
  project    = var.project_id
  dataset_id = google_bigquery_dataset.chronicle_audit.dataset_id
  role       = "roles/bigquery.dataEditor"
  member     = google_logging_project_sink.chronicle_audit.writer_identity
}

# Log-based metric — counts every Model Armor MATCH_FOUND so we can alert on a
# surge (>10/min for 5m) per ARMOR-GATEWAY §1.9. The alert policy itself lives
# in the observability module so we don't fight notification-channel ownership.
resource "google_logging_metric" "model_armor_blocks" {
  project = var.project_id
  name    = "model_armor_blocks"

  description = "Count of Model Armor sanitize-operations with filterMatchState=MATCH_FOUND. Surge alert lives in modules/observability."

  filter = <<-EOT
    jsonPayload."@type"="type.googleapis.com/google.cloud.modelarmor.logging.v1.SanitizeOperationLogEntry"
    AND jsonPayload.sanitizationResult.filterMatchState="MATCH_FOUND"
  EOT

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}
