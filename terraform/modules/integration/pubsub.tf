# pubsub.tf — 15 canonical Pub/Sub topics + 5 schemas + subscriptions + DLQs.
#
# D18 makes Pub/Sub the system event bus. The 15 topics below are the
# day-1-setup.sh:254-270 inventory verbatim — naming convention is the
# authoritative contract surface (changing a topic name is a coordinated
# break across producers + Eventarc enrollments + downstream subscribers).
#
# CMEK (D20) is applied on every topic. Where AsyncAPI defines a wire
# schema (shared.asyncapi.yaml lines 113-203), we attach it via
# `schema_settings`. Producers fail-publish on schema-incompatible payloads
# — the registry is the enforcement point.
#
# Each topic gets:
#   1. The topic itself.
#   2. A dead-letter topic named "${topic}.dlq".
#   3. A default pull subscription named "${topic}.sub" (consumer scaffolding;
#      the actual subscribers are Cloud Run services + Eventarc enrollments).
#   4. The "campaign.submitted" topic also gets its Eventarc-style attribute
#      filter via subscription `filter` (the Eventarc enrollment is in
#      eventarc.tf — Pub/Sub subscriptions support attribute-level filtering
#      independently per D18 fan-out semantics).

# ── Schemas (5) ──────────────────────────────────────────────────────────

resource "google_pubsub_schema" "schemas" {
  for_each = local.pubsub_schemas

  name       = "${each.key}-v1"
  type       = "AVRO"
  definition = file("${path.module}/${each.value}")
  project    = var.project_id
}

# ── Topics (15) ──────────────────────────────────────────────────────────

resource "google_pubsub_topic" "topics" {
  for_each = local.pubsub_topics

  name                       = each.key
  project                    = var.project_id
  message_retention_duration = var.message_retention_duration
  labels                     = local.labels

  # CMEK per D20 (Cloud KMS ring provisioned by security module).
  kms_key_name = var.cmek_key_id

  # Attach schema where AsyncAPI defines one (5 of 15 topics).
  dynamic "schema_settings" {
    for_each = each.value.schema_key != null ? [each.value.schema_key] : []
    content {
      schema   = google_pubsub_schema.schemas[schema_settings.value].id
      encoding = "JSON"
    }
  }

  # Topics are global. Optional message_storage_policy below restricts data
  # residency to the primary region for PIPA compliance (D22). The list is
  # intentionally tight — extend via override file for multi-region rollout.
  message_storage_policy {
    allowed_persistence_regions = [var.primary_region]
  }
}

# ── Dead-letter topics (15) ──────────────────────────────────────────────
#
# Per-topic DLQ. Aligns with D32 alerting: a Cloud Monitoring alert policy
# (observability module) pages on DLQ message growth.

resource "google_pubsub_topic" "dlq_topics" {
  for_each = local.pubsub_topics

  name                       = "${each.key}.dlq"
  project                    = var.project_id
  message_retention_duration = "604800s" # 7d retention for postmortem replay
  kms_key_name               = var.cmek_key_id
  labels                     = merge(local.labels, { role = "dead-letter" })

  message_storage_policy {
    allowed_persistence_regions = [var.primary_region]
  }
}

# ── Default pull subscriptions (15) ──────────────────────────────────────
#
# These are the "developer scaffolding" subscriptions — each Cloud Run
# capability service that consumes a topic creates its OWN subscription with
# a service-account-scoped push endpoint. The default subscription here
# guarantees no message is dropped if no consumer exists yet, and gives
# operators a debugging surface (`gcloud pubsub subscriptions pull …`).

resource "google_pubsub_subscription" "default_subs" {
  for_each = local.pubsub_topics

  name    = "${each.key}.sub"
  project = var.project_id
  topic   = google_pubsub_topic.topics[each.key].name
  labels  = local.labels

  ack_deadline_seconds       = var.subscription_ack_deadline_seconds
  message_retention_duration = var.message_retention_duration
  retain_acked_messages      = false
  enable_message_ordering    = false

  expiration_policy {
    # Never expire — these are long-lived operational subscriptions.
    ttl = ""
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dlq_topics[each.key].id
    max_delivery_attempts = var.dead_letter_max_attempts
  }
}

# ── Subscription IAM: publisher SA can publish; default pull is operator-only ──
#
# Pub/Sub publisher binding for every topic. The single publisher SA is used
# by Apigee (per-view billable events), agents (cost/armor/anomaly), and
# Cloud Run capability services (campaign.submitted, creator-track.*).

resource "google_pubsub_topic_iam_member" "publisher_bindings" {
  for_each = local.pubsub_topics

  project = var.project_id
  topic   = google_pubsub_topic.topics[each.key].name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${var.pubsub_publisher_sa_email}"
}

# Workflows invoker SA also needs publish (workflow YAMLs call
# googleapis.pubsub.v1.projects.topics.publish — INNGEST-MIGRATION §4.1
# fanout_creator_tracks step).
resource "google_pubsub_topic_iam_member" "workflows_publisher_bindings" {
  for_each = local.pubsub_topics

  project = var.project_id
  topic   = google_pubsub_topic.topics[each.key].name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${var.workflows_invoker_sa_email}"
}
