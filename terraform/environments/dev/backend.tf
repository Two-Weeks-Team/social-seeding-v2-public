# =============================================================================
# backend.tf — dev environment Terraform state backend
#
# Decision anchor: D44 (root config lives in environments/<env>/; per-env state
# bucket keeps dev and prod fully isolated).
#
# Bucket assumptions:
#   - Bucket `ss-v2-tf-state-dev` is pre-created by `_scripts/day-1-setup.sh`
#     (operator-run W5 prerequisite). Terraform itself cannot bootstrap its own
#     state bucket — chicken-and-egg, see environments/README.md §Bootstrap.
#   - Bucket has Object Versioning enabled (recover prior state).
#   - Bucket is in US multi-region (low latency from us-central1 dev primary).
#
# Re-init notes:
#   - Changing prefix => run `terraform init -migrate-state` once.
#   - Bucket name is intentionally NOT parameterized — `backend` block does not
#     accept variables; if it must change, edit this file + re-init.
# =============================================================================

terraform {
  backend "gcs" {
    bucket = "ss-v2-tf-state-dev"
    prefix = "terraform/state/dev"
  }
}
