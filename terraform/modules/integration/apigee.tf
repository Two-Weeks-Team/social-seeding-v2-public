# apigee.tf — Apigee X organization + single instance + 3 API products
# for the per-view billing gateway (D28 + pricing/MODEL.md §4).
#
# Apigee X provisioning model:
#   1. google_apigee_organization     — global, one per GCP org tied via project.
#   2. google_apigee_instance         — regional runtime instance (the gateway plane).
#   3. google_apigee_envgroup         — hostname + TLS termination.
#   4. google_apigee_environment      — logical env (prod, staging) attached to instance.
#   5. google_apigee_envgroup_attachment — wires env to envgroup.
#   6. API products (per pricing tiers).
#
# Per pricing/MODEL.md §4.3:
#   - API product: `social-seeding-v2-per-view` ($0.01/view, the marketing line)
#   - Aggregation: per-tenant, per-billing-period (monthly).
#   - Notification rules: 50/75/90/100% of pre-paid commit (Growth, Enterprise).
#   - Tax handling: Stripe Tax / Toss KR VAT module.
#
# Open question O-S1 (SERVICE-INVENTORY.md:323): does Apigee X support
# `asia-northeast3`? As of 2026-05 the GA regions for Apigee X are
# us-*/europe-*/asia-east1/asia-southeast1/asia-northeast1. We default
# `analytics_region` + instance to `asia-northeast1` (Tokyo) to satisfy
# day-1, with var override available if Seoul becomes GA before deploy.

# ── Apigee organization (one per GCP org) ────────────────────────────────

resource "google_apigee_organization" "main" {
  count = var.apigee_config.enabled ? 1 : 0

  project_id          = var.project_id
  analytics_region    = var.apigee_config.analytics_region
  description         = var.apigee_config.organization_description
  runtime_type        = var.apigee_config.runtime_type
  billing_type        = var.apigee_config.billing_type
  authorized_network  = var.apigee_config.authorized_network != "" ? var.apigee_config.authorized_network : null
  disable_vpc_peering = var.apigee_config.disable_vpc_peering

  # Apigee X retention: 90d for analytics, matches D33 audit log lifecycle.
  retention = "MINIMUM"
}

# ── Apigee runtime instance (regional gateway plane) ─────────────────────

resource "google_apigee_instance" "primary" {
  count = var.apigee_config.enabled ? 1 : 0

  name                     = "ss-v2-${var.apigee_config.analytics_region}"
  location                 = var.apigee_config.analytics_region
  description              = "Per-view billing gateway primary instance (D28)."
  org_id                   = google_apigee_organization.main[0].id
  consumer_accept_list     = []
  peering_cidr_range       = "SLASH_22" # required even with VPC peering disabled
}

# ── Apigee environment ───────────────────────────────────────────────────

resource "google_apigee_environment" "prod" {
  count = var.apigee_config.enabled ? 1 : 0

  org_id       = google_apigee_organization.main[0].id
  name         = "prod"
  display_name = "Production"
  description  = "Per-view billing production env (D28)."
  type         = "BASE"
  # Apigee X environments support per-env API product attachment for the
  # monetization product (rate-plan resolution happens at runtime).
}

# Attach environment to runtime instance.
resource "google_apigee_instance_attachment" "prod_attach" {
  count = var.apigee_config.enabled ? 1 : 0

  instance_id = google_apigee_instance.primary[0].id
  environment = google_apigee_environment.prod[0].name
}

# ── Environment group (hostnames + TLS) ──────────────────────────────────

resource "google_apigee_envgroup" "billing_gateway" {
  count = var.apigee_config.enabled ? 1 : 0

  org_id    = google_apigee_organization.main[0].id
  name      = "billing-gateway"
  hostnames = ["api.social-seeding.example.com"]
}

resource "google_apigee_envgroup_attachment" "billing_prod" {
  count = var.apigee_config.enabled ? 1 : 0

  envgroup_id = google_apigee_envgroup.billing_gateway[0].id
  environment = google_apigee_environment.prod[0].name
}

# ── API products (3, per D28 + pricing/MODEL.md §5) ──────────────────────
#
# Apigee X API products carry the monetization rate plan attachment. Each
# product has:
#   - approval_type: "auto" for self-serve, "manual" for Enterprise.
#   - quota: usage quota per (interval, time_unit) — enforced by Apigee.
#   - operation_group: API operation set (we attach all *.socialseed.ing
#     surface routes; the per-view metering happens via Apigee analytics +
#     post-processing into BigQuery per pricing/MODEL.md §4.1).

resource "google_apigee_product" "products" {
  for_each = var.apigee_config.enabled ? local.apigee_api_products : {}

  org_id        = google_apigee_organization.main[0].id
  name          = each.key
  display_name  = each.value.display_name
  description   = each.value.description
  approval_type = each.value.approval_type
  quota         = each.value.quota
  quota_interval = each.value.quota_interval
  quota_time_unit = each.value.quota_time_unit

  environments = [google_apigee_environment.prod[0].name]

  # Bind to envgroup hostnames (Apigee runtime resolves products via
  # hostname + path + API key combination).
  operation_group {
    operation_configs {
      api_source = "remote-service" # API Hub-managed source
      operations {
        resource = "/v1/views/billable"
        methods  = ["POST"]
      }
      operations {
        resource = "/v1/campaigns"
        methods  = ["GET", "POST"]
      }
      operations {
        resource = "/v1/reports"
        methods  = ["GET"]
      }

      quota {
        limit    = each.value.quota
        interval = each.value.quota_interval
        time_unit = each.value.quota_time_unit
      }
    }
  }

  attributes {
    name  = "billing-rate-plan"
    value = each.key == "free-tier" ? "free" : each.key == "enterprise" ? "0.006-per-view" : "0.01-per-view"
  }
  attributes {
    name  = "billing-aggregation"
    value = "per-tenant-monthly"
  }
}
