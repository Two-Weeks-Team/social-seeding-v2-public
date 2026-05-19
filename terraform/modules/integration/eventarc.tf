# eventarc.tf — Eventarc Advanced bus + 8 enrollments (D18).
#
# Eventarc Advanced (vs the original Eventarc) gives us:
#   1. A "Message Bus" resource we own (not Google's managed bus).
#   2. Content-based routing via CEL on CloudEvent attributes.
#   3. Transformation pipelines (we don't use them yet — Phase 2).
#   4. Multi-pipeline fan-out without re-deploying triggers.
#
# Per SERVICE-INVENTORY.md §8 + INNGEST-MIGRATION §2 row 2/3:
#   - Filters operate on CloudEvent ATTRIBUTES (`message.attributes.*`),
#     not payload bodies. Payload-field correlation moves to the Cloud Run
#     callback-router service.
#   - Eventarc trigger delivery is at-least-once → workflow executions
#     deduplicate via deterministic executionId (`${parentId}:${childKey}`).
#
# google-beta is required as of provider 6.10 for Advanced bus resources.

# ── Eventarc Advanced bus ────────────────────────────────────────────────

resource "google_eventarc_message_bus" "main" {
  provider       = google-beta
  message_bus_id = "ss-v2-bus"
  location       = var.primary_region
  project        = var.project_id
  display_name   = "Social Seeding v2 system bus (D18)"
  logging_config {
    log_severity = "INFO"
  }
  labels = local.labels
}

# ── Eventarc pipelines (1 per enrollment that targets a Workflow) ────────
#
# Pipelines define the destination + transformation. Each pipeline binds to
# one or more enrollments. For workflow destinations the pipeline carries
# the workflow URI; for Cloud Run destinations (callback-router, cancel
# service) the pipeline carries the service URL injected by the compute
# module (we leave those pipelines as imported / managed elsewhere — this
# module ONLY owns the workflow-destination pipelines).

resource "google_eventarc_pipeline" "workflow_destinations" {
  provider = google-beta
  for_each = {
    for k, v in local.eventarc_enrollments :
    k => v
    if v.destination_workflow != ""
  }

  pipeline_id  = "pipe-${each.key}"
  location     = var.primary_region
  project      = var.project_id
  display_name = "Pipeline → ${each.value.destination_workflow}"
  labels       = local.labels

  destinations {
    workflow = "projects/${var.project_id}/locations/${var.primary_region}/workflows/${each.value.destination_workflow}"

    authentication_config {
      google_oidc {
        service_account = var.workflows_invoker_sa_email
      }
    }
  }

  retry_policy {
    max_attempts    = 5
    min_retry_delay = "10s"
    max_retry_delay = "600s"
  }

  logging_config {
    log_severity = "INFO"
  }

  depends_on = [
    google_workflows_workflow.workflows,
    google_eventarc_message_bus.main,
  ]
}

# ── Eventarc enrollments (8) ─────────────────────────────────────────────
#
# An enrollment binds a CEL match against the bus → a pipeline. Multiple
# enrollments per pipeline are legal (same workflow can be triggered by
# different filtered subsets of bus events).

resource "google_eventarc_enrollment" "enrollments" {
  provider = google-beta
  for_each = local.eventarc_enrollments

  enrollment_id = each.key
  location      = var.primary_region
  project       = var.project_id
  display_name  = each.value.description

  message_bus = google_eventarc_message_bus.main.id

  cel_match = each.value.cel_match

  # Pipeline destination: workflow-bound enrollments target the matching
  # pipeline; Cloud Run-bound enrollments are owned by the compute module
  # (we keep this module focused on workflow-destination wiring).
  destination = each.value.destination_workflow != "" ? google_eventarc_pipeline.workflow_destinations[each.key].id : ""

  labels = local.labels
}

# ── Pub/Sub → Eventarc forwarders ────────────────────────────────────────
#
# Eventarc Advanced does NOT auto-subscribe to Pub/Sub topics — we wire
# each topic via a dedicated push subscription that posts CloudEvents to
# the bus's HTTP ingest URL.
#
# (Google's docs recommend a single forwarder Cloud Run service that
# normalizes Pub/Sub messages into CloudEvents. We expose the bus ingest
# URL as an output and let the compute module deploy the forwarder.)

# ── IAM: who can publish to the bus ──────────────────────────────────────
#
# DEFERRED: hashicorp/google-beta v6.50 does not yet expose
# `google_eventarc_message_bus_iam_member` / `_iam_binding` / `_iam_policy`.
# Until the provider ships these resources, the IAM grant is applied via a
# `null_resource` shim calling `gcloud eventarc message-buses
# add-iam-policy-binding`. This preserves the original bus-scoped grant
# (instead of widening to project-level publisher, which would over-grant).
# See BN-11 + D18. When the IAM resources land, restore the native form via
# `moved` blocks.

resource "null_resource" "message_bus_publisher_iam" {
  triggers = {
    project        = var.project_id
    location       = var.primary_region
    message_bus_id = google_eventarc_message_bus.main.message_bus_id
    member         = "serviceAccount:${var.pubsub_publisher_sa_email}"
    role           = "roles/eventarc.publisher"
    d_id           = "D18"
  }

  provisioner "local-exec" {
    when    = create
    command = <<-EOT
      gcloud eventarc message-buses add-iam-policy-binding ${self.triggers.message_bus_id} \
        --location=${self.triggers.location} \
        --project=${self.triggers.project} \
        --member=${self.triggers.member} \
        --role=${self.triggers.role}
    EOT
  }

  provisioner "local-exec" {
    when    = destroy
    command = <<-EOT
      gcloud eventarc message-buses remove-iam-policy-binding ${self.triggers.message_bus_id} \
        --location=${self.triggers.location} \
        --project=${self.triggers.project} \
        --member=${self.triggers.member} \
        --role=${self.triggers.role} || true
    EOT
  }

  depends_on = [google_eventarc_message_bus.main]
}
