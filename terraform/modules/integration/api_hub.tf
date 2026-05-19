# api_hub.tf — Apigee API Hub catalog (D38).
#
# SERVICE-INVENTORY.md §8 line 222 lists API Hub as the OpenAPI + MCP spec
# catalog. Per the gcp-research/specs/ layout, the canonical specs are:
#   - specs/_common/shared.openapi.yaml   (REST surface)
#   - specs/_common/shared.asyncapi.yaml  (event surface; this module reads it)
#   - specs/<agent>/openapi.yaml          (per-agent overlays)
#
# API Hub stores spec versions as `google_apigee_api_hub_api` + nested
# version + spec resources. We register the two _common specs at module
# deploy time; per-agent overlays are registered by their owning module
# (ai/compute) so per-agent ownership stays local.
#
# google-beta is required as API Hub is currently a beta resource.

resource "google_apigee_api_hub_instance" "hub" {
  provider = google-beta
  count    = var.api_hub_config.enabled ? 1 : 0

  project_id   = var.project_id
  location     = var.api_hub_config.region
  display_name = var.api_hub_config.display_name
  description  = "Spec catalog for D28 monetization gateway + agent surfaces (D38)."

  config {
    cmek_key_name        = var.cmek_key_id
    disable_search       = false
    encryption_type      = "CUSTOMER_MANAGED_ENCRYPTION"
  }

  labels = local.labels
}

# ── Catalog: shared.openapi.yaml ─────────────────────────────────────────

resource "google_apigee_api_hub_api" "shared_rest" {
  provider = google-beta
  count    = var.api_hub_config.enabled ? 1 : 0

  api_id   = "shared-rest"
  location = var.api_hub_config.region
  project  = var.project_id

  display_name = "Shared REST surface (OpenAPI 3.1)"
  description  = "Per D26: Mission Control + chatbot + mobile share this surface. Codegen target for OpenAPI 3.1 client SDK."

  documentation {
    external_uri = "https://github.com/social-seeding/v2/blob/main/gcp-research/specs/_common/shared.openapi.yaml"
  }

  target_user {
    description = "Internal: Mission Control + Dialogflow CX + mobile PWA."
  }

  team {
    description = "Platform team — Track 2."
  }

  business_unit {
    description = "Social Seeding v2."
  }

  maturity_level     = "PREVIEW"
  api_style          = "REST"
  attributes {
    attribute  = "projects/${var.project_id}/locations/${var.api_hub_config.region}/attributes/system-api-managed-by"
    value_type = "ENUM"
    enum_values {
      values {
        id          = "terraform"
        display_name = "Terraform-managed"
        description = "Lifecycle controlled by terraform/modules/integration."
      }
    }
  }
}

# ── Catalog: shared.asyncapi.yaml ────────────────────────────────────────

resource "google_apigee_api_hub_api" "shared_async" {
  provider = google-beta
  count    = var.api_hub_config.enabled ? 1 : 0

  api_id   = "shared-async"
  location = var.api_hub_config.region
  project  = var.project_id

  display_name = "Shared Async surface (AsyncAPI 3.0 → Pub/Sub schemas)"
  description  = "D18 event bus. Source of truth for the 15 Pub/Sub topics + 5 Avro schemas."

  documentation {
    external_uri = "https://github.com/social-seeding/v2/blob/main/gcp-research/specs/_common/shared.asyncapi.yaml"
  }

  target_user {
    description = "Internal agents + Apigee per-view billing meter producer."
  }

  maturity_level = "PREVIEW"
  api_style      = "ASYNC_API"

  depends_on = [google_apigee_api_hub_instance.hub]
}
