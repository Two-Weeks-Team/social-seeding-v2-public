# =============================================================================
# variables.tf — AI module inputs
# Citations: D5, D13, D15, D16, D17, D18, D19, D20, D23, D24, D25, D26, D39
# =============================================================================

# -----------------------------------------------------------------------------
# Project / region wiring (D13: Global active-active US + EU + APAC)
# -----------------------------------------------------------------------------
variable "project_id" {
  description = "GCP project ID hosting the AI Agent Platform resources."
  type        = string
}

variable "project_number" {
  description = "GCP project number — required for service-agent IAM bindings (Discovery Engine, Agent Runtime) per AI-AGENTS.md §C1."
  type        = string
}

variable "region" {
  description = "Primary region for Vertex AI (default us-central1; EU = europe-west4; APAC = asia-northeast1). D13 caller may instantiate the module per-region."
  type        = string
  default     = "us-central1"
}

variable "environment" {
  description = "Environment label: prod | staging | dev. Drives capacity sizing + retention multipliers."
  type        = string
  default     = "prod"

  validation {
    condition     = contains(["prod", "staging", "dev"], var.environment)
    error_message = "environment must be one of: prod, staging, dev."
  }
}

variable "resource_prefix" {
  description = "Short prefix injected into all resource names (e.g. \"ssv2\"). Keep <= 12 chars; Vector Search index IDs cap at 63 chars."
  type        = string
  default     = "ssv2"

  validation {
    condition     = length(var.resource_prefix) <= 12 && can(regex("^[a-z][a-z0-9-]*$", var.resource_prefix))
    error_message = "resource_prefix must be 1-12 chars, lowercase letters/digits/hyphens, starting with a letter."
  }
}

# -----------------------------------------------------------------------------
# Network wiring (D17 Agent Runtime + Vector Search require VPC / PSC)
# -----------------------------------------------------------------------------
variable "network_self_link" {
  description = "Self-link of the VPC the Vector Search endpoint will peer into. Format: projects/<num>/global/networks/<name>."
  type        = string
}

variable "vector_search_reserved_ip_range_name" {
  description = "Name of a Google-managed reserved IP range (google_compute_global_address with purpose=VPC_PEERING) usable for Vector Search private endpoints."
  type        = string
  default     = "vertex-vector-search-range"
}

# -----------------------------------------------------------------------------
# Identity / CMEK passthrough (D19 + D20)
# -----------------------------------------------------------------------------
variable "agent_runtime_service_account_email" {
  description = "Email of the SA that the Agent Runtime workloads (all 22 agents) will run as. Must already have aiplatform.user + iam.serviceAccountTokenCreator. Owned by the `security` module."
  type        = string
}

variable "data_scientist_service_account_email" {
  description = "Email of the SA used by Vertex AI Workbench notebooks (D25 — data scientists running tuning experiments)."
  type        = string
}

