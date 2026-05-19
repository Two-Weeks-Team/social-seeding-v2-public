# binary_auth.tf — SLSA L3 attestor + REQUIRE_ATTESTATION policy
#
# D37 — Cloud Deploy only promotes images whose digest carries a valid
# attestation signed by `ss-v2-build-attestor`. This is the GCP-native fix
# for the workspace CLAUDE.md "Watchtower-on-:latest" landmine (per DEVOPS
# §A.3 + §E.1).

resource "google_kms_key_ring" "binauthz" {
  name     = "ss-v2-binauthz"
  project  = var.project_id
  location = var.primary_region

  depends_on = [google_project_service.this]
}

resource "google_kms_crypto_key" "attestor" {
  name     = "attestor"
  key_ring = google_kms_key_ring.binauthz.id
  purpose  = "ASYMMETRIC_SIGN"

  version_template {
    algorithm        = "EC_SIGN_P256_SHA256"
    protection_level = "SOFTWARE"
  }

  # Policy continues to reference this key after a state rebuild. Manual rotate.
  lifecycle {
    prevent_destroy = true
  }
}

resource "google_container_analysis_note" "build_attestation" {
  name    = "ss-v2-build-attestation-note"
  project = var.project_id

  attestation_authority {
    hint {
      human_readable_name = "social-seeding-v2 Cloud Build SLSA L3 attestor"
    }
  }

  depends_on = [google_project_service.this]
}

data "google_kms_crypto_key_version" "attestor" {
  crypto_key = google_kms_crypto_key.attestor.id
  version    = 1

  depends_on = [google_kms_crypto_key.attestor]
}

resource "google_binary_authorization_attestor" "build" {
  name        = "ss-v2-build-attestor"
  project     = var.project_id
  description = "Signs images that passed MATRIX §7.1 stages 1-6 (D37 / SLSA L3)."

  attestation_authority_note {
    note_reference = google_container_analysis_note.build_attestation.name

    public_keys {
      id = data.google_kms_crypto_key_version.attestor.id

      pkix_public_key {
        public_key_pem      = data.google_kms_crypto_key_version.attestor.public_key[0].pem
        signature_algorithm = "ECDSA_P256_SHA256"
      }
    }
  }
}

resource "google_kms_crypto_key_iam_member" "build_signer" {
  crypto_key_id = google_kms_crypto_key.attestor.id
  role          = "roles/cloudkms.signerVerifier"
  member        = "serviceAccount:${google_service_account.cloud_build.email}"
}

resource "google_binary_authorization_attestor_iam_member" "build_attester" {
  project  = var.project_id
  attestor = google_binary_authorization_attestor.build.name
  role     = "roles/binaryauthorization.attestorsEditor"
  member   = "serviceAccount:${google_service_account.cloud_build.email}"
}

resource "google_binary_authorization_attestor_iam_member" "deploy_verifier" {
  project  = var.project_id
  attestor = google_binary_authorization_attestor.build.name
  role     = "roles/binaryauthorization.attestorsVerifier"
  member   = "serviceAccount:${google_service_account.cloud_deploy.email}"
}

# Project-wide REQUIRE_ATTESTATION. Caveats documented in README.
resource "google_binary_authorization_policy" "policy" {
  project = var.project_id

  default_admission_rule {
    evaluation_mode  = "REQUIRE_ATTESTATION"
    enforcement_mode = "ENFORCED_BLOCK_AND_AUDIT_LOG"

    require_attestations_by = [
      google_binary_authorization_attestor.build.name,
    ]
  }

  # Google-managed system images we cannot re-attest.
  admission_whitelist_patterns {
    name_pattern = "gcr.io/google.com/cloudsdktool/cloud-sdk*"
  }
  admission_whitelist_patterns {
    name_pattern = "gcr.io/k8s-skaffold/pack*"
  }
  admission_whitelist_patterns {
    name_pattern = "gcr.io/google-cloud-build/*"
  }

  global_policy_evaluation_mode = "ENABLE"
}
