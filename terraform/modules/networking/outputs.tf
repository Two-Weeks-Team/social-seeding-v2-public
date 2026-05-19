# terraform/modules/networking/outputs.tf
#
# Outputs consumed by sibling Terraform modules and by application code.
# Stable: TF-Module-2 (compute) reads `subnetwork_ids` + `nat_ip_addresses`.
#         TF-Module-4 (data) reads `vpc_id` + `psc_endpoint_ips` for CMEK/PSC wiring.
#         TF-Module-7 (security) reads `service_perimeter_name` to attach IAM-condition policies.

###############################################################################
# VPC + subnets
###############################################################################

output "host_project_id" {
  description = "Shared VPC host project (D20)."
  value       = google_compute_shared_vpc_host_project.host.project
}

output "vpc_id" {
  description = "Shared VPC self-link. Consumed by compute / data / observability modules."
  value       = google_compute_network.shared.id
}

output "vpc_name" {
  description = "Shared VPC name."
  value       = google_compute_network.shared.name
}

output "subnetwork_ids" {
  description = "Per-region workload subnet self-links keyed by region (D13)."
  value = {
    for region, subnet in google_compute_subnetwork.regional :
    region => subnet.id
  }
}

output "subnetwork_secondary_ranges" {
  description = "Per-region GKE-style secondary ranges (pods + services)."
  value = {
    for region, subnet in google_compute_subnetwork.regional :
    region => {
      pods     = "pods"
      services = "services"
      pods_cidr     = subnet.secondary_ip_range[0].ip_cidr_range
      services_cidr = subnet.secondary_ip_range[1].ip_cidr_range
    }
  }
}

output "psc_nat_subnetwork_ids" {
  description = "Per-region PSC producer-NAT subnet self-links. Used by sibling modules that publish PSC service attachments."
  value = {
    for region, subnet in google_compute_subnetwork.psc_nat :
    region => subnet.id
  }
}

###############################################################################
# Cloud NAT (D14)
###############################################################################

output "nat_ip_addresses" {
  description = "Static NAT egress IPs per region. Hand these to RapidAPI for allowlist (D14)."
  value = {
    for region in keys(var.regions) :
    region => [
      for k, addr in google_compute_address.nat :
      addr.address if addr.region == region
    ]
  }
}

output "nat_router_ids" {
  description = "Per-region Cloud Router self-links."
  value = {
    for region, router in google_compute_router.regional :
    region => router.id
  }
}

###############################################################################
# Global LB (D13 + D31)
###############################################################################

output "global_lb_ip" {
  description = "Anycast IPv4 address for the global HTTPS LB. Point Cloud DNS A records here."
  value       = google_compute_global_address.lb.address
}

output "global_lb_forwarding_rule" {
  description = "HTTPS forwarding rule self-link."
  value       = google_compute_global_forwarding_rule.https.id
}

output "default_backend_service_id" {
  description = "Backend service the compute module appends Cloud Run NEGs to."
  value       = google_compute_backend_service.agent_api.id
}

output "url_map_id" {
  description = "Global URL map self-link. Sibling modules add path matchers via google_compute_url_map_add."
  value       = google_compute_url_map.default.id
}

output "security_policy_id" {
  description = "Cloud Armor edge security policy ID (D21)."
  value       = google_compute_security_policy.edge.id
}

output "ssl_policy_id" {
  description = "Modern SSL policy ID (TLS 1.2+)."
  value       = google_compute_ssl_policy.modern.id
}

###############################################################################
# Certificate Manager (D26)
###############################################################################

output "certificate_id" {
  description = "Google-managed certificate ID covering all D26 hostnames."
  value       = google_certificate_manager_certificate.managed.id
}

output "certificate_map_id" {
  description = "Cert map ID. Add new entries via google_certificate_manager_certificate_map_entry in this module's `managed_cert_domains` input."
  value       = google_certificate_manager_certificate_map.global.id
}

output "dns_authorization_records" {
  description = "DNS authorization CNAME data required to issue managed certs. Surface to the operator for the very first apply."
  value = {
    for d in var.managed_cert_domains :
    d => google_certificate_manager_dns_authorization.domains[d].dns_resource_record
  }
}

###############################################################################
# DNS (D26)
###############################################################################

output "public_dns_zones" {
  description = "Public Cloud DNS managed zone names + NS records keyed by short name."
  value = {
    for k, z in google_dns_managed_zone.public :
    k => {
      name       = z.name
      dns_name   = z.dns_name
      name_servers = z.name_servers
    }
  }
}

output "private_dns_zone" {
  description = "Private DNS zone used by Cloud Service Mesh + internal Cloud Run."
  value = {
    name     = google_dns_managed_zone.private.name
    dns_name = google_dns_managed_zone.private.dns_name
  }
}

###############################################################################
# IAP (D19)
###############################################################################

output "iap_brand_name" {
  description = "IAP brand resource name. Consume from sibling modules that enable IAP on Cloud Run."
  value       = google_iap_brand.internal.name
}

output "iap_clients" {
  description = "Per-endpoint IAP OAuth client IDs (D19 staff break-glass)."
  value = {
    for k, c in google_iap_client.internal :
    k => {
      client_id = c.client_id
    }
  }
  sensitive = false
}

###############################################################################
# Private Service Connect (D20)
###############################################################################

output "psc_endpoint_ips" {
  description = "Per-region PSC endpoint IPs that resolve Google APIs over Google backbone. Agent Runtime points here for Vertex calls (NETSEC §1.5)."
  value = {
    for region, addr in google_compute_global_address.psc_vertex :
    region => addr.address
  }
}

###############################################################################
# VPC-SC (D20)
###############################################################################

output "service_perimeter_name" {
  description = "Service Perimeter resource name. TF-Module-7 (security) attaches IAM-condition + DLP wiring referencing it."
  value       = google_access_context_manager_service_perimeter.core.name
}

output "service_perimeter_dry_run" {
  description = "True while the perimeter is in dry-run. Flip `vpc_sc_dry_run = false` to enforce."
  value       = var.vpc_sc_dry_run
}

###############################################################################
# Service Mesh (D31)
###############################################################################

output "service_mesh_feature" {
  description = "Cloud Service Mesh fleet feature name (null when disabled)."
  value       = var.enable_service_mesh ? google_gke_hub_feature.servicemesh[0].name : null
}

###############################################################################
# Audit summary — surfaced to humans during apply
###############################################################################

output "decision_audit" {
  description = "Decision-trace map. Pulled by /sc:reflect and the audit report renderer."
  value = {
    D13 = "Global multi-region active-active wired across ${join(", ", keys(var.regions))}"
    D14 = "Deterministic NAT IPs per region: ${join(", ", [for r in keys(var.regions) : "${r}=${var.regions[r].nat_ip_count}"])}"
    D19 = "IAP brand=${google_iap_brand.internal.name}, clients=${length(google_iap_client.internal)}"
    D20 = "VPC-SC perimeter=${google_access_context_manager_service_perimeter.core.name}, dry_run=${var.vpc_sc_dry_run}, restricted=${length(var.vpc_sc_restricted_services)} services"
    D21 = "Cloud Armor adaptive=${var.armor_adaptive_protection}, preview=${var.armor_enable_preview}"
    D26 = "DNS zones=${join(",", keys(var.dns_zones))}, managed cert domains=${length(var.managed_cert_domains)}"
    D31 = "Service Mesh enabled=${var.enable_service_mesh}, SSL policy=MODERN/TLS1.2"
  }
}
