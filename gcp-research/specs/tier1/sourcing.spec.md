# sourcing.spec.md

## 1. Purpose + ARCHITECTURE.md citation

The **Sourcing agent** turns a `CampaignBrief` (operator intent) into a ranked list of TikTok creator candidates with per-pick match reasons. It plans 2-4 distinct queries across the brief's hashtag space, unions results, drops the workspace's PERMANENT blacklist, and proposes — never decides — the shortlist (the `approveShortlist` gate decides; see policy.ts:38).

- **D-ID coverage**: D23 (Tier-1 inherited from v2 — agent #1), D11 (influencer-campaign domain), D14 (RapidAPI sourcing path; Instagram queued), D17 (Vertex AI Agent Runtime), D24 (Tier-1 in-process for 0→1; RemoteA2AAgent for 1→100).
- **ARCHITECTURE.md §3 row 1**: `sourcing | 1 | Gemini 2.5 Pro | rapidapi.tiktok_search, rapidapi.instagram_search, blacklist.check, vector_search.creator | Session + Memory Bank | trajectory + coverage`.
- **v2 reference**: `packages/agents/src/sourcing.agent.ts:16-69` (existing 11-agent fleet — mirrored here, then re-targeted at GCP).

## 2. JSON Schema (input/output)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.social-seeding.com/v2/agents/sourcing.schema.json",
  "title": "SourcingAgent",
  "$defs": {
    "TikTokCreator": {
      "type": "object",
      "required": ["id", "uniqueId", "nickname", "followerCount", "followingCount", "videoCount"],
      "properties": {
        "id":              { "type": "string" },
        "uniqueId":        { "type": "string", "description": "@handle without leading @" },
        "nickname":        { "type": "string" },
        "signature":       { "type": "string", "default": "" },
        "avatarThumb":     { "type": "string", "format": "uri" },
        "verified":        { "type": "boolean", "default": false },
        "privateAccount":  { "type": "boolean", "default": false },
        "followerCount":   { "type": "integer", "minimum": 0 },
        "followingCount":  { "type": "integer", "minimum": 0 },
        "videoCount":      { "type": "integer", "minimum": 0 },
        "heartCount":      { "type": "integer", "minimum": 0 },
        "hashtags":        { "type": "array", "items": { "type": "string" }, "default": [] },
        "language":        { "type": "string", "minLength": 2, "maxLength": 2 },
        "avgViews":        { "type": "number", "minimum": 0 },
        "engagementRate":  { "type": "number", "minimum": 0, "maximum": 1 },
        "influenceScore":  { "type": "number", "minimum": 0, "maximum": 100 },
        "priorOutcome":    { "type": "string", "enum": ["responded","ignored","declined","flaked","delivered","overperformed"] }
      }
    },
    "CandidateProposal": {
      "type": "object",
      "required": ["creator", "matchReasons", "flags"],
      "properties": {
        "creator":      { "$ref": "#/$defs/TikTokCreator" },
        "matchReasons": { "type": "array", "items": { "type": "string", "minLength": 1, "maxLength": 240 }, "minItems": 1 },
        "flags": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": ["below_engagement_floor","blacklisted","wrong_language","brand_unsafe","prior_flake","data_stale"]
          },
          "default": []
        }
      }
    }
  },
  "type": "object",
  "properties": {
    "Input": {
      "type": "object",
      "required": ["brief"],
      "properties": {
        "brief": {
          "type": "object",
          "required": ["workspaceId","createdBy","brandProduct","targeting","logistics","goals"],
          "properties": {
            "workspaceId":  { "$ref": "https://schemas.social-seeding.com/v2/common/shared.schema.json#/$defs/WorkspaceId" },
            "createdBy":    { "type": "string", "minLength": 1 },
            "brandProduct": {
              "type": "object",
              "required": ["name","category","description"],
              "properties": {
                "name":        { "type": "string", "minLength": 1 },
                "category":    { "type": "string", "minLength": 1 },
                "description": { "type": "string", "minLength": 1 },
                "landingUrl":  { "type": "string", "format": "uri" },
                "keyClaims":   { "type": "array", "items": { "type": "string" }, "default": [] }
              }
            },
            "targeting": {
              "type": "object",
              "required": ["creatorCount"],
              "properties": {
                "creatorCount":       { "type": "integer", "minimum": 1, "maximum": 500 },
                "followerRange":      { "type": "array", "items": { "type": "integer", "minimum": 0 }, "minItems": 2, "maxItems": 2 },
                "minEngagementRate":  { "type": "number", "minimum": 0, "maximum": 1, "default": 0.02 },
                "languages":          { "type": "array", "items": { "type": "string", "minLength": 2, "maxLength": 2 }, "default": ["ko"] },
                "hashtags":           { "type": "array", "items": { "type": "string" }, "default": [] },
                "excludeBlacklist":   { "type": "boolean", "default": true }
              }
            },
            "logistics": { "type": "object", "properties": { "shipsSamples": { "type": "boolean", "default": true } } },
            "goals": {
              "type": "object",
              "required": ["targetLivePosts","deadline"],
              "properties": {
                "targetLivePosts": { "type": "integer", "minimum": 1 },
                "deadline":        { "type": "string", "format": "date-time" },
                "budgetUsd":       { "type": "number", "minimum": 0 }
              }
            }
          }
        },
        "excludeCreatorIds": { "type": "array", "items": { "type": "string" }, "default": [] },
        "metadata": { "$ref": "https://schemas.social-seeding.com/v2/common/shared.schema.json#/$defs/InvocationMetadata" }
      }
    },
    "Output": {
      "type": "object",
      "required": ["candidates","queriesUsed","coverageNote"],
      "properties": {
        "candidates":   { "type": "array", "items": { "$ref": "#/$defs/CandidateProposal" }, "minItems": 0, "maxItems": 1500 },
        "queriesUsed":  { "type": "array", "items": { "type": "string", "minLength": 1 }, "minItems": 1, "maxItems": 8 },
        "coverageNote": { "type": "string", "minLength": 1, "maxLength": 300 }
      }
    }
  }
}
```

## 3. OpenAPI 3.1 (REST surface)

```yaml
openapi: 3.1.0
info:
  title: SourcingAgent
  version: 0.1.0
