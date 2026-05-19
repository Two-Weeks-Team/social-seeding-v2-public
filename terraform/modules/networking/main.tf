# terraform/modules/networking/main.tf
#
# TF-Module-3 (networking) — Shared VPC + global HTTPS LB + Cloud Armor + Cloud CDN
# + Cloud NAT (deterministic IPs) + Cloud DNS + Certificate Manager + IAP
# + VPC Service Controls + Private Service Connect + Cloud Service Mesh.
#
# Decision anchors:
#   D13  Multi-region active-active (US central + EU west + APAC northeast) -> global LB + 3 regional subnets
#   D14  RapidAPI egress allowlist requires deterministic NAT IPs -> manual NAT pool per region
#   D20  CMEK + DLP + VPC-SC perimeter around Vertex / Spanner / Firestore / Cloud Storage
#   D31  Enterprise SLO 99.99% -> Cloud Service Mesh mTLS + global LB + multi-region routing
#
# Reference: gcp-research/network-security/NETSEC.md sections 1.1, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.5.

locals {
  region_keys = keys(var.regions)
  vpc_name    = "${var.name_prefix}-shared-vpc"

  # Internal-LB endpoint names that IAP guards (Mission Control admin + Dialogflow CX admin).
  iap_protected_endpoints = {
    "mission-control-admin" = "Mission Control internal admin surface"
    "dialogflow-cx-admin"   = "Dialogflow CX admin console proxy"
    "agent-gateway-debug"   = "Agent Gateway debug + replay surface"
  }
}

###############################################################################
# Shared VPC host wiring  (NETSEC §1.5)
###############################################################################

resource "google_compute_shared_vpc_host_project" "host" {
  project = var.host_project_id
}

resource "google_compute_shared_vpc_service_project" "attached" {
  for_each        = toset(var.service_project_ids)
  host_project    = google_compute_shared_vpc_host_project.host.project
  service_project = each.value
}

###############################################################################
# VPC + 3 regional subnets (D13)
###############################################################################

resource "google_compute_network" "shared" {
  project                 = var.host_project_id
  name                    = local.vpc_name
  auto_create_subnetworks = false
  routing_mode            = var.vpc_routing_mode
  mtu                     = var.vpc_mtu
  description             = "Shared VPC for social-seeding-v2; D13 active-active across ${join(", ", local.region_keys)}."

  depends_on = [google_compute_shared_vpc_host_project.host]
}

resource "google_compute_subnetwork" "regional" {
  for_each = var.regions

  project                  = var.host_project_id
  name                     = "${var.name_prefix}-subnet-${each.key}"
  region                   = each.key
  network                  = google_compute_network.shared.id
  ip_cidr_range            = each.value.primary_cidr
  private_ip_google_access = true # NETSEC §1.5 — required for in-perimeter API calls

  log_config {
    aggregation_interval = "INTERVAL_5_SEC"
    flow_sampling        = 0.5
    metadata             = "INCLUDE_ALL_METADATA"
  }

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = each.value.pods_cidr
  }
  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = each.value.services_cidr
  }
}

# PSC producer-NAT subnet — reserved for any future internal PSC service
# attachments (e.g. an internal Cloud Run service exposed as a PSC producer).
# Consumer-side PSC to Google APIs does NOT need this subnet; the global address
# with PRIVATE_SERVICE_CONNECT purpose is sufficient. Keeping it provisioned so
# TF-Module-2 / TF-Module-4 can wire producer attachments without an apply lag.
resource "google_compute_subnetwork" "psc_nat" {
  for_each = var.regions

  project       = var.host_project_id
  name          = "${var.name_prefix}-psc-nat-${each.key}"
  region        = each.key
  network       = google_compute_network.shared.id
  ip_cidr_range = each.value.psc_cidr
  purpose       = "PRIVATE_SERVICE_CONNECT"
}

###############################################################################
# Cloud NAT — deterministic egress IPs (D14)
###############################################################################

resource "google_compute_router" "regional" {
  for_each = var.regions

  project = var.host_project_id
  name    = "${var.name_prefix}-router-${each.key}"
  region  = each.key
  network = google_compute_network.shared.id
}

# Static, named external IPs so RapidAPI can allowlist them (D14).
resource "google_compute_address" "nat" {
  for_each = {
    for pair in flatten([
      for region, cfg in var.regions : [
        for i in range(cfg.nat_ip_count) : {
          key    = "${region}-${i}"
          region = region
        }
      ]
    ]) : pair.key => pair
  }

  project = var.host_project_id
  name    = "${var.name_prefix}-nat-ip-${each.key}"
  region  = each.value.region

  lifecycle {
    create_before_destroy = true
  }
}

