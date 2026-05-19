# examples/basic — minimal single-region dev invocation.
#
# Demonstrates how to wire the data module against pre-existing networking and
# security modules. Single region (us-central1) keeps the surface small for
# `terraform plan` smoke tests; production callers pass all 3 regions
# (D13 global active-active).
#
# Usage:
#   cd terraform/modules/data/examples/basic
#   export TF_VAR_project_id=ss-v2-dev
#   terraform init
#   terraform plan

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.20.0, < 7.0.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 6.20.0, < 7.0.0"
    }
  }
}

variable "project_id" {
  type = string
}

provider "google" {
  project = var.project_id
}

provider "google-beta" {
  project = var.project_id
}

# These would normally come from the security + networking modules. Inlined
# here to keep the example self-contained.
data "google_compute_network" "primary" {
  name = "ss-v2-us-central1"
}

data "google_kms_crypto_key" "us_central1" {
  name     = "ss-v2-data"
  key_ring = "projects/${var.project_id}/locations/us-central1/keyRings/ss-v2"
}

data "google_kms_crypto_key" "multi_region" {
  name     = "ss-v2-data-mr"
  key_ring = "projects/${var.project_id}/locations/nam-eur-asia1/keyRings/ss-v2-mr"
}

module "data" {
  source = "../.."

  project_id  = var.project_id
  name_prefix = "ss-v2"
  environment = "dev"

  regions = {
    us-central1 = {
      location             = "us-central1"
      firestore_location   = "nam5"
      alloydb_cpu_count    = 2
      alloydb_replica_cpu  = 2
      valkey_shard_count   = 1
      valkey_replica_count = 0
      valkey_node_type     = "SHARED_CORE_NANO"
    }
  }

  cmek_keys = {
    us-central1  = data.google_kms_crypto_key.us_central1.id
    multi_region = data.google_kms_crypto_key.multi_region.id
  }

  vpc_networks = {
    us-central1 = data.google_compute_network.primary.self_link
  }

  spanner_config = {
    instance_config  = "regional-us-central1" # dev: single-region Spanner to save cost
    processing_units = 100
    edition          = "STANDARD"
  }

  alloydb_initial_password_secret = "alloydb-bootstrap"

  lifecycle_days = {
    pii_assets_retention      = 30
    audit_archive_retention   = 90
    memory_bank_ttl           = 14
    bigquery_partition_expire = 90
    storage_nearline_at       = 30
    storage_archive_at        = 60
  }

  labels = {
    managed-by  = "terraform"
    module      = "data"
    decision    = "d15-d16-d33"
    cost-center = "agent-platform"
  }
}

output "spanner_core_db" {
  value = module.data.spanner_core_database
}

output "vector_endpoints" {
  value = module.data.vector_endpoint_resource_names
}

output "alloydb_jdbc" {
  value     = module.data.alloydb_jdbc_urls
  sensitive = true
}
