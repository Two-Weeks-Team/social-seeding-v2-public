# versions.tf — provider pinning for terraform/modules/integration
#
# Per D18 (Cloud Workflows + Pub/Sub + Cloud Tasks + Eventarc Advanced) and
# D28 (Apigee X monetization), this module needs:
#   - google: stable resources (pubsub, tasks, scheduler, workflows, apigee)
#   - google-beta: Eventarc Advanced bus + enrollments, Apigee API Hub,
#                  Pub/Sub Schema Registry (some still beta as of 2026-05).
#
# Both provider blocks are configured by the root module; do NOT inline
# credentials here.

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.10.0, < 7.0.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 6.10.0, < 7.0.0"
    }
  }
}