variable "cmek_key_name" {
  description = "Fully-qualified Cloud KMS key for CMEK on Vertex AI Vector Search indexes (D20). Format: projects/.../locations/.../keyRings/.../cryptoKeys/...   Pass empty string to disable CMEK for dev environments."
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# Model Garden / model defaults (D5)
# -----------------------------------------------------------------------------
variable "model_defaults" {
  description = "Per-tier default model IDs (D5: 2.5 Pro / Flash / Flash-Lite as production baseline; 3.1 Pro Preview only for demo per D39 + AI-AGENTS.md §5)."
  type = object({
    judgment   = string # outreach_writer, research, analyst, compliance, critic, optimizer
    bulk       = string # vetting (fan-out), logistics, intake, a11y, anomaly_watch, security_watch
    classifier = string # conversation (intent classification)
    demo       = string # 3.1 Pro Preview — only for final demo recording
  })
  default = {
    judgment   = "gemini-2.5-pro"
    bulk       = "gemini-2.5-flash"
    classifier = "gemini-2.5-flash-lite"
    demo       = "gemini-3.1-pro-preview-0428"
  }
}

# -----------------------------------------------------------------------------
# Vector Search sizing (D16)
# -----------------------------------------------------------------------------
# Per ARCHITECTURE.md §3: vector_search.creator, vector_search.brand_fit,
# vector_search.competitor and content embeddings → three indexes: creators_v1,
# brands_v1, content_v1.
variable "vector_indexes" {
  description = "Vertex AI Vector Search indexes to provision (D16). Keyed by short name; expanded into google_vertex_ai_index + endpoint + deployed_index per entry."
  type = map(object({
    display_name                = string
    dimensions                  = number
    distance_measure            = string # COSINE_DISTANCE | DOT_PRODUCT_DISTANCE | SQUARED_L2_DISTANCE
    approximate_neighbors_count = number
    shard_size                  = string # SHARD_SIZE_SMALL | MEDIUM | LARGE
    update_method               = string # BATCH_UPDATE | STREAM_UPDATE
    contents_gcs_uri            = string # gs://bucket/prefix — seed data location (may be empty for empty-index bootstrap)
    leaf_node_embedding_count   = number
    leaf_nodes_to_search_percent = number
    min_replica_count           = number
    max_replica_count           = number
  }))
  default = {
    creators_v1 = {
      display_name                 = "creators_v1"
      dimensions                   = 768
      distance_measure             = "COSINE_DISTANCE"
      approximate_neighbors_count  = 150
      shard_size                   = "SHARD_SIZE_MEDIUM"
      update_method                = "STREAM_UPDATE"
      contents_gcs_uri             = ""
      leaf_node_embedding_count    = 1000
      leaf_nodes_to_search_percent = 10
      min_replica_count            = 2
      max_replica_count            = 5
    }
    brands_v1 = {
      display_name                 = "brands_v1"
      dimensions                   = 768
      distance_measure             = "COSINE_DISTANCE"
      approximate_neighbors_count  = 100
      shard_size                   = "SHARD_SIZE_SMALL"
      update_method                = "BATCH_UPDATE"
      contents_gcs_uri             = ""
      leaf_node_embedding_count    = 500
      leaf_nodes_to_search_percent = 7
      min_replica_count            = 1
      max_replica_count            = 3
    }
    content_v1 = {
      display_name                 = "content_v1"
      dimensions                   = 1408 # multimodal embedding (image+text per D6 creative agent)
      distance_measure             = "DOT_PRODUCT_DISTANCE"
      approximate_neighbors_count  = 200
      shard_size                   = "SHARD_SIZE_LARGE"
      update_method                = "STREAM_UPDATE"
      contents_gcs_uri             = ""
      leaf_node_embedding_count    = 2000
      leaf_nodes_to_search_percent = 10
      min_replica_count            = 2
      max_replica_count            = 8
    }
  }
}

# -----------------------------------------------------------------------------
# Agent Registry seed (D23 — 22 agents per ARCHITECTURE.md §3)
# -----------------------------------------------------------------------------
# Each entry feeds two paths:
#   1. A google_storage_bucket_object that publishes the A2A v0.3 Agent Card
#      JSON (required for Cloud Marketplace listing — AI-AGENTS.md §C3).
#   2. A null_resource that runs `gcloud beta agents register` once the Agent
#      Registry GA TF resource is unavailable.
variable "agent_registry" {
  description = "The 22-agent fleet — keyed by stable agent id; expanded into Agent Card + Registry registration. Defaults reflect ARCHITECTURE.md §3."
  type = map(object({
    tier              = number  # 1 = domain, 2 = meta, 3 = watchdog (D23)
    display_name      = string
    description       = string
    model_tier        = string  # judgment | bulk | classifier
    skills            = list(string)
    memory_strategy   = string  # session_only | memory_bank | none
    eval_criteria     = string
    autonomy          = string  # always_ask | ask_on_external_send | autonomous_with_caps
    usd_cap_per_run   = number  # D23 — every agent has a per-run USD ceiling
    escalation_target = string  # which agent (or human surface) handles overage
  }))
  default = {
    # ----- Tier 1: 16 domain agents -----
    sourcing                = { tier = 1, display_name = "Sourcing",            description = "Plan + execute creator search across RapidAPI sources",        model_tier = "judgment",   skills = ["rapidapi.tiktok_search", "rapidapi.instagram_search", "blacklist.check", "vector_search.creator"],    memory_strategy = "memory_bank",  eval_criteria = "trajectory_coverage",        autonomy = "autonomous_with_caps",   usd_cap_per_run = 0.50, escalation_target = "critic" }
    vetting                 = { tier = 1, display_name = "Vetting",             description = "Parallel fan-out scoring of candidate fit",                    model_tier = "judgment",   skills = ["rapidapi.get_user_info", "ranking.score", "vector_search.brand_fit"],                                memory_strategy = "session_only", eval_criteria = "tool_trajectory_avg_score",  autonomy = "autonomous_with_caps",   usd_cap_per_run = 0.30, escalation_target = "critic" }
    outreach_writer         = { tier = 1, display_name = "Outreach Writer",     description = "5-angle tournament outreach draft + judge → winner",           model_tier = "judgment",   skills = ["templates.list", "outreach.extract_facts", "outreach.render", "outreach.judge"],                     memory_strategy = "memory_bank",  eval_criteria = "response_match_v2_spam",     autonomy = "ask_on_external_send",   usd_cap_per_run = 0.40, escalation_target = "compliance" }
    conversation            = { tier = 1, display_name = "Conversation",        description = "Classify inbound reply into 8 intent categories",              model_tier = "classifier", skills = ["nlp.classify_intent"],                                                                                memory_strategy = "session_only", eval_criteria = "classification_f1",          autonomy = "autonomous_with_caps",   usd_cap_per_run = 0.05, escalation_target = "conversation_responder" }
    conversation_responder  = { tier = 1, display_name = "Conversation Reply",  description = "Draft follow-up replies",                                       model_tier = "judgment",   skills = ["templates.list", "outreach.render"],                                                                  memory_strategy = "memory_bank",  eval_criteria = "response_match_v2",          autonomy = "ask_on_external_send",   usd_cap_per_run = 0.20, escalation_target = "compliance" }
    logistics               = { tier = 1, display_name = "Logistics",           description = "Parse free-text shipping address; create carrier label",       model_tier = "bulk",       skills = ["address.normalize", "carrier.create"],                                                                memory_strategy = "session_only", eval_criteria = "structured_extract_accuracy",autonomy = "autonomous_with_caps",   usd_cap_per_run = 0.10, escalation_target = "customer_success" }
    content_verify          = { tier = 1, display_name = "Content Verify",      description = "Verify brand-mentioned post matches the campaign brief",       model_tier = "bulk",       skills = ["rapidapi.post_detail", "vision.brand_logo_detect"],                                                   memory_strategy = "none",         eval_criteria = "precision_recall_holdout",   autonomy = "autonomous_with_caps",   usd_cap_per_run = 0.10, escalation_target = "critic" }
    analyst                 = { tier = 1, display_name = "Analyst",             description = "Final campaign report",                                         model_tier = "judgment",   skills = ["bigquery.query", "view_metrics.aggregate"],                                                           memory_strategy = "memory_bank",  eval_criteria = "accuracy_grounding",         autonomy = "always_ask",             usd_cap_per_run = 0.30, escalation_target = "customer_success" }
    research                = { tier = 1, display_name = "Research",            description = "Background brand/competitor research with grounding",          model_tier = "judgment",   skills = ["web.search", "vector_search.competitor"],                                                             memory_strategy = "memory_bank",  eval_criteria = "hallucinations_v1",          autonomy = "autonomous_with_caps",   usd_cap_per_run = 0.50, escalation_target = "critic" }
    intake                  = { tier = 1, display_name = "Intake",              description = "Conversational brand brief intake",                            model_tier = "bulk",       skills = ["forms.upsert"],                                                                                       memory_strategy = "session_only", eval_criteria = "task_completion",            autonomy = "autonomous_with_caps",   usd_cap_per_run = 0.10, escalation_target = "customer_success" }
    lead_outreach_writer    = { tier = 1, display_name = "Lead Outreach",       description = "B2B lead outreach (sister loop)",                              model_tier = "judgment",   skills = ["templates.list", "outreach.render", "crm.enrich"],                                                    memory_strategy = "memory_bank",  eval_criteria = "response_match_v2",          autonomy = "ask_on_external_send",   usd_cap_per_run = 0.40, escalation_target = "compliance" }
    payment_mandate         = { tier = 1, display_name = "Payment Mandate",     description = "Compose AP2 Intent Mandate; gate to human approval (D27)",      model_tier = "bulk",       skills = ["ap2.compose_intent_mandate", "gate.approveOutreachSend"],                                            memory_strategy = "session_only", eval_criteria = "mandate_validity",           autonomy = "always_ask",             usd_cap_per_run = 0.05, escalation_target = "human_inbox" }
    compliance              = { tier = 1, display_name = "Compliance",          description = "PIPA Article 23/24 + CAN-SPAM + DLP pre-send check",           model_tier = "judgment",   skills = ["pipa.check_consent", "canspam.check_unsubscribe", "dlp.inspect"],                                     memory_strategy = "memory_bank",  eval_criteria = "precision_no_false_clear",   autonomy = "always_ask",             usd_cap_per_run = 0.15, escalation_target = "human_inbox" }
    creative                = { tier = 1, display_name = "Creative",            description = "Brief → moodboard + shot list + sample video (Imagen + Veo)", model_tier = "judgment",   skills = ["imagen.generate", "veo.generate", "lyria.generate", "assets.upload"],                                memory_strategy = "memory_bank",  eval_criteria = "safety_v1_brand_consistency",autonomy = "ask_on_external_send",   usd_cap_per_run = 2.50, escalation_target = "critic" }
    a11y                    = { tier = 1, display_name = "Accessibility",       description = "Alt-text + caption + transcript per locale (D34)",             model_tier = "bulk",       skills = ["vision.describe", "stt.transcribe", "tts.synthesize", "translation.translate"],                       memory_strategy = "none",         eval_criteria = "a11y_compliance_score",      autonomy = "autonomous_with_caps",   usd_cap_per_run = 0.20, escalation_target = "creative" }
    customer_success        = { tier = 1, display_name = "Customer Success",    description = "Detect onboarding-friction signals + propose interventions",   model_tier = "judgment",   skills = ["analytics.funnel", "intervention.propose"],                                                           memory_strategy = "memory_bank",  eval_criteria = "activation_lift",            autonomy = "always_ask",             usd_cap_per_run = 0.20, escalation_target = "human_inbox" }

    # ----- Tier 2: 3 meta agents (D24 — "1→100 coordinators") -----
    coordinator             = { tier = 2, display_name = "M1 Coordinator",      description = "Pick which Tier-1 (or remote A2A) agent handles a task",      model_tier = "bulk",       skills = ["agent_registry.list", "a2a.invoke"],                                                                  memory_strategy = "session_only", eval_criteria = "routing_accuracy",           autonomy = "autonomous_with_caps",   usd_cap_per_run = 0.10, escalation_target = "critic" }
    critic                  = { tier = 2, display_name = "M2 Critic",           description = "LLM-as-judge across tier-1 outputs; gates approvals",         model_tier = "judgment",   skills = ["evaluation.score", "gate.escalate"],                                                                  memory_strategy = "none",         eval_criteria = "judge_agreement_v_human",    autonomy = "autonomous_with_caps",   usd_cap_per_run = 0.30, escalation_target = "human_inbox" }
    optimizer               = { tier = 2, display_name = "M3 Optimizer",        description = "Periodic prompt + tool-budget rewriter via Agent Optimizer",  model_tier = "judgment",   skills = ["agent_optimizer.tune", "prompt_registry.update"],                                                    memory_strategy = "none",         eval_criteria = "offline_eval_lift",          autonomy = "always_ask",             usd_cap_per_run = 1.00, escalation_target = "human_inbox" }

    # ----- Tier 3: 3 watchdog agents (D23) -----
    anomaly_watch           = { tier = 3, display_name = "W1 Anomaly Watch",    description = "Monitor token/cost/latency anomalies; trigger auto-runbook",  model_tier = "bulk",       skills = ["metrics.query", "runbook.execute"],                                                                   memory_strategy = "none",         eval_criteria = "precision_alert_vs_false",   autonomy = "autonomous_with_caps",   usd_cap_per_run = 0.05, escalation_target = "human_inbox" }
    cost_watch              = { tier = 3, display_name = "W2 Cost Watch",       description = "Per-tenant USD/day ceiling; 50/75/90/95 % alerting",         model_tier = "classifier", skills = ["billing.query", "pubsub.alert"],                                                                      memory_strategy = "none",         eval_criteria = "latency_to_alert",           autonomy = "autonomous_with_caps",   usd_cap_per_run = 0.01, escalation_target = "human_inbox" }
    security_watch          = { tier = 3, display_name = "W3 Security Watch",   description = "Model Armor blocks + Chronicle alerts → tenant quarantine",  model_tier = "bulk",       skills = ["model_armor.query_blocks", "chronicle.query", "tenant.quarantine"],                                  memory_strategy = "none",         eval_criteria = "ttr_remediate",              autonomy = "always_ask",             usd_cap_per_run = 0.10, escalation_target = "human_inbox" }
  }
}

# -----------------------------------------------------------------------------
# Discovery Engine / Gemini Enterprise (D26 + AI-AGENTS.md §C1)
# -----------------------------------------------------------------------------
variable "gemini_enterprise" {
  description = "Settings for Discovery Engine app registration (Track 3 path) and Dialogflow CX skeleton (D26 customer support surface)."
  type = object({
    enable_app                  = bool
    app_id                      = string
    app_location                = string # "global" | "us" | "eu" (must match agent runtime region family)
    company_name                = string
    industry_vertical           = string # GENERIC | MEDIA | …
    register_default_agent      = bool
    register_default_agent_name = string # which agent id from var.agent_registry to surface in Gemini Enterprise
    dialogflow_agent_location   = string # europe-west3 | us-central1 | asia-northeast1
    dialogflow_language         = string
    dialogflow_time_zone        = string
  })
  default = {
    enable_app                  = true
    app_id                      = "ssv2-mission-control"
    app_location                = "global"
    company_name                = "Social Seeding"
    industry_vertical           = "GENERIC"
    register_default_agent      = true
    register_default_agent_name = "coordinator"
    dialogflow_agent_location   = "us-central1"
    dialogflow_language         = "en"
    dialogflow_time_zone        = "America/Los_Angeles"
  }
}

# -----------------------------------------------------------------------------
# Agent Gateway (D17/D21 governance ingress — Private Preview)
# -----------------------------------------------------------------------------
# Owned operationally by the `security` module (ARMOR-GATEWAY.md §5), but we
# expose a flag here so the `ai` module can route Agent Runtime egress through
# the gateway. The actual gateway resource lives in `terraform/modules/security`.
variable "agent_gateway_id" {
  description = "Resource ID of the google_network_services_agent_gateway provisioned by the security module. Empty string disables gateway routing (dev only)."
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# Memory Bank + Sessions (D17 + D33 retention)
# -----------------------------------------------------------------------------
variable "memory_bank" {
  description = "Agent Memory Bank backing config (D33: 14-day memory retention)."
  type = object({
    firestore_database_id = string # the Firestore Native DB id housing the memory bank schema
    location_id           = string # firestore multi-region: nam5 (US), eur3 (EU), asia-northeast1
    retention_days        = number # D33: 14
  })
  default = {
    firestore_database_id = "agent-memory-bank"
    location_id           = "nam5"
    retention_days        = 14
  }
}

# -----------------------------------------------------------------------------
# Workbench (D25 data scientist notebook)
# -----------------------------------------------------------------------------
variable "workbench_instance" {
  description = "Vertex AI Workbench instance for the SFT/Distillation/RLHF tuning workflow (D25). Set enabled=false to skip in dev."
  type = object({
    enabled       = bool
    name_suffix   = string
    location_zone = string # e.g. us-central1-a
    machine_type  = string
  })
  default = {
    enabled       = true
    name_suffix   = "data-science"
    location_zone = "us-central1-a"
    machine_type  = "e2-standard-4"
  }
}

# -----------------------------------------------------------------------------
# Pipelines / staging bucket (D25 + ADK deploy staging per AI-AGENTS.md §10)
# -----------------------------------------------------------------------------
variable "staging_bucket_name" {
  description = "Cloud Storage bucket used as Vertex AI staging + ADK deploy staging bucket. Must already exist (managed by the `data` module per SERVICE-INVENTORY.md §4)."
  type        = string
}

variable "pipelines" {
  description = "Vertex AI Pipelines (Kubeflow) jobs for the D25 learning loop. Each entry is invoked via gcloud as a null_resource (no GA TF resource yet)."
  type = map(object({
    enabled                = bool
    template_gcs_path      = string # gs://.../template.yaml
    cron_schedule          = string # crontab — empty string = run-once on apply
    description            = string
    pipeline_parameters    = map(string)
  }))
  default = {
    sft = {
      enabled             = true
      template_gcs_path   = "gs://REPLACE_ME/pipelines/sft_v1.yaml"
      cron_schedule       = "0 4 * * 0" # weekly Sunday 04:00 UTC
      description         = "D25: SFT — supervised fine-tuning Gemini 2.5 Flash on outreach golden set."
      pipeline_parameters = { base_model = "gemini-2.5-flash" }
    }
    distillation = {
      enabled             = true
      template_gcs_path   = "gs://REPLACE_ME/pipelines/distill_pro_to_flash_v1.yaml"
      cron_schedule       = "0 5 * * 0"
      description         = "D25: Distillation — teach Flash from Pro tournament winners on outreach_writer."
      pipeline_parameters = { teacher = "gemini-2.5-pro", student = "gemini-2.5-flash" }
    }
    rlhf_on_simulation = {
      enabled             = true
      template_gcs_path   = "gs://REPLACE_ME/pipelines/rlhf_on_simulation_v1.yaml"
      cron_schedule       = "0 6 * * 0"
      description         = "D25: RLHF using Agent Simulation as preference-label oracle (no human labels)."
      pipeline_parameters = { simulator = "vertex-agent-simulation", base_model = "gemini-2.5-pro" }
    }
  }
}

# -----------------------------------------------------------------------------
# Audit / DLP (D20 + D33)
# -----------------------------------------------------------------------------
variable "tags" {
  description = "Labels applied to every resource that supports them (cost attribution + D33 audit search)."
  type        = map(string)
  default = {
    component = "ai"
    module    = "tf-module-7"
    decision  = "d17-d25"
  }
}

# -----------------------------------------------------------------------------
# Behaviour flags — emergency overrides for tight credit budgets (D39)
# -----------------------------------------------------------------------------
variable "feature_flags" {
  description = "Coarse on/off switches for cost-sensitive pieces. Defaults are production; flip in dev to keep Workbench/Vector Search dark."
  type = object({
    enable_vector_search         = bool
    enable_workbench             = bool
    enable_pipelines             = bool
    enable_dialogflow_cx         = bool
    enable_discovery_engine_app  = bool
    enable_agent_registry_seed   = bool
    fail_on_preview_resource_err = bool # for null_resources hitting Private Preview APIs
  })
  default = {
    enable_vector_search         = true
    enable_workbench             = true
    enable_pipelines             = true
    enable_dialogflow_cx         = true
    enable_discovery_engine_app  = true
    enable_agent_registry_seed   = true
    fail_on_preview_resource_err = false # set true after Agent Gateway → GA (post-2026-Q3)
  }
}
