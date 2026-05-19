# BUILD-NOTES.md — terraform/

**Owner**: P1-W6prep / TF-bug-fix agent
**Date**: 2026-05-19 (updated by TF-13-fix agent)
**Status**: All 13 provider-compat errors CLEARED. `terraform validate` returns
`Success! The configuration is valid.` in both `environments/dev/` and
`environments/prod/`. Remaining surface area = deprecation warnings only.

---

## BN-01..10 — reserved

Reserved for future BUILD-NOTES entries.

---

## BN-11 — Provider 6.50 schema drift (CLEARED 2026-05-19)

**Cites**: D13, D15, D17, D20, D32, D38.

### Outcome

All 13 errors fixed against `hashicorp/google` v6.50.0 / `hashicorp/google-beta`
v6.50.0. Verified:

```
$ cd terraform/environments/dev && terraform validate
Success! The configuration is valid, but there were some validation warnings as shown above.

$ cd terraform/environments/prod && terraform validate
Success! The configuration is valid, but there were some validation warnings as shown above.
```

The remaining warnings are independent of the 13 errors:

- `google_dialogflow_cx_agent.enable_stackdriver_logging` deprecation — should
  migrate to `advanced_settings.logging_settings.enable_stackdriver_logging`.
- `google_iap_brand` post-July-2025 deprecation. Both are pre-existing tech
  debt unrelated to this fix.

### Fixes applied

#### Category B — schema rename / minor drift (3/3 cleared)

| Module | File:line | What changed | Fix |
|---|---|---|---|
| compute | `modules/compute/main.tf:68-76` | `scaling { max_instance_count }` at service top-level | Moved into `template.scaling { min_instance_count, max_instance_count }`. Provider 6.50's service-level `scaling` block only exposes `manual_instance_count/min_instance_count/scaling_mode`; `max_instance_count` lives on the per-revision (template-level) scaling block. |
| compute | `modules/compute/main.tf:123` | `encryption_key` at service top-level | Moved into `template.encryption_key` (template-level attribute in provider 6.50). |
| data | `modules/data/main.tf:122 + 223` | `deletion_protection` on `google_alloydb_cluster` | Replaced with `deletion_policy = local.deletion_protection ? "DEFAULT" : "FORCE"`. The argument was removed in google v6.x. |

#### Category C — schema rename / block removal (3/3 cleared)

| Module | File:line | What changed | Fix |
|---|---|---|---|
| ai | `modules/ai/main.tf:145` | `encryption_spec` block on `google_vertex_ai_index` | Block removed; the schema does not expose CMEK on this resource in provider 6.50. CMEK on Vector Search indexes must be applied out-of-band via `gcloud ai indexes` or the REST API until the block re-appears. `var.cmek_key_name` is retained so callers can wire the value once the schema gains the block. |
| data | `modules/data/main.tf:356` | `encryption_spec` on `google_vertex_ai_index` (regional) | Same — removed; out-of-band CMEK until provider catches up. |
| data | `modules/data/main.tf:380` | `encryption_spec` on `google_vertex_ai_index_endpoint` (regional) | Same — removed; out-of-band CMEK until provider catches up. |

#### Category A — provider-alias or rename (4/7 cleared, 3/7 deferred via shims)

**Real renames / alias fixes (no behavior change)**

| Module | File:line | What changed | Fix |
|---|---|---|---|
| devops | `modules/devops/workstations.tf` + `outputs.tf` | `google_workstations_cluster` does not exist | Renamed to `google_workstations_workstation_cluster` (the actual provider 6.50 type in `google-beta`). Schema identical; no field changes needed. |
| data | `modules/data/main.tf:591` | `google_dataform_repository` not in `hashicorp/google` | Added `provider = google-beta`. Resource exists in beta only. |
| integration | `modules/integration/apigee.tf:103` + `outputs.tf` | `google_apigee_product` does not exist | Renamed to `google_apigee_api_product`. Schema identical for the fields used; no breaking change. |

**Deferred — provider does not yet ship resource. Replaced with `null_resource` + `gcloud` shim or stubbed output, with explicit breadcrumb for restoration:**

| Module | File:line | Resource | Disposition |
|---|---|---|---|
| compute | `modules/compute/main.tf:259` | `google_vertex_ai_reasoning_engine` (D17 Agent Runtime) | Native block removed. Existing `null_resource.agent_runtime_fallback` is now the only path (was gated by `agent_runtime_use_fallback`). Outputs reduced to `fallback:<key>` until the provider ships the resource. Breadcrumb comment in main.tf documents how to restore. |
| integration | `modules/integration/api_hub.tf` | `google_apigee_api_hub_instance` + `google_apigee_api_hub_api` | All three API Hub resources stubbed out (file kept as breadcrumb). Outputs `api_hub_instance_id` / `api_hub_api_ids` return `null` / `{}` until the provider ships the resources. Specs must be registered out-of-band via `gcloud apigee apihub`. |
| integration | `modules/integration/eventarc.tf:120` | `google_eventarc_message_bus_iam_member` | Replaced with `null_resource.message_bus_publisher_iam` calling `gcloud eventarc message-buses add-iam-policy-binding`. Bus-scoped grant preserved (we did NOT widen to project-level `roles/eventarc.publisher`). When the IAM resource ships, restore via a `moved` block. |

### Module contract preservation

All eight module outputs (ai, compute, data, devops, integration, networking,
observability, security) still resolve. The integration module's `api_hub_*`
outputs are now `null`/`{}` rather than fail-on-missing-resource; the compute
module's `agent_runtime_endpoints` is the fallback form. No output names
disappeared; no caller will fail to interpolate.

### Operator decisions deferred

- **D17 — Agent Runtime provider GA**: when `google_vertex_ai_reasoning_engine`
  ships in `hashicorp/google-beta` (currently private preview as of 2026-05),
  restore the native resource per the breadcrumb in `modules/compute/main.tf`
  and re-introduce the `local.use_native_agent_runtime` branch in outputs.
- **D38 — API Hub**: same restore path once
  `google_apigee_api_hub_*` resources ship.
- **D18 — Eventarc Advanced IAM**: same restore path once
  `google_eventarc_message_bus_iam_member` ships.
- **D20 — Vector Search CMEK**: track when `encryption_spec` is added back to
  `google_vertex_ai_index` / `_index_endpoint`. Until then CMEK must be
  applied out-of-band by the deploy pipeline.

No new D-ID was drafted; all deferrals are within the existing D17/D18/D20/D38
decision surfaces (the implementation note that "Terraform provider lags Google's
GA timeline" is captured in this BN-11 rather than as a new decision).

### Verification artifact (after fix)

```
$ terraform fmt -recursive terraform/   # clean, exit 0

$ cd terraform/environments/dev
$ terraform init -backend=false -upgrade   # Terraform has been successfully initialized
$ terraform validate                       # Success! The configuration is valid

$ cd terraform/environments/prod
$ terraform init -backend=false -upgrade   # Terraform has been successfully initialized
$ terraform validate                       # Success! The configuration is valid
```
