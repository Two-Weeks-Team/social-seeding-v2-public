# security_watch.spec.md (W3)

## 1. Purpose + ARCHITECTURE.md citation

The **Security Watch agent (W3)** subscribes to Model Armor block events and Chronicle SecOps alerts, decides severity (info/warn/page/quarantine) and — at threshold — quarantines the offending tenant (Identity Platform tenant suspended for agent invocations until cleared by the on-call). Gemini 2.5 Flash for the rationale step over deterministic signals; the action layer is rule-based + KMS-signed.

- **D-ID coverage**: D23 (Tier-3 W3), D21 (Model Armor max policy — input signals), D32 (Chronicle SecOps SIEM), D20 (CMEK + Secret Manager — quarantine flips tenant key access).
- **ARCHITECTURE.md §3 row 22**: `security_watch (W3) | 3 | Gemini 2.5 Flash | model_armor.query_blocks, chronicle.query, tenant.quarantine | None | TTR (time to remediate)`.
- **v2 reference**: No v2 predecessor; v2 had no security agents.

## 2. JSON Schema (input/output)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.social-seeding.com/v2/agents/security_watch.schema.json",
  "title": "SecurityWatchAgent",
  "$defs": {
    "ThreatKind": {
      "type": "string",
      "enum": [
        "model_armor_pi","model_armor_jb","model_armor_pii","model_armor_rai",
        "custom_competitor_regex","custom_brand_regex","prompt_injection_chain",
        "credential_exfiltration","abuse_pattern","compliance_block_storm",
        "chronicle_high_severity","chronicle_critical","unauthorized_a2a_call"
      ]
    },
    "Decision": {
      "type": "string",
      "enum": ["log_only","warn","page_oncall","quarantine_tenant","disable_workspace"]
    }
  },
  "type": "object",
  "properties": {
    "Input": {
      "type": "object",
      "required": ["threatKind","tenantId","detectedAt","evidence"],
      "properties": {
        "threatKind":  { "$ref": "#/$defs/ThreatKind" },
        "tenantId":    { "type": "string" },
        "workspaceId": { "type": "string" },
        "agentId":     { "type": "string" },
        "detectedAt":  { "type": "string", "format": "date-time" },
        "evidence": {
          "type": "object",
          "properties": {
            "armorBlockIds":     { "type": "array", "items": { "type": "string" } },
            "chronicleAlertIds": { "type": "array", "items": { "type": "string" } },
            "rawExcerpts":       { "type": "array", "items": { "type": "string" }, "description": "DLP-redacted" },
            "patternFingerprint":{ "type": "string" }
          }
        },
        "metadata":    { "$ref": "https://schemas.social-seeding.com/v2/common/shared.schema.json#/$defs/InvocationMetadata" }
      }
    },
    "Output": {
      "type": "object",
      "required": ["decision","severity","rationale"],
      "properties": {
        "decision":    { "$ref": "#/$defs/Decision" },
        "severity":    { "type": "string", "enum": ["info","warn","page"] },
        "rationale":   { "type": "string", "minLength": 20, "maxLength": 1200 },
        "actionTakenAt": { "type": "string", "format": "date-time" },
        "quarantineUntil": { "type": "string", "format": "date-time" },
        "remediationRunbookId": { "type": "string" },
        "chronicleCaseId": { "type": "string" }
      }
    }
  }
}
```

## 3. OpenAPI 3.1 (REST surface)

```yaml
openapi: 3.1.0
info: { title: SecurityWatchAgent, version: 0.1.0 }
servers:
  - $ref: '../_common/shared.openapi.yaml#/servers/0'
paths:
  /agents/security-watch:invoke:
    post:
      operationId: invokeSecurityWatch
      summary: Decide on a security signal — log / warn / page / quarantine.
      parameters:
        - $ref: '../_common/shared.openapi.yaml#/components/parameters/TenantHeader'
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: 'https://schemas.social-seeding.com/v2/agents/security_watch.schema.json#/properties/Input' }
      responses:
        '200':
          description: Decision rendered.
          content:
            application/json:
              schema: { $ref: 'https://schemas.social-seeding.com/v2/agents/security_watch.schema.json#/properties/Output' }
        '403':
          description: Caller not in security service account allowlist.
          content:
            application/problem+json:
              schema: { $ref: '../_common/shared.openapi.yaml#/components/schemas/Problem' }
      security:
        - AgentIdentitySPIFFE: []
        - WorkforceIF: ["agent.admin"]
