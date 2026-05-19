# main.tf — module-wide locals, label merge, schema-file loading.
#
# Resource declarations live in dedicated files:
#   pubsub.tf        — 15 topics + 5 schemas + per-topic subscriptions + DLQs
#   cloud_tasks.tf   — 4 queues (outreach-send, carrier-poll, fcm-push, cost-alert)
#   workflows.tf     — 5 Cloud Workflows definitions (YAML loaded from workflows/)
#   scheduler.tf     — 5 Cloud Scheduler cron jobs
#   eventarc.tf      — Eventarc Advanced bus + 8 enrollments
#   apigee.tf        — Apigee X org + instance + 3 API products
#   api_hub.tf       — API Hub catalog (OpenAPI + AsyncAPI ingestion)
#
# References:
#   - D18 (DECISIONS.md): Cloud Workflows + Pub/Sub + Cloud Tasks + Eventarc Advanced
#   - D28 (DECISIONS.md): Apigee X monetization for $0.01/view billing
#   - SERVICE-INVENTORY.md §8: integration service subset
#   - INNGEST-MIGRATION.md §4: workflow YAML samples
#   - shared.asyncapi.yaml: Pub/Sub message schemas
#   - pricing/MODEL.md §4: billing pipeline

locals {
  default_labels = {
    managed_by  = "terraform"
    module      = "integration"
    decision    = "d18-d28"
    environment = "production"
  }

  labels = merge(local.default_labels, var.labels)

  # ── Pub/Sub topic inventory (15 topics from day-1-setup.sh:254-270) ──
  #
  # Topics are split into 4 groups by AsyncAPI channel naming convention
  # (shared.asyncapi.yaml lines 10-13):
  #   - campaign.*       : domain events (workflow fan-out)
  #   - creator-track.*  : per-creator child workflow events
  #   - gmail.*          : Gmail watch / reply correlation
  #   - system / audit   : observability + security signals
  #
  # Each topic gets:
  #   - CMEK encryption (D20 — kms_key_name)
  #   - 7d message retention (default; D33 audit log lifecycle)
  #   - schema attachment where AsyncAPI defines one (5 schemas)
  #   - dead-letter topic + pull subscription
  pubsub_topics = {
    "campaign.submitted" = {
      description = "Brand campaign submitted by operator — Eventarc triggers brand-campaign workflow."
      schema_key  = null
    }
    "campaign.shortlist.approved" = {
      description = "Human approved shortlist gate — INNGEST-MIGRATION §3.4 gate resolution."
      schema_key  = null
    }
    "creator-track.fanout" = {
      description = "Parent → child fan-out. Cloud Tasks queue dispatches to per-tenant rate-limited handler (R3)."
      schema_key  = null
    }
    "creator-track.outreach-sent" = {
      description = "Outreach email dispatched via Gmail capability — outbox pattern (R1)."
      schema_key  = null
    }
    "creator-track.reply-received" = {
      description = "Gmail reply landed in monitored thread — routes via callback router."
      schema_key  = null
    }
    "creator-track.shipment-tracking" = {
      description = "Carrier polled — Cloud Tasks carrier-poll consumer publishes here."
      schema_key  = null
    }
    "creator-track.post-detected" = {
      description = "content_verify detected a published TikTok post for this creator."
      schema_key  = null
    }
    "gmail.reply.received" = {
      description = "Raw Gmail Pub/Sub push — fan-in to callback router for correlation."
      schema_key  = null
    }
    "gmail.watch.expire" = {
      description = "Gmail watch TTL warning (renewed by gmail-watch-renew cron, D18)."
      schema_key  = null
    }
    "cost.threshold-breach" = {
      description = "cost_watch (W2) USD-budget threshold tripped — D32 alerts PagerDuty + Slack."
      schema_key  = "AgentCostRecorded"
    }
    "armor.block-detected" = {
      description = "Model Armor blocked input OR output — D21 max-tier policies."
      schema_key  = "ArmorBlock"
    }
    "anomaly.detected" = {
      description = "Agent Anomaly Detection watchdog signal — D23 + D32."
      schema_key  = "AnomalyDetected"
    }
    "approval.requested" = {
      description = "gate.workflows.yaml notify_inbox publishes here — Mission Control inbox subscribes."
      schema_key  = null
    }
    "approval.resolved" = {
      description = "Human resolved approval. Note: under D18 the canonical path is the durable callback URL; this topic is the audit + secondary fanout channel."
      schema_key  = null
    }
    "audit.event" = {
      description = "Cross-cutting audit log (D33 — 90d retention enforced at BigQuery sink)."
      schema_key  = null
    }
  }

  # ── Pub/Sub schemas (5; subset of AsyncAPI messages that need wire-level enforcement) ──
  #
  # Per D36 / SERVICE-INVENTORY §4 ("Pub/Sub Schema Registry … AsyncAPI 3.0 →
  # Pub/Sub schema enforcement"), we attach Avro schemas to the topics where
  # producers MUST not drift from the contract.
  #
  # We use Avro (not Protobuf) because AsyncAPI 3.0 JSON Schema → Avro is a
  # well-known mechanical translation; the schemas/*.avsc files are the
  # authoritative deploy artifact.
  pubsub_schemas = {
    "AgentInvoked"      = "schemas/agent-invoked.avsc"
    "AgentCompleted"    = "schemas/agent-completed.avsc"
    "AgentCostRecorded" = "schemas/agent-cost-recorded.avsc"
    "ArmorBlock"        = "schemas/armor-block.avsc"
    "AnomalyDetected"   = "schemas/anomaly-detected.avsc"
  }

  # ── Eventarc Advanced enrollments (8) ──
  #
  # Each enrollment binds a CEL filter to a destination (Cloud Workflows
  # execution OR Cloud Run service). Filter syntax operates on CloudEvent
  # ATTRIBUTES, not payload bodies — INNGEST-MIGRATION §2 row 3 caveat.
  eventarc_enrollments = {
    "campaign-submitted-to-brand-workflow" = {
      pubsub_topic         = "campaign.submitted"
      destination_workflow = "brand-campaign"
      cel_match            = "message.attributes.v2EventType == 'campaign.submitted'"
      description          = "Eventarc subscription: campaign.submitted → brand-campaign workflow."
    }
    "creator-track-fanout-to-child-workflow" = {
      pubsub_topic         = "creator-track.fanout"
      destination_workflow = "creator-track"
      cel_match            = "message.attributes.v2EventType == 'creator-track.start'"
      description          = "Parent → child execution (deterministic executionId per parent:child key)."
    }
    "gmail-reply-to-callback-router" = {
      pubsub_topic         = "gmail.reply.received"
      destination_workflow = ""
      cel_match            = "message.attributes.v2EventType == 'gmail.reply.received'"
      description          = "Gmail replies route through Cloud Run callback router (correlation lookup)."
    }
    "approval-resolved-to-callback-router" = {
      pubsub_topic         = "approval.resolved"
      destination_workflow = ""
      cel_match            = "message.attributes.v2EventType == 'approval.resolved'"
      description          = "Human approval resolution → callback router → durable callback URL."
    }
    "cost-breach-to-runbook" = {
      pubsub_topic         = "cost.threshold-breach"
      destination_workflow = "cost-runbook"
      cel_match            = "message.attributes.severity == 'page' || message.attributes.severity == 'critical'"
      description          = "Cost breach (page severity) → auto-runbook (D32)."
    }
    "armor-block-to-security-runbook" = {
      pubsub_topic         = "armor.block-detected"
      destination_workflow = "security-runbook"
      cel_match            = "message.attributes.severity == 'high' || message.attributes.severity == 'critical'"
      description          = "Model Armor high/critical → auto-runbook + SIEM forward (D21 + D32)."
    }
    "anomaly-to-watchdog-runbook" = {
      pubsub_topic         = "anomaly.detected"
      destination_workflow = "anomaly-runbook"
      cel_match            = "message.attributes.severity == 'page'"
      description          = "Page-level anomaly → watchdog auto-runbook (D23)."
    }
    "campaign-cancelled-to-cancel-service" = {
      pubsub_topic         = "campaign.submitted"
      destination_workflow = ""
      cel_match            = "message.attributes.v2EventType == 'campaign.cancelled'"
      description          = "Cancel-on-event Cloud Run service (R7) — calls executions.cancel."
    }
  }

  # ── Apigee API products (3, per D28 + pricing/MODEL.md §5) ──
  apigee_api_products = {
    "per-view-billing" = {
      display_name    = "Per-View Billing (Starter)"
      description     = "Pay-as-you-go $0.01 per delivered view (pricing/MODEL.md §5.2)."
      approval_type   = "auto"
      quota           = "1000000"
      quota_interval  = "1"
      quota_time_unit = "month"
    }
    "free-tier" = {
      display_name    = "Free Tier (10K views/month)"
      description     = "First 10,000 views free; per pricing/MODEL.md §5.1."
      approval_type   = "auto"
      quota           = "10000"
      quota_interval  = "1"
      quota_time_unit = "month"
    }
    "enterprise" = {
      display_name    = "Enterprise (custom commit)"
      description     = "Custom-commit $0.006/view + 99.99% SLA + dedicated tenant pool (pricing/MODEL.md §5.4 + D31)."
      approval_type   = "manual"
      quota           = "100000000"
      quota_interval  = "1"
      quota_time_unit = "month"
    }
  }
}
