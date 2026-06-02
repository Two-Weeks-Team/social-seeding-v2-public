# customer_success.spec.md

## 1. Purpose + ARCHITECTURE.md citation

The **Customer Success agent** watches per-customer onboarding + activation signals and proposes interventions (in-app prompt, email, white-glove call). Inputs: funnel metrics from BigQuery, recent campaign outcomes, support-ticket signals, billing posture. Outputs: ranked intervention candidates with rationale + auto-executable plan when within autonomy bounds. Strictly proposes — sending the intervention requires `approveStageAdvance` or human OK.

- **D-ID coverage**: D23 (NEW Tier-1 agent #16), D5 (Gemini 3.5 Flash), D28 ($0.01/view pricing — agent watches usage curves), D32 (intervention-as-runbook on Cloud Workflows), D26 (Mission Control surfaces proposed interventions).
- **ARCHITECTURE.md §3 row 16**: `customer_success (NEW) | 1 | Gemini 3.5 Flash | analytics.funnel, intervention.propose | Memory Bank (per-customer) | activation_lift`.
- **v2 reference**: New agent — no v2 predecessor. Reads `v2_campaigns`, `v2_cost_ledger`, `v2_audit_events`.

## 2. JSON Schema (input/output)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.social-seeding.com/v2/agents/customer_success.schema.json",
  "title": "CustomerSuccessAgent",
  "$defs": {
    "FrictionSignal": {
      "type": "string",
      "enum": [
        "intake_abandoned","first_campaign_stalled","outreach_unanswered_30d",
        "low_response_rate","budget_unused","verified_below_target",
        "support_tickets_open","payment_failed","feature_unused_45d",
        "churn_risk_score_high"
      ]
    },
    "InterventionKind": {
      "type": "string",
      "enum": ["in_app_nudge","email_drip","csm_call","credit_grant","template_swap","onboarding_replay","template_recommendation"]
    },
    "Intervention": {
      "type": "object",
      "required": ["kind","rationale","expectedLift","priority"],
      "properties": {
        "kind":         { "$ref": "#/$defs/InterventionKind" },
        "rationale":    { "type": "string", "minLength": 20, "maxLength": 800 },
        "expectedLift": { "type": "number", "minimum": 0, "maximum": 1, "description": "Probability of resolving friction within 14d" },
        "priority":     { "type": "string", "enum": ["high","medium","low"] },
        "automation":   { "type": "string", "enum": ["auto_execute","needs_review","csm_handoff"] },
        "playbookId":   { "type": "string", "description": "Cloud Workflows runbook id to invoke" }
      }
    }
  },
  "type": "object",
  "properties": {
    "Input": {
      "type": "object",
      "required": ["tenantId","workspaceId"],
      "properties": {
        "tenantId":    { "type": "string" },
        "workspaceId": { "type": "string" },
        "windowDays":  { "type": "integer", "minimum": 1, "maximum": 90, "default": 30 },
        "campaignSummaries": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "campaignId":    { "type": "string" },
              "status":        { "type": "string" },
              "verifiedCount": { "type": "integer", "minimum": 0 },
              "target":        { "type": "integer", "minimum": 0 },
              "spentUsd":      { "type": "number", "minimum": 0 }
            }
          }
        },
        "supportTicketIds": { "type": "array", "items": { "type": "string" } },
        "billingPosture": {
          "type": "object",
          "properties": {
            "lastPaymentSucceeded": { "type": "boolean" },
            "monthlyCommitUsd":     { "type": "number" },
            "monthSpendUsd":        { "type": "number" }
          }
        },
        "metadata": { "$ref": "https://schemas.social-seeding.com/v2/common/shared.schema.json#/$defs/InvocationMetadata" }
      }
    },
    "Output": {
      "type": "object",
      "required": ["signals","interventions","summary"],
      "properties": {
        "signals":       { "type": "array", "items": { "$ref": "#/$defs/FrictionSignal" } },
        "churnRiskScore":{ "type": "number", "minimum": 0, "maximum": 1 },
        "interventions": { "type": "array", "items": { "$ref": "#/$defs/Intervention" }, "minItems": 0, "maxItems": 5 },
        "summary":       { "type": "string", "minLength": 20, "maxLength": 600 }
      }
    }
  }
}
```

## 3. OpenAPI 3.1 (REST surface)

```yaml
openapi: 3.1.0
info: { title: CustomerSuccessAgent, version: 0.1.0 }
servers:
  - $ref: '../_common/shared.openapi.yaml#/servers/0'
paths:
  /agents/customer-success:invoke:
    post:
      operationId: invokeCustomerSuccess
      summary: Detect activation friction + propose interventions.
      parameters:
        - $ref: '../_common/shared.openapi.yaml#/components/parameters/TenantHeader'
        - $ref: '../_common/shared.openapi.yaml#/components/parameters/TraceParent'
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: 'https://schemas.social-seeding.com/v2/agents/customer_success.schema.json#/properties/Input' }
      responses:
        '200':
          description: Signals + interventions.
          content:
            application/json:
              schema: { $ref: 'https://schemas.social-seeding.com/v2/agents/customer_success.schema.json#/properties/Output' }
        '422':
          description: Escalated (insufficient_signal).
          content:
            application/json:
              schema: { $ref: '../_common/shared.openapi.yaml#/components/schemas/AgentEscalation' }
