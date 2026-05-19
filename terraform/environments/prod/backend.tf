# =============================================================================
# backend.tf — prod environment Terraform state backend
#
# Decision anchors:
#   - D44 (root config lives in environments/<env>/; isolated state per env).
#   - D13 (3-region active-active — state bucket itself is single multi-region
#     because GCS multi-region is already 99.999999999% durability across the
#     same continent group).
#
# Bucket assumptions:
#   - Bucket `ss-v2-tf-state-prod` is pre-created by `_scripts/day-1-setup.sh`
#     against the prod project. Operator runs this before the first
#     `terraform init`. See environments/README.md §Bootstrap.
#   - Object Versioning ON, Bucket Lock 30 d (prevents accidental overwrite of
#     a prod state revision during a rollback).
#   - IAM: only the `terraform-prod` service account + a small break-glass
#     human group has roles/storage.objectAdmin.
#
# Manual locking notes:
#   - GCS backend uses native locking via `storage.googleapis.com` object
#     metadata since Terraform 0.13+ — no extra DB needed.
# =============================================================================

terraform {
  backend "gcs" {
    bucket = "ss-v2-tf-state-prod"
    prefix = "terraform/state/prod"
  }
}
