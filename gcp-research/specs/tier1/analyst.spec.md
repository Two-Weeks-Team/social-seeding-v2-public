# analyst.spec.md

## 1. Purpose + ARCHITECTURE.md citation

The **Analyst agent** translates the deterministic `AnalyticsReport` (computed by `analytics.compile`) plus the original `CampaignBrief` into a human-readable narrative: `{summary, highlights, concerns, recommendations, markdown}`. No tools — the numbers are already in the input; the analyst's job is data-narration, not number-crunching. Concerns map 1:1 to fired report flags (`budget_exceeded`, `deadline_missed`, `low_response_rate`, `high_flake_rate`, `no_verified_yet`, `goal_met`).

- **D-ID coverage**: D23 (Tier-1 agent #8), D5 (Gemini 2.5 Pro), D25 (analyst feeds Agent Evaluation `accuracy + grounding score`), D32 (analyst output feeds the weekly report email via Eventarc).
- **ARCHITECTURE.md §3 row 8**: `analyst | 1 | Gemini 2.5 Pro | bigquery.query, view_metrics.aggregate | Memory Bank | accuracy + grounding score`.
- **v2 reference**: `packages/agents/src/analyst.agent.ts:61-155`. v2 used Haiku — ARCHITECTURE.md upgrades to Gemini 2.5 Pro for prose quality.

## 2. JSON Schema (input/output)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.social-seeding.com/v2/agents/analyst.schema.json",
  "title": "AnalystAgent",
  "$defs": {
    "ReportFlag": {
      "type": "string",
      "enum": ["budget_exceeded","deadline_missed","low_response_rate","high_flake_rate","no_verified_yet","goal_met"]
    },
    "AnalyticsReport": {
      "type": "object",
      "required": ["campaignId","brief","funnel","goals","reach","performance","cost","flags","generatedAt"],
      "properties": {
        "campaignId": { "type": "string" },
        "brief": {
          "type": "object",
          "required": ["name","category","deadline"],
          "properties": {
            "name":     { "type": "string" },
            "category": { "type": "string" },
            "deadline": { "type": "string", "format": "date-time" }
          }
        },
        "funnel": {
          "type": "object",
          "properties": {
            "candidate":         { "type": "integer", "minimum": 0 },
            "shortlisted":       { "type": "integer", "minimum": 0 },
            "outreach_sent":     { "type": "integer", "minimum": 0 },
            "in_conversation":   { "type": "integer", "minimum": 0 },
            "agreed":            { "type": "integer", "minimum": 0 },
            "address_collected": { "type": "integer", "minimum": 0 },
            "shipped":           { "type": "integer", "minimum": 0 },
            "delivered":         { "type": "integer", "minimum": 0 },
            "posted":            { "type": "integer", "minimum": 0 },
            "verified":          { "type": "integer", "minimum": 0 },
            "declined":          { "type": "integer", "minimum": 0 },
            "no_response":       { "type": "integer", "minimum": 0 },
            "flaked":            { "type": "integer", "minimum": 0 }
          }
        },
        "goals": {
          "type": "object",
          "properties": {
            "targetLivePosts": { "type": "integer", "minimum": 1 },
            "verifiedCount":   { "type": "integer", "minimum": 0 },
            "percentOfGoal":   { "type": ["number", "null"] },
            "daysToDeadline":  { "type": "number" },
            "goalMet":         { "type": "boolean" }
          }
        },
        "reach": {
          "type": "object",
          "properties": {
            "verifiedViews":           { "type": "integer", "minimum": 0 },
            "verifiedLikes":           { "type": "integer", "minimum": 0 },
            "verifiedComments":        { "type": "integer", "minimum": 0 },
            "verifiedShares":          { "type": "integer", "minimum": 0 },
            "weightedEngagementRate":  { "type": ["number", "null"] }
          }
        },
        "performance": {
          "type": "object",
          "properties": {
            "avgPerformanceScore":      { "type": ["number", "null"] },
            "medianPerformanceScore":   { "type": ["number", "null"] },
            "topPerformerCreatorId":    { "type": ["string", "null"] }
          }
        },
        "cost": {
          "type": "object",
          "properties": {
            "spentUsd":             { "type": "number", "minimum": 0 },
            "costPerVerifiedPost":  { "type": ["number", "null"] },
            "budgetUsd":            { "type": ["number", "null"] },
            "percentOfBudget":      { "type": ["number", "null"] }
          }
        },
        "tracks":     { "type": "array", "items": { "type": "object" } },
        "flags":      { "type": "array", "items": { "$ref": "#/$defs/ReportFlag" } },
        "generatedAt":{ "type": "string", "format": "date-time" }
      }
    }
  },
  "type": "object",
  "properties": {
    "Input": {
      "type": "object",
      "required": ["brief","report"],
      "properties": {
        "brief":           { "$ref": "https://schemas.social-seeding.com/v2/agents/sourcing.schema.json#/properties/Input/properties/brief" },
        "report":          { "$ref": "#/$defs/AnalyticsReport" },
        "creatorHandles":  { "type": "object", "additionalProperties": { "type": "string" } },
        "locale":          { "$ref": "https://schemas.social-seeding.com/v2/common/shared.schema.json#/$defs/Locale" },
        "metadata":        { "$ref": "https://schemas.social-seeding.com/v2/common/shared.schema.json#/$defs/InvocationMetadata" }
      }
    },
    "Output": {
      "type": "object",
      "required": ["summary","recommendations","markdown"],
      "properties": {
        "summary":         { "type": "string", "minLength": 20, "maxLength": 600 },
        "highlights":      { "type": "array", "items": { "type": "string", "minLength": 5, "maxLength": 280 }, "maxItems": 4 },
        "concerns":        { "type": "array", "items": { "type": "string", "minLength": 5, "maxLength": 280 }, "maxItems": 4 },
        "recommendations": { "type": "array", "items": { "type": "string", "minLength": 5, "maxLength": 280 }, "minItems": 1, "maxItems": 3 },
        "markdown":        { "type": "string", "minLength": 50, "maxLength": 8000 }
      }
    }
  }
}
```

## 3. OpenAPI 3.1 (REST surface)

```yaml
openapi: 3.1.0
info: { title: AnalystAgent, version: 0.1.0 }
servers:
  - $ref: '../_common/shared.openapi.yaml#/servers/0'
