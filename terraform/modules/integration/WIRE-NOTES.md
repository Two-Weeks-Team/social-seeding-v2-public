# WIRE-NOTES.md — agent endpoint wiring (D42)

Owner: W3. Anchors: **D17** (Vertex AI Agent Runtime), **D18** (Workflows +
Pub/Sub + Cloud Tasks + Eventarc), **D42** (Workflows YAML references agent
URLs via Terraform output injection — no hardcoded hostnames).

## 1. The contract

```
ai.agent_urls (map(string))         # Phase 0: https://stub.local/<id>; W7: real reasoningEngines URLs
  → integration.agent_urls (var)    # key-validated against the 22-agent registry + 2 sub-routes
    → user_env_var AGENT_URL_<ID>   # always populated on every google_workflows_workflow
    → args.agent_urls (runtime)     # injected by caller via `terraform output -json` (D42 literal)
```

YAML resolves each `call:` URL with:

```yaml
url: ${default(map.get(args.agent_urls, "<id>"), sys.get_env("AGENT_URL_<ID>"))}
```

`default()` picks runtime args first, env-var fallback second. Args path
satisfies D42 verbatim; env-var path keeps Eventarc-triggered runs working
when the CloudEvent body cannot template a map.

## 2. Allowed keys (24 total = 22 registry + 2 sub-routes)

- **Tier 1 (16)**: sourcing, vetting, outreach_writer, conversation,
  conversation_responder, logistics, content_verify, analyst, research,
  intake, lead_outreach_writer, payment_mandate, compliance, creative, a11y,
  customer_success.
- **Tier 2 (3)**: coordinator, critic, optimizer.
- **Tier 3 (3)**: anomaly_watch, cost_watch, security_watch.
- **Sub-routes (2)**: `extract_facts` (used by creator-track ≈ outreach_writer
  sub-call), `classify_reply` (≈ conversation sub-call). W7 either deploys
  distinct reasoningEngines for them or aliases to parent URLs; this module
  accepts either.

## 3. W7 hand-off

W7 (deploy phase) overwrites `ai.agent_urls` stubs with real URLs read from
the per-agent deploy markers at `gs://<staging>/runtime-markers/<id>.json`.
No edits to this module are needed — the value flows in automatically.

## 4. Verification before deploy

- `terraform plan` shows non-empty `user_env_vars["AGENT_URL_*"]` on every
  `google_workflows_workflow`.
- `grep -rE '^[^#]*https://' terraform/modules/integration/workflows/*.yaml`
  returns nothing (no hardcoded hostnames; D42 anchor).
- `gcloud workflows execute brand-campaign --data='{"agent_urls":{"sourcing":"https://example/x"}}'`
  hits the sourcing step against the supplied URL.