```

## 4. AsyncAPI 3.0 (Pub/Sub events)

```yaml
asyncapi: 3.0.0
info: { title: SecurityWatch.Events, version: 0.1.0 }
channels:
  system.armor.input_blocked:  { $ref: '../_common/shared.asyncapi.yaml#/channels/system.armor.input_blocked' }
  system.armor.output_blocked: { $ref: '../_common/shared.asyncapi.yaml#/channels/system.armor.output_blocked' }
  chronicle.alert:
    address: chronicle.alert
    messages:
      ChronicleAlert:
        payload:
          type: object
          required: [alertId, tenantId, severity, detectedAt]
          properties:
            alertId:    { type: string }
            tenantId:   { type: string }
            severity:   { type: string, enum: [low, medium, high, critical] }
            detectedAt: { type: string, format: date-time }
            rule:       { type: string }
  watchdog.security.actioned:
    address: watchdog.security.actioned
    messages:
      Actioned:
        payload:
          type: object
          required: [tenantId, decision, severity, actionTakenAt]
          properties:
            tenantId:        { type: string }
            decision:        { type: string }
            severity:        { type: string }
            actionTakenAt:   { type: string, format: date-time }
            quarantineUntil: { type: string, format: date-time }
            chronicleCaseId: { type: string }
operations:
  consumeArmorBlock:
    action: receive
    channel: { $ref: '#/channels/system.armor.input_blocked' }
  consumeChronicleAlert:
    action: receive
    channel: { $ref: '#/channels/chronicle.alert' }
  publishActioned:
    action: send
    channel: { $ref: '#/channels/watchdog.security.actioned' }
```

## 5. Mermaid sequence diagram (happy path)

```mermaid
sequenceDiagram
  participant MA as Model Armor
  participant CH as Chronicle SecOps
  participant PS as Pub/Sub
  participant WF as Cloud Workflows (security-handler)
  participant AG as Agent Gateway
  participant SW as security-watch agent (Gemini 2.5 Flash)
  participant MQ as model_armor.query_blocks
  participant CQ as chronicle.query
  participant TQ as tenant.quarantine
  participant PD as PagerDuty

  MA->>PS: publish system.armor.input_blocked (PI+JB regex)
  PS->>WF: deliver
  WF->>AG: POST /agents/security-watch:invoke (threatKind=model_armor_pi, evidence)
  AG->>SW: invoke
  SW->>MQ: count(blocks last 1h, tenant)
  MQ-->>SW: 27 blocks in 60min (baseline: 0-2)
  SW->>CQ: query(alerts last 1h, tenant)
  CQ-->>SW: 1 high-severity alert (correlated)
  SW->>SW: Reason: pattern is abuse_pattern; severity=page; decision=quarantine_tenant (D21 auto-block threshold)
  SW->>TQ: quarantine(tenantId, durationHours=2)
  TQ-->>SW: quarantineUntil
  SW-->>AG: { decision: quarantine_tenant, severity: page, quarantineUntil }
  AG-->>WF: 200 OK
  AG->>PS: publish watchdog.security.actioned
  AG->>PD: page on-call (sec)
  PS->>CH: open case (chronicleCaseId)
```

## 6. Tool list + USD cap + escalation conditions

| Tool | Capability | Purpose |
|---|---|---|
| `model_armor.query_blocks` | Model Armor API | Block history per tenant |
| `chronicle.query` | Chronicle SecOps | Cross-source alerts |
| `tenant.quarantine` | Identity Platform | Suspend tenant agent invocations |
| `tenant.disable_workspace` | Spanner + IAM | Surgical workspace suspension |
| `pagerduty.incident` | PagerDuty | Sec-on-call paging |
| `chronicle.open_case` | Chronicle | Audit case opening |

**USD cap**: $0.10 per signal (Flash + 2-3 tool calls; security decisions need full evidence chain).

**Escalation conditions**:
- Chronicle backend unavailable — degrade to log_only + page on-call.
- Identity Platform `tenant.quarantine` fails — escalate to disable_workspace + page.
- Threat kind unknown — default decision=warn + log_only.
- Decision flips mid-evaluation (race with operator manual unblock) — accept human override; record both.

## 7. Eval criteria

| Metric | Threshold |
|---|---|
| `time_to_remediate (TTR)` | ≤ 90 sec (signal → action) |
| `false_quarantine_rate` | ≤ 0.001 (1 per 1000 signals) |
| `missed_critical_rate` | = 0 |
| `chronicle_case_completeness` | ≥ 0.95 evidence fields populated |

**Golden set**: `tests/golden/security_watch/*.json` — 80 signal traces (real + chaos + adversarial replays).

## 8. Edge cases

1. **Tenant in active demo recording (D30)** — flag `demo_window`; downgrade `page` to `warn` unless threatKind ∈ {credential_exfiltration, chronicle_critical}.
2. **Cross-tenant pattern**: same pattern across 5 tenants — escalate to **disable_workspace** for impacted workspaces + page; not the tenants.
3. **Quarantine for already-quarantined tenant** — extend quarantineUntil; do not double-page.
4. **False positive from a known integration partner** — Memory bank-of-context (W3 keeps allow/deny list); skip quarantine, log_only.
5. **Model Armor + Compliance double-block on same draft** — only one signal should trigger; dedupe via patternFingerprint.
6. **Pages exceed PagerDuty rate limit** — fall back to Slack high-severity channel.
7. **Recursive: security_watch's own LLM call gets Model Armor blocked** — defensive: tool layer returns "armor self-bypass", agent emits decision=log_only + escalate to human.