paths:
  /agents/analyst:invoke:
    post:
      operationId: invokeAnalyst
      summary: Compose a campaign report from the AnalyticsReport + brief.
      parameters:
        - $ref: '../_common/shared.openapi.yaml#/components/parameters/TenantHeader'
        - $ref: '../_common/shared.openapi.yaml#/components/parameters/TraceParent'
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: 'https://schemas.social-seeding.com/v2/agents/analyst.schema.json#/properties/Input' }
      responses:
        '200':
          description: Narrative produced.
          content:
            application/json:
              schema: { $ref: 'https://schemas.social-seeding.com/v2/agents/analyst.schema.json#/properties/Output' }
        '400': { $ref: '../_common/shared.openapi.yaml#/components/responses/BadRequest' }
        '422':
          description: Escalated (insufficient_data).
          content:
            application/json:
              schema: { $ref: '../_common/shared.openapi.yaml#/components/schemas/AgentEscalation' }
```

## 4. AsyncAPI 3.0 (Pub/Sub events)

```yaml
asyncapi: 3.0.0
info: { title: Analyst.Events, version: 0.1.0 }
channels:
  report.deliver.request:
    address: report.deliver.request
    description: Input — cron / stage_transition / manual trigger.
    messages:
      DeliverRequest:
        payload:
          type: object
          required: [campaignId, trigger]
          properties:
            campaignId: { type: string }
            trigger:    { type: string, enum: [cron, stage_transition, manual] }
            asOf:       { type: string, format: date-time }
            notes:      { type: string }
  report.delivered:
    address: report.delivered
    messages:
      Delivered:
        payload:
          type: object
          required: [campaignId, reportId, verifiedCount, targetLivePosts, generatedAt]
          properties:
            campaignId:       { type: string }
            workspaceId:      { type: string }
            reportId:         { type: string }
            trigger:          { type: string }
            verifiedCount:    { type: integer }
            targetLivePosts:  { type: integer }
            flagsCount:       { type: integer }
            generatedAt:      { type: string, format: date-time }
            usdSpent:         { type: number }
operations:
  consumeDeliverRequest:
    action: receive
    channel: { $ref: '#/channels/report.deliver.request' }
  publishDelivered:
    action: send
    channel: { $ref: '#/channels/report.delivered' }
