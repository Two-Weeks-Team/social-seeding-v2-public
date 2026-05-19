# workstations.tf — cluster + 2 configs (D38)
#
# Config 1: ss-v2-engineer — humans. Persistent /home, e2-standard-8.
# Config 2: ss-v2-agent-worker — Tier-3 worker bots. No persistence, warm
#   pool of 2 because workers spawn often (PreviewForge pattern per D38).
# Both private (no public IP) and use the workstations runtime SA.

resource "google_workstations_cluster" "this" {
  provider = google-beta

  workstation_cluster_id = "ss-v2-dev-cluster"
  project                = var.project_id
  location               = var.primary_region

  network    = var.workstations_network
  subnetwork = var.workstations_subnetwork

  private_cluster_config {
    enable_private_endpoint = var.workstations_disable_public_ip
  }

  labels = local.common_labels

  depends_on = [google_project_service.this]
}

resource "google_workstations_workstation_config" "engineer" {
  provider = google-beta

  workstation_config_id  = "ss-v2-engineer"
  project                = var.project_id
  location               = var.primary_region
  workstation_cluster_id = google_workstations_cluster.this.workstation_cluster_id

  idle_timeout    = "${var.workstations_idle_timeout_seconds}s"
  running_timeout = "${var.workstations_running_timeout_seconds}s"

  host {
    gce_instance {
      machine_type                = var.workstations_engineer_machine_type
      boot_disk_size_gb           = 100
      service_account             = google_service_account.workstations.email
      disable_public_ip_addresses = var.workstations_disable_public_ip
      pool_size                   = 0

      shielded_instance_config {
        enable_secure_boot          = true
        enable_vtpm                 = true
        enable_integrity_monitoring = true
      }
    }
  }

  persistent_directories {
    mount_path = "/home"
    gce_pd {
      size_gb        = 200
      fs_type        = "ext4"
      disk_type      = "pd-balanced"
      reclaim_policy = "DELETE" # D33 lifecycle: dev leaves → home volume gone.
    }
  }

  container {
    image       = "us-central1-docker.pkg.dev/cloud-workstations-images/predefined/code-oss:latest"
    run_as_user = 1000
    env = {
      GCP_PROJECT    = var.project_id
      PRIMARY_REGION = var.primary_region
      EDITOR         = "codeoss"
    }
  }

  labels = merge(local.common_labels, { workstation_persona = "engineer" })

  depends_on = [google_workstations_cluster.this]
}

# Tier-3 worker — short-lived, aggressive idle, warm pool of 2.
resource "google_workstations_workstation_config" "agent_worker" {
  provider = google-beta

  workstation_config_id  = "ss-v2-agent-worker"
  project                = var.project_id
  location               = var.primary_region
  workstation_cluster_id = google_workstations_cluster.this.workstation_cluster_id

  idle_timeout    = "${floor(var.workstations_idle_timeout_seconds / 2)}s"
  running_timeout = "${var.workstations_running_timeout_seconds}s"

  host {
    gce_instance {
      machine_type                = var.workstations_agent_worker_machine_type
      boot_disk_size_gb           = 50
      service_account             = google_service_account.workstations.email
      disable_public_ip_addresses = var.workstations_disable_public_ip
      pool_size                   = 2

      shielded_instance_config {
        enable_secure_boot          = true
        enable_vtpm                 = true
        enable_integrity_monitoring = true
      }
    }
  }

  container {
    image       = "us-central1-docker.pkg.dev/cloud-workstations-images/predefined/code-oss:latest"
    run_as_user = 1000
    env = {
      GCP_PROJECT    = var.project_id
      PRIMARY_REGION = var.primary_region
      AGENT_WORKER   = "true"
      AGENT_TIER     = "3"
    }
  }

  labels = merge(local.common_labels, { workstation_persona = "agent-worker" })

  depends_on = [google_workstations_cluster.this]
}
