# networking — TF-Module-3

> Shared VPC + global HTTPS Load Balancer + Cloud Armor + Cloud NAT (deterministic IPs)
> + Cloud DNS + Certificate Manager + IAP + VPC Service Controls + Private Service Connect
> + Cloud Service Mesh enablement.
>
> Source brief: `/Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/network-security/NETSEC.md`
> Decision anchors: **D13** (global active-active), **D14** (deterministic egress for RapidAPI),
> **D19** (IAP / Workforce IF), **D20** (VPC-SC + CMEK + DLP), **D26** (Cloud DNS surfaces),
> **D31** (Enterprise SLO -> Cloud Service Mesh mTLS).

---

## What this module owns

| Resource | Decision | Notes |
|---|---|---|
| 1× Shared VPC (`ss-shared-infra`) | D20 | Host project + N service projects, `auto_create_subnetworks=false`, `GLOBAL` routing |
| 3× regional workload subnets (`us-central1`, `europe-west1`, `asia-northeast3`) | D13 | Private Google Access on, secondary ranges `pods` + `services`, VPC flow logs at 50% sampling |
| 3× regional PSC consumer subnets | D20 | Distinct subnets per NETSEC §1.5 best practice |
| 3× Cloud Routers + Cloud NAT | D14 | `MANUAL_ONLY` allocation, static IP pool sized per region, endpoint-independent mapping |
| Global HTTPS LB (`EXTERNAL_MANAGED`) | D13, D31 | `timeout_sec=600` for streaming LLM responses, HTTP→HTTPS redirect, QUIC enabled |
| Cloud Armor edge policy | D21 | CRS 3.3 SQLi/XSS/LFI/RCE + per-IP rate limit on `/api/agent/run` + adaptive protection |
| Cloud CDN (origin-headers mode) | D13 | Negative caching on; `Cache-Control: no-store` from origin keeps prompts off edge |
| Certificate Manager managed cert + cert map | D26 | DNS-authorized; covers `app/api/admin/mcp.socialseed.ing` by default |
| Modern SSL policy | NETSEC §1.1 | `MODERN` profile, `TLS_1_2` minimum |
| Public + private Cloud DNS zones | D26 | DNSSEC on public zones; private zone bound to the Shared VPC |
| IAP brand + per-endpoint OAuth clients | D19 | Mission Control admin, Dialogflow CX admin, Agent Gateway debug |
| Private Service Connect endpoint per region | D20 | All-APIs bundle so Vertex AI calls stay on Google backbone |
| VPC Service Controls perimeter | D20 | `aiplatform/spanner/firestore/storage/bigquery/secretmanager/cloudkms/pubsub/run` restricted; starts in dry-run |
| Cloud Service Mesh fleet feature | D31 | Enables managed control plane; data plane attached by TF-Module-2 |
| Minimal firewall set | NETSEC §1.5, §1.8 | IAP TCP forwarding + GFE health-check ranges allowed; `no-direct-internet` tag forces NAT egress |

Total managed resources: ~55 at default `regions` map (3 regions × 3 NAT IPs each).

---

## What this module deliberately does NOT own

- **Backends behind the LB** — TF-Module-2 (compute) owns Cloud Run / GKE / Agent Runtime NEGs and appends them to `default_backend_service_id` via `lifecycle.ignore_changes = [backend]` on this side.
- **CMEK keyrings** — TF-Module-7 (security) owns Cloud KMS rings per D20; this module only references them indirectly through perimeter membership.
- **DLP inspect templates** — TF-Module-7 owns SDP templates per D20; this module only opens the perimeter that protects them.
- **Per-tenant Identity Platform tenants** — TF-Module-7 owns Identity Platform per D19.
- **Pub/Sub topics, Workflows, Eventarc** — TF-Module-8 (integration) owns those per D18.
- **GKE / Cloud Run service-level mesh sidecar injection** — TF-Module-2 attaches the mesh data plane to specific clusters; this module just enables the fleet feature.

---

## Required inputs

| Variable | Required | Example |
|---|---|---|
| `host_project_id` | yes | `ss-shared-infra` |
| `access_policy_id` | yes (for VPC-SC) | `123456789012` |
| `iap_brand_support_email` | yes | `ops@socialseed.ing` |
| `service_project_ids` | usually | `["ss-v2-prod-us", "ss-v2-prod-eu", "ss-v2-prod-apac"]` |

The full schema lives in `variables.tf`.

---

## Outputs other modules will read

| Output | Consumer |
|---|---|
| `vpc_id`, `subnetwork_ids`, `subnetwork_secondary_ranges` | TF-Module-2 (compute) — Cloud Run + GKE attach here |
| `nat_ip_addresses` | TF-Module-7 (security) — hands to RapidAPI allowlist (D14) |
| `default_backend_service_id`, `url_map_id`, `security_policy_id` | TF-Module-2 — attaches Cloud Run NEGs + per-tenant URL maps |
| `certificate_map_id` | TF-Module-2 — appends per-tenant subdomains |
| `service_perimeter_name` | TF-Module-7 — attaches IAM conditions |
| `psc_endpoint_ips` | TF-Module-5 (AI) — Agent Runtime egress to Vertex via PSC |
| `iap_brand_name`, `iap_clients` | TF-Module-2 — wires IAP onto Cloud Run revisions |
| `service_mesh_feature` | TF-Module-2 — joins GKE clusters / Cloud Run revisions to the mesh |

