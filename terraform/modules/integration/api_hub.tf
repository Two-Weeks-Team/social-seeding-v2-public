# api_hub.tf — Apigee API Hub catalog (D38).
#
# DEFERRED: hashicorp/google-beta v6.50 does not expose the Apigee API Hub
# resources (`google_apigee_api_hub_instance`, `google_apigee_api_hub_api`).
# Until the provider ships these, register specs out-of-band via
# `gcloud apigee apihub` or the Apigee Management API. See BN-11 + D38.
#
# Original intent (preserved here as the breadcrumb for restoration):
#
#   resource "google_apigee_api_hub_instance" "hub"       # Hub instance
#   resource "google_apigee_api_hub_api"      "shared_rest"   # specs/_common/shared.openapi.yaml
#   resource "google_apigee_api_hub_api"      "shared_async"  # specs/_common/shared.asyncapi.yaml
#
# To restore: revert this file from git and unstub `output "api_hub_*"` in
# outputs.tf (look for the "DEFERRED" markers). The original code lives at
# git-blame time pre-2026-05-19. Keep this file checked in so module callers
# see the deliberate stub and stable output contract.