servers:
  - $ref: '../_common/shared.openapi.yaml#/servers/0'
paths:
  /agents/sourcing:invoke:
    post:
      operationId: invokeSourcing
      summary: Plan creator search + return ranked candidates.
      parameters:
        - $ref: '../_common/shared.openapi.yaml#/components/parameters/TenantHeader'
        - $ref: '../_common/shared.openapi.yaml#/components/parameters/TraceParent'
        - $ref: '../_common/shared.openapi.yaml#/components/parameters/IdempotencyKey'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: 'https://schemas.social-seeding.com/v2/agents/sourcing.schema.json#/properties/Input'
      responses:
        '200':
          description: Sourcing succeeded.
          content:
            application/json:
              schema:
                $ref: 'https://schemas.social-seeding.com/v2/agents/sourcing.schema.json#/properties/Output'
        '400': { $ref: '../_common/shared.openapi.yaml#/components/responses/BadRequest' }
        '401': { $ref: '../_common/shared.openapi.yaml#/components/responses/Unauthorized' }
        '403': { $ref: '../_common/shared.openapi.yaml#/components/responses/Forbidden' }
        '409': { $ref: '../_common/shared.openapi.yaml#/components/responses/ModelArmorBlocked' }
        '422':
          description: Agent escalated.
          content:
            application/json:
              schema: { $ref: '../_common/shared.openapi.yaml#/components/schemas/AgentEscalation' }
        '429': { $ref: '../_common/shared.openapi.yaml#/components/responses/BudgetExceeded' }
        '500': { $ref: '../_common/shared.openapi.yaml#/components/responses/InternalError' }
      security:
        - IdentityPlatformJWT: []
        - AgentIdentitySPIFFE: []
```

## 4. AsyncAPI 3.0 (Pub/Sub events)

```yaml
asyncapi: 3.0.0
info: { title: SourcingAgent.Events, version: 0.1.0 }
channels:
  agent.t1.sourcing.candidates_ready:
    address: agent.t1.sourcing.candidates_ready
    messages:
      CandidatesReady:
        contentType: application/json
        payload:
          type: object
          required: [campaignId, candidateCount, queriesUsed, traceId]
          properties:
            campaignId:     { type: string }
            tenantId:       { type: string }
            workspaceId:    { type: string }
            candidateCount: { type: integer, minimum: 0 }
            queriesUsed:    { type: array, items: { type: string } }
            coverageNote:   { type: string }
            usdSpent:       { type: number, minimum: 0 }
            traceId:        { type: string }
            completedAt:    { type: string, format: date-time }
  # Lifecycle events from shared
  agent.lifecycle.invoked:    { $ref: '../_common/shared.asyncapi.yaml#/channels/agent.lifecycle.invoked' }
  agent.lifecycle.completed:  { $ref: '../_common/shared.asyncapi.yaml#/channels/agent.lifecycle.completed' }
  agent.lifecycle.escalated:  { $ref: '../_common/shared.asyncapi.yaml#/channels/agent.lifecycle.escalated' }
operations:
  publishCandidatesReady:
    action: send
    channel: { $ref: '#/channels/agent.t1.sourcing.candidates_ready' }
  consumeRapidApiThrottle:
    action: receive
    channel:
      address: system.rapidapi.throttled
      messages:
        ThrottleSignal:
          payload: { type: object, properties: { tenantId: {type: string}, retryAfterSec: {type: integer} } }