---

## Bootstrap order (first apply)

1. Apply this module with `vpc_sc_dry_run = true` and `armor_enable_preview = true`. The perimeter and WAF land in audit-only mode so legitimate traffic patterns surface in Cloud Logging without being blocked (NETSEC §1.4, §1.5).
2. Operator copies the emitted `dns_authorization_records` CNAMEs into the apex DNS for the cert domains (or upstream registrar).
3. Wait for `google_certificate_manager_certificate.managed.state == "ACTIVE"` (typically <15 min once DNS resolves).
4. Apply TF-Module-2 (compute). It populates the backend service.
5. After 7 days of clean audit logs, flip `vpc_sc_dry_run = false` and `armor_enable_preview = false`. Re-apply. This is the only intentional cutover and should be its own change request.

---

## Known landmines / non-obvious behaviour

- **PSC `target = "vpc-sc"`** uses the all-Google-APIs bundle. If you only want a subset, swap to a per-service NEG; that lands in TF-Module-2 once we know which services need it.
- **`google_compute_backend_service.agent_api`** has `lifecycle.ignore_changes = [backend]`. Compute module owns backend membership. Do not add `backend {}` blocks here; you will fight Terraform.
- **VPC-SC dynamic blocks** — the `spec` block (dry-run) and `status` block (enforce) are mutually exclusive in this module via the `for_each` switch. The `lifecycle.ignore_changes = [status[0].egress_policies, status[0].ingress_policies]` means TF-Module-7 can manage granular ingress / egress separately without us fighting over the list.
- **NAT IPs** are reserved with `lifecycle.create_before_destroy = true`. Increasing `nat_ip_count` is safe; decreasing it will rotate an IP RapidAPI knows about — coordinate the change with the integrations team (D14 dependency).
- **Cloud Armor rate limit on `/api/agent/run`** is per-IP at 30 req/min by default. This is a *cost shield* (D21) not a UX feature — tenants behind a single corporate proxy will share the budget. Tune `armor_rate_limit_threshold` per tenant SLO.
- **Cloud Service Mesh fleet feature** is `global` location only. Memberships (cluster join) are added by TF-Module-2.
- The deny-all egress firewall is **target-tagged** (`no-direct-internet`) rather than universal, so existing GCP-managed services that need direct egress (e.g. Cloud Build runners on launch) are not disrupted. Compute module attaches the tag to workload VMs / GKE node pools.

---

## Cost ballpark (D39 envelope: $1,500)

| Line item | Notes | Rough monthly |
|---|---|---|
| 9 reserved external IPs (3 regions × 3) | $0.005/h each unused, free when in use behind NAT | $0–$30 |
| Global LB + 1 forwarding rule | $0.025/h base + $0.008/GB | $30+ |
| Cloud Armor edge policy | $5/policy/month + $0.75/M requests | $20+ |
| Cloud NAT | $0.044/h per gateway × 3 regions = ~$95/mo + data | $100–$150 |
| Cloud DNS public + private | $0.20/zone + $0.40/M queries | <$5 |
| Certificate Manager | Free (managed certs) | $0 |
| Private Service Connect | Free for endpoints, $0.01/GB data | <$10 |
| Cloud Service Mesh | Free control plane (managed) | $0 |
| **Subtotal — networking** | | **~$170/mo** |

Comfortably inside the $50–$80/mo per-region target from COST-PLAN.md.

---

## Decision citations

- **D13** — `gcp-research/decisions/DECISIONS.md` §Round 1 (Global multi-region active-active).
- **D20** — `gcp-research/decisions/DECISIONS.md` §Round 3 (CMEK + DLP + VPC-SC).
- **D31** — `gcp-research/decisions/DECISIONS.md` §Round 6 (Enterprise SLO -> Cloud Service Mesh).
- Service shapes — `gcp-research/decisions/SERVICE-INVENTORY.md` §5 Networking (all 9 ✅ services attached).
- Implementation patterns — `gcp-research/network-security/NETSEC.md` §1.1, §1.4, §1.5, §1.6, §1.7, §1.8, §1.9, §2.5.

---

## Example

```hcl
module "networking" {
  source = "../../modules/networking"

  host_project_id     = "ss-shared-infra"
  service_project_ids = ["ss-v2-prod-us", "ss-v2-prod-eu", "ss-v2-prod-apac"]
  access_policy_id    = "123456789012"

  iap_brand_support_email = "ops@socialseed.ing"
  iap_member_groups       = ["group:agent-operators@socialseed.ing"]

  # Stage 1 — observe before enforcing.
  vpc_sc_dry_run       = true
  armor_enable_preview = true
}
```

See `examples/basic/` for the full minimal-viable invocation.