```

## 5. Mermaid sequence diagram (happy path)

```mermaid
sequenceDiagram
  participant CR as Cloud Scheduler (weekly cron)
  participant PS as Pub/Sub
  participant WF as Cloud Workflows (report-deliver)
  participant AC as analytics.compile (capability)
  participant SP as Spanner / BigQuery
  participant AG as Agent Gateway + Model Armor
  participant AN as analyst agent
  participant MB as Memory Bank (workspace style)
  participant CS as Cloud Storage (report archive)

  CR->>PS: publish report.deliver.request (trigger=cron)
  PS->>WF: deliver event
  WF->>AC: compile(campaignId)
  AC->>SP: SELECT funnel / goals / reach / performance / cost
  SP-->>AC: rows
  AC->>BQ: aggregate verified views over window
  BQ-->>AC: rows
  AC-->>WF: AnalyticsReport (deterministic)
  WF->>AG: POST /agents/analyst:invoke (brief + report + creatorHandles)
  AG->>AN: invoke (Gemini 2.5 Pro)
  AN->>MB: read workspace style memory (tone, prior reports)
  MB-->>AN: voice notes
  AN->>AN: Compose summary (lead with verified/target headline)
  AN->>AN: Translate fired flags into plain-language concerns (1:1)
  AN->>AN: Write recommendations (concrete, ≤3)
  AN->>AN: Render markdown (sections: Summary / What worked / Watch / Next / Numbers)
  AN-->>AG: { summary, highlights, concerns, recommendations, markdown }
  AG-->>WF: 200 OK
  WF->>SP: persist v2_reports row (CMEK)
  WF->>CS: archive markdown.md (90d retention, audit; D33)
  WF->>PS: publish report.delivered
```

## 6. Tool list + USD cap + escalation conditions

| Tool | Capability | Purpose |
|---|---|---|
| `bigquery.query` | analytics queries | Cross-campaign comparisons (longer-window stats) |
| `view_metrics.aggregate` | BigQuery rollup | Verified-view aggregates per shipment cohort |

**USD cap**: $0.20 per invocation (Gemini 2.5 Pro long-context — up to 8000-char markdown).

**Escalation conditions**:
- `report.funnel.candidate == 0` (campaign was empty).
- `report.verifiedCount == 0` AND `report.funnel.outreach_sent == 0` (literally no data).
- `report.flags` includes `no_verified_yet` AND deadline > 30 days away → narrative becomes "too early to call" — agent produces, but tags `early_call` in trace.
- Translation API failure when `locale != "en"` and report markdown can't be localized.

```python
class AnalystOutput(BaseModel):
    summary: str = Field(min_length=20, max_length=600)
    highlights: list[str] = Field(default_factory=list, max_items=4)
    concerns: list[str] = Field(default_factory=list, max_items=4)
    recommendations: list[str] = Field(min_items=1, max_items=3)
    markdown: str = Field(min_length=50, max_length=8000)
```

## 7. Eval criteria (Vertex AI Agent Evaluation)

| Metric | Description | Threshold |
|---|---|---|
| `grounding_score` | Numbers in markdown trace back to input fields | ≥ 0.95 |
| `concerns_flag_consistency` | `len(concerns) == len(report.flags) ± 1` | ≥ 0.98 |
| `summary_quality` (LLM-as-judge) | Op-to-op tone; no marketing copy | ≥ 0.85 |
| `recommendation_specificity` | Cites a number / handle / metric | ≥ 0.80 |
| `cost_per_report` | Average USD per delivered report | ≤ $0.15 |

**Golden set**: `tests/golden/analyst/*.json` — 80 reports across performance bands (winning / on-target / behind / failed / over-budget / late). Multi-locale per D34.

## 8. Edge cases

1. **All tracks `state=verified`** — `goalMet=true`; lead summary with the win, no `concerns`.
2. **Mid-flight campaign (deadline 30d out, 0 verified)** — narrative says "early days"; recommendations focus on accelerating outreach, not declaring failure.
3. **Single creator drove 90% of views** — highlight the disparity; recommendation may flag "creator concentration risk".
4. **No `creatorHandles` map** — agent cites by `creatorId`; output flagged `handles_missing` in trace.
5. **Multilingual locale switch mid-report** — agent must produce ONE locale's markdown; if input locale conflicts with `brief.targeting.languages`, prefer the request's `locale` (operator's UI choice).
6. **`flags` contains a flag the prompt doesn't know** — agent translates conservatively ("flag X fired — review the data") and tags `unknown_flag` in trace.
7. **Memory Bank empty (first-ever report for workspace)** — no style adaptation; produce neutral op-to-op tone.