```

## 5. Mermaid sequence diagram (happy path)

```mermaid
sequenceDiagram
  actor WF as Cloud Workflows (brand-campaign)
  participant AG as Agent Gateway + Model Armor
  participant SO as sourcing agent
  participant RAPI as rapidapi.tiktok_search
  participant VS as vector_search.creator
  participant BL as blacklist.check
  participant PS as Pub/Sub
  participant SP as Spanner v2_campaigns

  WF->>AG: POST /agents/sourcing:invoke (brief + excludeCreatorIds)
  AG->>AG: Model Armor input scan (D21)
  AG->>SO: invoke (Vertex Agent Runtime D17)
  SO->>SO: Plan 2-4 queries from brief.hashtags + product description
  par parallel fan-out (D24 1→100 ready)
    SO->>RAPI: search(query_1)
    RAPI-->>SO: creators_1[]
    SO->>RAPI: search(query_2)
    RAPI-->>SO: creators_2[]
    SO->>VS: similarity(brand embedding, top-K=200)
    VS-->>SO: semantic_matches[]
  end
  SO->>SO: Union by uniqueId; cap at 3× targeting.creatorCount
  SO->>BL: check(uniqueIds[])
  BL-->>SO: blacklist_hits[]
  SO->>SO: Drop PERMANENT; flag TEMPORARY/WARNING; drop excludeCreatorIds
  SO->>SO: Write matchReasons per remaining candidate (fact-anchored)
  SO-->>AG: { candidates[], queriesUsed[], coverageNote }
  AG->>AG: Model Armor output scan (D21)
  AG-->>WF: 200 OK
  AG->>PS: publish agent.t1.sourcing.candidates_ready
  WF->>SP: persist v2_campaigns.tracks (state="candidate", CMEK D20)
```

## 6. Tool list + USD cap + escalation conditions

| Tool | Capability | Purpose |
|---|---|---|
| `rapidapi.tiktok_search` | external | Plan a query; receive `creators[]` |
| `rapidapi.instagram_search` | external (D14 deferred — feasibility O3) | Optional Instagram path |
| `blacklist.check` | DB read (Spanner) | Filter PERMANENT entries |
| `vector_search.creator` | Vertex AI Vector Search (D16) | Semantic creator-fit via brand embedding |

**USD cap**: $2.50 per invocation (Gemini 2.5 Pro tournament-style loop with 2-4 search calls). Carries the live-demo lesson cited in v2 sourcing.agent.ts:25 — raised from $1.50 to $2.50 after Opus loops hit the cap.

**Escalation conditions**:
- Zero results across ALL queries (every search returned 0 creators).
- All matches blacklisted (no PERMANENT-free survivors).
- RapidAPI returned non-throttle errors twice in a row.
- LLM budget exceeded mid-run (the runtime returns `{kind:"escalate"}` with `usdSpent`).

```python
# Pydantic example for ADK Python (D17 Vertex AI Agent Runtime)
from pydantic import BaseModel, Field
from typing import Literal

class SourcingInput(BaseModel):
    brief: "CampaignBrief"
    excludeCreatorIds: list[str] = Field(default_factory=list)

class CandidateProposal(BaseModel):
    creator: "TikTokCreator"
    matchReasons: list[str] = Field(min_items=1)
    flags: list[Literal[
      "below_engagement_floor","blacklisted","wrong_language",
      "brand_unsafe","prior_flake","data_stale"
    ]] = Field(default_factory=list)

class SourcingOutput(BaseModel):
    candidates: list[CandidateProposal]
    queriesUsed: list[str] = Field(min_items=1, max_items=8)
    coverageNote: str
```

## 7. Eval criteria (Vertex AI Agent Evaluation)

| Metric | Description | Threshold |
|---|---|---|
| `trajectory_match` | Did the agent run search → blacklist.check → return JSON in order? | ≥ 0.90 |
| `coverage_ratio` | `len(candidates) / brief.targeting.creatorCount` | ≥ 1.5 (need ≥ 3× to give Vetting room) |
| `tool_efficiency` | LLM-call USD / candidate found | ≤ $0.05 |
| `flag_precision` | of `blacklisted` flags, fraction that were actually in the blacklist | ≥ 0.95 |
| `escalation_rate` | escalations / total runs on the golden set | ≤ 0.05 |

**Golden set**: `tests/golden/sourcing/{ko-skincare,en-fitness,ja-cafe,zh-tech}.json` (4 locales per D34, 20 cases each = 80 cases). Mirrors `packages/agents/src/sourcing.golden.test.ts`.

## 8. Edge cases

1. **Brief omits `hashtags[]`** — agent must infer hashtags from `brandProduct.description` and `category`. Failure mode: agent escalates instead of inferring → eval flags as low-coverage.
2. **Workspace has 10,000+ blacklist entries** — blacklist.check call payload exceeds 8MB Spanner row limit; use streaming filter (capability layer paginates).
3. **All target creators are private accounts** — `privateAccount=true` should NOT be a flag here (vetting handles it); sourcing returns them so the operator can see the candidate pool.
4. **RapidAPI 429** — listen on `system.rapidapi.throttled`; back off + retry once via Cloud Tasks (D18), then escalate if still throttled.
5. **`languages` mismatch with returned creators** — flag `wrong_language` but do NOT drop; the operator may want cross-locale picks.
6. **Two search queries return overlapping creators 100%** — union should not exceed sum; flag `low_query_diversity` in coverageNote.
7. **`excludeCreatorIds` is huge (>1k)** — server-side anti-join; not in prompt.