resource "google_compute_router_nat" "regional" {
  for_each = var.regions

  project = var.host_project_id
  name    = "${var.name_prefix}-nat-${each.key}"
  router  = google_compute_router.regional[each.key].name
  region  = each.key

  nat_ip_allocate_option = "MANUAL_ONLY"
  nat_ips = [
    for k, addr in google_compute_address.nat :
    addr.self_link if addr.region == each.key
  ]
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  # Endpoint-independent mapping = better egress consistency (NETSEC §1.6).
  min_ports_per_vm                    = 256
  enable_endpoint_independent_mapping = true

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

###############################################################################
# Cloud DNS (D26)
###############################################################################

resource "google_dns_managed_zone" "public" {
  for_each = {
    for k, z in var.dns_zones : k => z if z.visibility == "public"
  }

  project     = var.host_project_id
  name        = "${var.name_prefix}-dns-${each.key}"
  dns_name    = each.value.dns_name
  description = "Public zone for ${each.value.dns_name} (D26)."
  visibility  = "public"
  labels      = var.labels

  dynamic "dnssec_config" {
    for_each = each.value.dnssec ? [1] : []
    content {
      state         = "on"
      non_existence = "nsec3"
    }
  }
}

resource "google_dns_managed_zone" "private" {
  project    = var.host_project_id
  name       = "${var.name_prefix}-dns-internal"
  dns_name   = var.private_dns_zone
  visibility = "private"
  labels     = var.labels

  private_visibility_config {
    networks {
      network_url = google_compute_network.shared.id
    }
  }
}

###############################################################################
# Certificate Manager (D26 + NETSEC §2.5)
###############################################################################

resource "google_certificate_manager_dns_authorization" "domains" {
  for_each = toset(var.managed_cert_domains)

  project = var.host_project_id
  name    = "${var.name_prefix}-dnsauth-${replace(each.value, ".", "-")}"
  domain  = each.value
  labels  = var.labels
}

resource "google_certificate_manager_certificate" "managed" {
  project = var.host_project_id
  name    = "${var.name_prefix}-cert-global"
  scope   = "DEFAULT"
  labels  = var.labels

  managed {
    domains = var.managed_cert_domains
    dns_authorizations = [
      for d in var.managed_cert_domains :
      google_certificate_manager_dns_authorization.domains[d].id
    ]
  }
}

resource "google_certificate_manager_certificate_map" "global" {
  project     = var.host_project_id
  name        = "${var.name_prefix}-cert-map"
  description = "Cert map for global HTTPS LB (D26)."
  labels      = var.labels
}

resource "google_certificate_manager_certificate_map_entry" "domains" {
  for_each = toset(var.managed_cert_domains)

  project      = var.host_project_id
  name         = "${var.name_prefix}-cmap-${replace(each.value, ".", "-")}"
  map          = google_certificate_manager_certificate_map.global.name
  certificates = [google_certificate_manager_certificate.managed.id]
  hostname     = each.value
  labels       = var.labels
}

###############################################################################
# Cloud Armor security policy (NETSEC §1.4, D21)
###############################################################################

resource "google_compute_security_policy" "edge" {
  provider    = google-beta
  project     = var.host_project_id
  name        = "${var.name_prefix}-armor-edge"
  description = "WAF + bot mgmt + rate limit + adaptive protection (D21 max policy)."

  # Default rule — Cloud Armor requires the catch-all at max priority.
  rule {
    action   = "allow"
    priority = 2147483647
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    description = "default allow"
  }

  # SQLi (CRS 3.3 stable)
  rule {
    action      = "deny(403)"
    priority    = 1000
    description = "block SQLi (CRS 3.3, sensitivity 1)"
    preview     = var.armor_enable_preview
    match {
      expr {
        expression = "evaluatePreconfiguredWaf('sqli-v33-stable', {'sensitivity': 1})"
      }
    }
  }

  # XSS
  rule {
    action      = "deny(403)"
    priority    = 1001
    description = "block XSS"
    preview     = var.armor_enable_preview
    match {
      expr {
        expression = "evaluatePreconfiguredWaf('xss-v33-stable', {'sensitivity': 1})"
      }
    }
  }

  # LFI / RFI / RCE bundle
  rule {
    action      = "deny(403)"
    priority    = 1002
    description = "block LFI"
    preview     = var.armor_enable_preview
    match {
      expr {
        expression = "evaluatePreconfiguredWaf('lfi-v33-stable', {'sensitivity': 1})"
      }
    }
  }
  rule {
    action      = "deny(403)"
    priority    = 1003
    description = "block RCE"
    preview     = var.armor_enable_preview
    match {
      expr {
        expression = "evaluatePreconfiguredWaf('rce-v33-stable', {'sensitivity': 1})"
      }
    }
  }

  # Rate limit the agent /run hot path (NETSEC §1.4) — a single abusive client cannot
  # six-figure us overnight on Gemini token spend.
  rule {
    action      = "rate_based_ban"
    priority    = 2000
    description = "agent /run rate limit (D21 cost shield)"
    match {
      expr {
        expression = "request.path.matches('/api/agent/run')"
      }
    }
    rate_limit_options {
      conform_action   = "allow"
      exceed_action    = "deny(429)"
      enforce_on_key   = "IP"
      ban_duration_sec = 600
      rate_limit_threshold {
        count        = var.armor_rate_limit_threshold
        interval_sec = 60
      }
    }
  }

  # Bot management — challenge low-reputation clients on auth flows.
  rule {
    action      = "deny(403)"
    priority    = 2100
    description = "block low-reputation bots on /api/auth"
    preview     = var.armor_enable_preview
    match {
      expr {
        expression = "request.path.matches('/api/auth') && token.recaptcha_session.score < 0.3"
      }
    }
  }

  adaptive_protection_config {
    layer_7_ddos_defense_config {
      enable          = var.armor_adaptive_protection
      rule_visibility = "STANDARD"
    }
  }

  advanced_options_config {
    log_level               = "VERBOSE"
    user_ip_request_headers = ["True-Client-IP", "X-Forwarded-For"]
    json_parsing            = "STANDARD"
  }
}

###############################################################################
# Global HTTPS LB (D13 + NETSEC §1.1)
###############################################################################

resource "google_compute_global_address" "lb" {
  project    = var.host_project_id
  name       = "${var.name_prefix}-global-lb-ip"
  ip_version = "IPV4"
  labels     = var.labels
}

# Placeholder backend — populated by TF-Module-2 (compute) via remote state once
# Cloud Run / Agent Runtime services exist. We ship the URL map + cert + Armor
# wiring here so the data path is owned in one place per RULES (single responsibility).
resource "google_compute_backend_service" "agent_api" {
  provider              = google-beta
  project               = var.host_project_id
  name                  = "${var.name_prefix}-be-agent-api"
  description           = "Agent API backend; receives Cloud Run NEGs from compute module via google_compute_backend_service_add resource."
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  timeout_sec           = 600 # NETSEC §1.1 — streaming LLM responses
  enable_cdn            = true
  security_policy       = google_compute_security_policy.edge.id

  log_config {
    enable      = true
    sample_rate = 1.0
  }

  cdn_policy {
    cache_mode                   = "USE_ORIGIN_HEADERS"
    negative_caching             = true
    serve_while_stale            = 0
    signed_url_cache_max_age_sec = 0
  }

  # Backends are added by compute module via lifecycle ignore_changes.
  lifecycle {
    ignore_changes = [backend]
  }
}

resource "google_compute_url_map" "default" {
  project         = var.host_project_id
  name            = "${var.name_prefix}-urlmap"
  default_service = google_compute_backend_service.agent_api.id
}

resource "google_compute_target_https_proxy" "default" {
  project                          = var.host_project_id
  name                             = "${var.name_prefix}-https-proxy"
  url_map                          = google_compute_url_map.default.id
  certificate_manager_certificates = [google_certificate_manager_certificate.managed.id]
  ssl_policy                       = google_compute_ssl_policy.modern.id
  quic_override                    = "ENABLE"
}

resource "google_compute_ssl_policy" "modern" {
  project         = var.host_project_id
  name            = "${var.name_prefix}-ssl-modern"
  profile         = "MODERN"
  min_tls_version = "TLS_1_2" # NETSEC §1.1 best practice
}

resource "google_compute_global_forwarding_rule" "https" {
  project               = var.host_project_id
  name                  = "${var.name_prefix}-fr-https"
  ip_protocol           = "TCP"
  port_range            = "443"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.lb.address
  target                = google_compute_target_https_proxy.default.id
  labels                = var.labels
}

# HTTP → HTTPS redirect (compliance + UX).
resource "google_compute_url_map" "https_redirect" {
  project = var.host_project_id
  name    = "${var.name_prefix}-urlmap-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "redirect" {
  project = var.host_project_id
  name    = "${var.name_prefix}-http-proxy"
  url_map = google_compute_url_map.https_redirect.id
}

resource "google_compute_global_forwarding_rule" "http" {
  project               = var.host_project_id
  name                  = "${var.name_prefix}-fr-http"
  ip_protocol           = "TCP"
  port_range            = "80"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.lb.address
  target                = google_compute_target_http_proxy.redirect.id
  labels                = var.labels
}

###############################################################################
# IAP for internal endpoints (D19 + NETSEC §1.8)
###############################################################################

resource "google_iap_brand" "internal" {
  project           = var.host_project_id
  support_email     = var.iap_brand_support_email
  application_title = "${var.name_prefix} internal endpoints"
}

resource "google_iap_client" "internal" {
  for_each     = local.iap_protected_endpoints
  display_name = "${var.name_prefix}-${each.key}"
  brand        = google_iap_brand.internal.name
}

# Project-level IAP web access. Per-backend bindings (Cloud Run / backend service)
# are added by TF-Module-2 once those resources exist — keeping the
# authoritative project-level binding here makes sure no one accidentally gets
# IAP access via a different role surface.
resource "google_iap_web_iam_binding" "operators" {
  count = length(var.iap_member_groups) > 0 ? 1 : 0

  project = var.host_project_id
  role    = "roles/iap.httpsResourceAccessor"
  members = var.iap_member_groups
}

###############################################################################
# Private Service Connect — endpoints for Vertex AI APIs (D20 + NETSEC §1.5)
###############################################################################

resource "google_compute_global_address" "psc_vertex" {
  for_each = var.regions

  project      = var.host_project_id
  name         = "${var.name_prefix}-psc-vertex-${each.key}"
  address_type = "INTERNAL"
  purpose      = "PRIVATE_SERVICE_CONNECT"
  network      = google_compute_network.shared.id
  address      = each.value.psc_endpoint_ip
}

resource "google_compute_global_forwarding_rule" "psc_vertex" {
  provider = google-beta

  for_each = var.regions

  project = var.host_project_id
  name    = "${var.name_prefix}-psc-${each.key}"
  # "all-apis" = PSC bundle covering every Google API; pairs with VPC-SC so calls
  # to Vertex/Spanner/Firestore stay on Google's backbone (NETSEC §1.5).
  # Use "vpc-sc" instead only when restricting to perimeter-protected APIs in a
  # perimeter-bridge topology.
  target                = "all-apis"
  network               = google_compute_network.shared.id
  ip_address            = google_compute_global_address.psc_vertex[each.key].id
  load_balancing_scheme = "" # required empty for PSC GFR per provider docs
}

###############################################################################
# VPC Service Controls perimeter (D20 + NETSEC §1.5)
###############################################################################

resource "google_access_context_manager_access_level" "corp_break_glass" {
  count  = length(var.vpc_sc_corp_cidrs) > 0 ? 1 : 0
  parent = "accessPolicies/${var.access_policy_id}"
  name   = "accessPolicies/${var.access_policy_id}/accessLevels/${var.name_prefix}_corp"
  title  = "${var.name_prefix} corp break-glass"

  basic {
    conditions {
      ip_subnetworks = var.vpc_sc_corp_cidrs
    }
  }
}

resource "google_access_context_manager_service_perimeter" "core" {
  provider = google-beta

  parent                    = "accessPolicies/${var.access_policy_id}"
  name                      = "accessPolicies/${var.access_policy_id}/servicePerimeters/${var.name_prefix}_core"
  title                     = "${var.name_prefix} core perimeter (D20)"
  perimeter_type            = "PERIMETER_TYPE_REGULAR"
  use_explicit_dry_run_spec = var.vpc_sc_dry_run

  dynamic "spec" {
    for_each = var.vpc_sc_dry_run ? [1] : []
    content {
      restricted_services = var.vpc_sc_restricted_services
      resources           = [for p in var.service_project_ids : "projects/${p}"]

      vpc_accessible_services {
        enable_restriction = true
        allowed_services   = var.vpc_sc_restricted_services
      }

      access_levels = length(var.vpc_sc_corp_cidrs) > 0 ? [google_access_context_manager_access_level.corp_break_glass[0].name] : []

      # Egress carve-out: workforce identity may reach Vertex AI for evals from
      # outside the perimeter during dry-run baseline (NETSEC §1.5).
      egress_policies {
        egress_from {
          identity_type = "ANY_SERVICE_ACCOUNT"
        }
        egress_to {
          resources = ["*"]
          operations {
            service_name = "aiplatform.googleapis.com"
            method_selectors {
              method = "*"
            }
          }
        }
      }
    }
  }

  dynamic "status" {
    for_each = var.vpc_sc_dry_run ? [] : [1]
    content {
      restricted_services = var.vpc_sc_restricted_services
      resources           = [for p in var.service_project_ids : "projects/${p}"]

      vpc_accessible_services {
        enable_restriction = true
        allowed_services   = var.vpc_sc_restricted_services
      }

      access_levels = length(var.vpc_sc_corp_cidrs) > 0 ? [google_access_context_manager_access_level.corp_break_glass[0].name] : []

      ingress_policies {
        ingress_from {
          identity_type = "ANY_SERVICE_ACCOUNT"
          dynamic "sources" {
            for_each = length(var.vpc_sc_corp_cidrs) > 0 ? [1] : []
            content {
              access_level = google_access_context_manager_access_level.corp_break_glass[0].name
            }
          }
        }
        ingress_to {
          resources = ["*"]
          operations {
            service_name = "aiplatform.googleapis.com"
            method_selectors { method = "*" }
          }
          operations {
            service_name = "spanner.googleapis.com"
            method_selectors { method = "*" }
          }
        }
      }

      egress_policies {
        egress_from {
          identity_type = "ANY_SERVICE_ACCOUNT"
        }
        egress_to {
          # External APIs reached via Cloud NAT (RapidAPI etc) bypass VPC-SC by
          # virtue of being non-Google services. This block is intentionally
          # narrow — adjust per O5/O6 audit findings.
          resources = ["*"]
          operations {
            service_name = "storage.googleapis.com"
            method_selectors { method = "google.storage.objects.get" }
          }
        }
      }
    }
  }

  # Allow egress_policies / ingress_policies to be granular-managed by sibling
  # resources (NETSEC §1.5 lifecycle guidance).
  lifecycle {
    ignore_changes = [status[0].egress_policies, status[0].ingress_policies]
  }
}

###############################################################################
# Cloud Service Mesh — fleet enablement (D31 + NETSEC §1.9)
###############################################################################

resource "google_gke_hub_feature" "servicemesh" {
  count    = var.enable_service_mesh ? 1 : 0
  provider = google-beta

  project  = var.host_project_id
  name     = "servicemesh"
  location = "global"
  labels   = var.labels

  # Membership-level enablement is handled by TF-Module-2 once GKE clusters and
  # Cloud Run revisions exist. This resource just opens the fleet-level switch
  # so the data plane has a control plane to attach to (NETSEC §1.9).
}

###############################################################################
# Firewall — minimal allow set (deny-all by default in GCP custom VPC)
###############################################################################

resource "google_compute_firewall" "allow_iap_health" {
  project = var.host_project_id
  name    = "${var.name_prefix}-allow-iap-health"
  network = google_compute_network.shared.id

  # IAP TCP forwarding + GFE health check ranges (NETSEC §1.8 + LB docs).
  source_ranges = [
    "35.235.240.0/20", # IAP TCP forwarding
    "35.191.0.0/16",   # GFE health check
    "130.211.0.0/22",  # GFE health check
  ]

  allow {
    protocol = "tcp"
    ports    = ["22", "80", "443", "8080", "8443"]
  }

  direction = "INGRESS"
  priority  = 1000
}

resource "google_compute_firewall" "deny_all_egress_to_internet" {
  project = var.host_project_id
  name    = "${var.name_prefix}-deny-direct-internet"
  network = google_compute_network.shared.id

  # All public-internet egress must traverse Cloud NAT (so RapidAPI IP allowlist
  # holds — D14). This rule denies VMs that try to reach the internet via their
  # own external IP.
  destination_ranges = ["0.0.0.0/0"]
  deny {
    protocol = "all"
  }
  direction = "EGRESS"
  priority  = 65534
  # Lower than NAT egress (default priority 1000 implicit) so NAT path wins.
  target_tags = ["no-direct-internet"]
}