```

## 4. AsyncAPI 3.0 (Pub/Sub events)

```yaml
asyncapi: 3.0.0
info: { title: CustomerSuccess.Events, version: 0.1.0 }
channels:
  agent.t1.customer_success.recommended:
    address: agent.t1.customer_success.recommended
    messages:
      InterventionRecommended:
        payload:
          type: object
          required: [tenantId, workspaceId, interventionCount, churnRiskScore]
          properties:
            tenantId:           { type: string }
            workspaceId:        { type: string }
            interventionCount:  { type: integer }
            churnRiskScore:     { type: number }
            signals:            { type: array, items: { type: string } }
            usdSpent:           { type: number }
  intervention.executed:
    address: intervention.executed
    description: When auto_execute fires.
    messages:
      InterventionExecuted:
        payload:
          type: object
          required: [tenantId, kind, playbookId, executedAt]
          properties:
            tenantId:    { type: string }
            workspaceId: { type: string }
            kind:        { type: string }
            playbookId:  { type: string }
            executedAt:  { type: string, format: date-time }
operations:
  publishRecommended:
    action: send
    channel: { $ref: '#/channels/agent.t1.customer_success.recommended' }
  publishExecuted:
    action: send
    channel: { $ref: '#/channels/intervention.executed' }
```

## 5. Mermaid sequence diagram (happy path)

```mermaid
sequenceDiagram
  participant CR as Cloud Scheduler (daily)
  participant WF as Cloud Workflows (cs-sweep)
  participant AF as analytics.funnel
  participant BQ as BigQuery (v2_audit_events / v2_cost_ledger)
  participant AG as Agent Gateway
  participant CS as customer-success agent
  participant MB as Memory Bank (per-customer history)
  participant IP as intervention.propose
  participant PS as Pub/Sub
  participant SP as Spanner v2_cs_interventions
  participant MC as Mission Control

  CR->>WF: tick (per tenant)
  WF->>AF: funnel(tenantId, windowDays=30)
  AF->>BQ: SELECT funnel + cost + ticket counts
  BQ-->>AF: rows
  AF-->>WF: campaignSummaries[]
  WF->>AG: POST /agents/customer-success:invoke
  AG->>CS: invoke (Gemini 3.5 Flash)
  CS->>MB: read prior interventions + outcomes
  MB-->>CS: history
  CS->>CS: Detect signals (10-class enum)
  CS->>CS: churnRiskScore (0-1 logistic of signals)
  CS->>IP: propose(signals, playbook library)
  IP-->>CS: candidate interventions
  CS->>CS: Rank + cap at 5; assign automation level by autonomy policy
  CS-->>AG: { signals, interventions, summary }
  AG-->>WF: 200 OK
  AG->>SP: persist v2_cs_interventions
  AG->>PS: publish agent.t1.customer_success.recommended
  alt intervention.automation == "auto_execute"
    WF->>WF: invoke playbookId runbook (e.g., grant trial credit, drip email)
    WF->>PS: publish intervention.executed
  else
    WF->>MC: surface "CSM action queue"
  end
```

## 6. Tool list + USD cap + escalation conditions

| Tool | Capability | Purpose |
|---|---|---|
| `analytics.funnel` | BigQuery query | Per-tenant funnel rollup |
| `intervention.propose` | playbook library | Maps signals to candidate interventions |
| `billing.query` | BigQuery | Payment posture |
| `support.list_tickets` | Zendesk / GCP CRM | Recent support volume signal |

**USD cap**: $0.50 per invocation. Gemini 3.5 Flash with structured reasoning over multi-source signals.

**Escalation conditions**:
- `campaignSummaries` empty AND `windowDays >= 14` (new workspace; not enough signal).
- `billingPosture.lastPaymentSucceeded == false` AND no recent activity (probable churn — needs CSM call, not auto-action).
- Memory Bank shows ≥3 prior failed interventions of same kind (signal: model needs different playbook).
- Translation API failure (operator locale ≠ ko/en) — escalate to skip; rerun in operator's locale.

```python
class Intervention(BaseModel):
    kind: Literal["in_app_nudge","email_drip","csm_call","credit_grant","template_swap","onboarding_replay","template_recommendation"]
    rationale: str = Field(min_length=20, max_length=800)
    expectedLift: float = Field(ge=0, le=1)
    priority: Literal["high","medium","low"]
    automation: Literal["auto_execute","needs_review","csm_handoff"]
    playbookId: str
```

## 7. Eval criteria (Vertex AI Agent Evaluation)

| Metric | Description | Threshold |
|---|---|---|
| `activation_lift` | Customers receiving interventions vs control group, 14-day activation delta | ≥ 10% |
| `signal_precision` | of detected friction signals, fraction confirmed by CSM review | ≥ 0.80 |
| `intervention_acceptance` | of `needs_review`, fraction CSM accepted | ≥ 0.65 |
| `false_churn_alarm` | High churn-risk but actually retained | ≤ 0.15 |
| `cost_per_workspace_swept` | Average USD per sweep | ≤ $0.40 |

**Golden set**: `tests/golden/customer_success/*.json` — 100 workspace snapshots across activation bands (new / activating / power user / at-risk / churned).

## 8. Edge cases

1. **Day-1 workspace** (just signed up, no campaigns yet) — agent returns `intake_abandoned` if no intake started; otherwise neutral.
2. **Power user with budget unused** — flag `budget_unused` but lower priority; recommendation is `template_recommendation` not `csm_call`.
3. **Payment failed AND high usage** — high-priority `csm_call` + `credit_grant`; auto-execute the grant if within tenant credit limit.
4. **Operator manually closed previous intervention** (rejected) — Memory Bank surfaces; don't propose the same kind for 30d.
5. **Multi-workspace tenant (enterprise)** — agent runs per-workspace; tenant rollup happens at a different surface (analyst-of-customer-success).
6. **Sensitive support tickets (legal threats, etc.)** — escalate `legal_signal`, never auto-execute; CSM only.
7. **Daily sweep cost cap exceeded** — cost_watch (W2) throttles; sweep skips lower-priority workspaces.
