# versions.tf — provider pinning for the data module.
#
# AlloyDB AI ScaNN auto-indexing surface and Memorystore Valkey 8 features still
# carry beta-only fields in places, so this module pins BOTH the GA google
# provider and the google-beta provider. Resources that touch beta-only
# attributes (AlloyDB instance, Memorystore Valkey, Vertex AI Index for Vector
# Search) explicitly set `provider = google-beta` in main.tf.
#
# Pinned to the latest 6.x line that has the Spanner multi-region GA
# `nam-eur-asia1` config, AlloyDB ScaNN preview, and Vertex AI dedicated index
# endpoint shape (verified against Context7 docs 2026-05-19).

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
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6.0"
    }
  }
}
