# outputs.tf — compute module
#
# Downstream modules (networking/, observability/, integration/) read these.
# Cites D13 (regions), D17 (Agent Runtime), D26 (Mission Control), D23 (GKE Autopilot).

output "regions" {
  description = "The regions this module provisioned compute in (echo of var.regions, useful for downstream for_each)."
  value       = var.regions
}

output "mission_control_service_urls" {
  description = "Map of region → fully-qualified Cloud Run service URL for the Mission Control SSR adapter (D26). Consumed by the Global LB module + the Apigee X $0.01/view billing pipeline (D28)."
  value       = { for r, s in google_cloud_run_v2_service.mission_control : r => s.uri }
}

output "mission_control_service_names" {
  description = "Map of region → Cloud Run service name (without project/location). Useful for IAM binding from peer modules."
  value       = { for r, s in google_cloud_run_v2_service.mission_control : r => s.name }
}

output "mission_control_latest_ready_revisions" {
  description = "Map of region → latest ready revision; let CD validate post-deploy."
  value       = { for r, s in google_cloud_run_v2_service.mission_control : r => s.latest_ready_revision }
}

output "job_names" {
  description = "Map of region → Cloud Run Job name for eval/sim/scan jobs (D37). Cloud Scheduler + Workflows callers reference these (COMPUTE.md §2)."
  value       = { for r, j in google_cloud_run_v2_job.eval : r => j.name }
}

output "worker_pool_names" {
  description = "Map of region → Cloud Run worker pool name (D18 Pub/Sub fan-out). The integration/ module wires Pub/Sub subscriptions to these."
  value       = { for r, w in google_cloud_run_v2_worker_pool.fanout : r => w.name }
}

output "agent_runtime_endpoints" {
  description = <<-EOT
    Map of "<region>-<index>" → Vertex AI Agent Runtime resource name (D17).
    Provider 6.50 does not expose `google_vertex_ai_reasoning_engine`, so the
    value is `fallback:<region>-<index>` — callers must resolve the real
    resource path via `gcloud beta ai reasoning-engines list` until the
    native resource ships. See BN-11 + the breadcrumb in main.tf for the
    restore path.
  EOT
  value = {
    for k, _ in null_resource.agent_runtime_fallback : k => "fallback:${k}"
  }
}

output "agent_runtime_display_names" {
  description = "Map of \"<region>-<index>\" → Agent Runtime display name. Useful for log/alert correlation. Empty until the native resource ships (see BN-11)."
  value       = {}
}

output "gke_cluster_names" {
  description = "Map of region → GKE Autopilot cluster name (D23). Empty if gke_autopilot_enabled = false. Consumed by observability/ for fleet metrics + by the Veo/Imagen creative agent deploy pipeline."
  value       = { for r, c in google_container_cluster.autopilot : r => c.name }
}

output "gke_cluster_endpoints" {
  description = "Map of region → GKE Autopilot control-plane endpoint. Sensitive — only used by CD."
  value       = { for r, c in google_container_cluster.autopilot : r => c.endpoint }
  sensitive   = true
}

output "gke_cluster_ca_certificates" {
  description = "Map of region → GKE cluster CA certificate (base64). Sensitive; consumers should pipe into kubeconfig."
  value       = { for r, c in google_container_cluster.autopilot : r => c.master_auth[0].cluster_ca_certificate }
  sensitive   = true
}

output "gke_workload_identity_pool" {
  description = "The Workload Identity pool string used for SA impersonation from GKE pods (`<project>.svc.id.goog`). All Autopilot clusters in this module share it."
  value       = local.workload_identity_pool
}

output "gke_gpu_accelerator" {
  description = "Echo of var.gke_gpu_accelerator — Pods needing GPUs must set `nodeSelector.cloud.google.com/gke-accelerator` to the per-region value here."
  value       = var.gke_gpu_accelerator
}

output "labels" {
  description = "The label set applied to every resource in this module (managed_by + d_id + caller-provided)."
  value       = local.base_labels
}

output "service_account_runtime" {
  description = "Echo of the runtime SA email — downstream IAM modules use this to grant invoker / data-access roles."
  value       = var.service_account_runtime
}
