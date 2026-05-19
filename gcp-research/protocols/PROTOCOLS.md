# Agent Protocols — Definitive Reference (May 2026)

**Scope.** A2A v0.3.0 (agent-to-agent transport), AP2 v0.2.0 (agent payments), Google Cloud Marketplace `agent.json` (Agent Card listing schema), and the full registration flow from local JSON → Gemini Enterprise gallery.

**Audience.** Engineers integrating Social Seeding agents into the Gemini Enterprise / Cloud Marketplace ecosystem. Assumes you already speak HTTP, JSON-RPC 2.0, gRPC, and JWS.

**Sources.** This document cites only official primary sources: `a2a-protocol.org`, `ap2-protocol.org`, `cloud.google.com/marketplace/...`, `docs.cloud.google.com/gemini/...`, `docs.cloud.google.com/marketplace/...`, and the canonical GitHub repos `github.com/a2aproject/A2A` and `github.com/google-agentic-commerce/AP2`. Where third-party reporting is cited (partner list announcement), that is called out inline.

**Date stamp.** 2026-05-19. A2A is at v0.3.0 stable (v1.0 draft is on `a2a-protocol.org/dev/`). AP2 v0.2.0 was tagged 2026-04-28 and is the donation candidate to the FIDO Alliance.

---

## 1. A2A Protocol v0.3.0

### 1.1 What A2A is, and what it is not

A2A is the wire protocol that lets one autonomous agent talk to another across organisational and trust boundaries. It defines **how** two agents discover each other, authenticate, exchange messages, manage long-running tasks, stream partial results, and recover from interruption. It does **not** define how an agent thinks (that is the model and the framework, e.g. ADK or LangGraph), nor what tools it has (that is MCP).

A2A is layered:

| Layer | Concern |
|-------|---------|
| 1 — Identity & discovery | AgentCard, well-known URI, signatures |
| 2 — Semantics | Message, Task, Artifact, lifecycle, capabilities |
| 3 — Transport binding | JSON-RPC 2.0, gRPC, HTTP+JSON/REST |

Multi-transport agents **MUST** expose semantically equivalent operations across every binding they advertise — clients must see the same task, same state machine, and the same error mapping regardless of which transport they pick.

### 1.2 Transports

Three normative bindings:

**JSON-RPC 2.0** (default, `preferredTransport: "JSONRPC"`)
- `Content-Type: application/json` required on requests and responses
- Method naming pattern: `{category}/{action}` (e.g. `message/send`)
- Streaming via Server-Sent Events: `Content-Type: text/event-stream`, each `data:` frame is a complete JSON-RPC response envelope

**gRPC** (`preferredTransport: "GRPC"`)
- Normative `.proto` lives at `specification/grpc/a2a.proto` in the repo
- Protocol Buffers v3 serialisation
- `A2AService` exposes one RPC per JSON-RPC method below; streaming methods use server-streaming RPCs
- TLS over HTTP/2 is required; mTLS is supported

**HTTP+JSON / REST** (`preferredTransport: "HTTP+JSON"`)
- Path mapping is fixed (table below); SSE is used for streaming

| JSON-RPC method | gRPC method | REST verb + path |
|---|---|---|
| `message/send` | `SendMessage` | `POST /v1/message:send` |
| `message/stream` | `SendStreamingMessage` | `POST /v1/message:stream` (SSE) |
| `tasks/get` | `GetTask` | `GET /v1/tasks/{id}` |
| `tasks/cancel` | `CancelTask` | `POST /v1/tasks/{id}:cancel` |
| `tasks/resubscribe` | `TaskSubscription` | `POST /v1/tasks/{id}:subscribe` (SSE) |
| `tasks/pushNotificationConfig/set` | `CreateTaskPushNotificationConfig` | `POST /v1/tasks/{id}/pushNotificationConfigs` |
| `tasks/pushNotificationConfig/get` | `GetTaskPushNotificationConfig` | `GET /v1/tasks/{id}/pushNotificationConfigs/{configId}` |
| `tasks/pushNotificationConfig/list` | `ListTaskPushNotificationConfig` | `GET /v1/tasks/{id}/pushNotificationConfigs` |
| `tasks/pushNotificationConfig/delete` | `DeleteTaskPushNotificationConfig` | `DELETE /v1/tasks/{id}/pushNotificationConfigs/{configId}` |
| `agent/getAuthenticatedExtendedCard` | `GetAgentCard` | `GET /v1/card` |

### 1.3 Core object schemas

#### AgentCard (the digital business card)

```jsonc
{
  "protocolVersion": "0.3.0",          // optional, default "0.3.0"
  "name": "TikTok Influencer Scout",   // required
  "description": "Sources, vets, and outreaches TikTok creators.", // required
  "url": "https://agent.socialseed.ing/a2a", // required — primary endpoint
  "preferredTransport": "JSONRPC",     // JSONRPC | GRPC | HTTP+JSON
  "additionalInterfaces": [            // optional, alternate transports
    { "url": "https://agent.socialseed.ing/grpc", "transport": "GRPC" }
  ],
  "iconUrl": "https://cdn.socialseed.ing/agent.svg", // optional
  "version": "1.4.2",                  // required, agent's own semver
  "documentationUrl": "https://docs.socialseed.ing/agent", // optional
  "provider": {                        // optional but recommended
    "organization": "Social Seeding Inc.",
    "url": "https://socialseed.ing"
  },
  "capabilities": {                    // required
    "streaming": true,
    "pushNotifications": true,
    "stateTransitionHistory": true,
    "extensions": [
      { "uri": "https://ap2-protocol.org/extensions/a2a/v0.2", "required": false }
    ]
  },
  "securitySchemes": {                 // optional, OpenAPI 3.0 SecurityScheme shape
    "oauth": {
      "type": "oauth2",
      "flows": { "authorizationCode": { "authorizationUrl": "...", "tokenUrl": "...", "scopes": { "agent.invoke": "..." } } }
    },
    "oidc": { "type": "openIdConnect", "openIdConnectUrl": "https://accounts.google.com/.well-known/openid-configuration" },
    "apiKey": { "type": "apiKey", "in": "header", "name": "X-API-Key" },
    "mtls":   { "type": "mutualTLS" }
  },
  "security": [                        // required — array is OR, object is AND
    { "oauth": ["agent.invoke"] },
    { "apiKey": [], "mtls": [] }
  ],
  "defaultInputModes":  ["text/plain", "application/json"],         // required
  "defaultOutputModes": ["text/plain", "application/json", "image/png"], // required
  "skills": [                          // required, ≥1
    {
      "id": "scout-creators",
      "name": "Scout TikTok creators",
      "description": "Given a brief, returns vetted candidate creators.",
      "tags": ["tiktok", "sourcing", "influencer"],
      "examples": ["Find pet-care creators in Korea with >50k followers"],
      "inputModes": ["text/plain"],
      "outputModes": ["application/json"],
      "security": [{ "oauth": ["agent.invoke"] }]
    }
  ],
  "supportsAuthenticatedExtendedCard": true, // optional, default false
  "signatures": [                      // optional but required for marketplace listing
    {
      "protected": "<base64url(JWS protected header)>",
      "signature": "<base64url(signature)>",
      "header": { "kid": "key-2026-05", "jku": "https://agent.socialseed.ing/.well-known/jwks.json" }
    }
  ]
}
```

**Required fields**: `name`, `description`, `url`, `version`, `capabilities`, `defaultInputModes`, `defaultOutputModes`, `skills`.
**Default location for unauthenticated discovery**: `https://{domain}/.well-known/agent-card.json` (RFC 8615).
**Authenticated extended card**: served at `GET /v1/card` (REST) / `agent/getAuthenticatedExtendedCard` (JSON-RPC) / `GetAgentCard` (gRPC), and may contain richer or scoped skill sets visible only to authenticated callers.

#### Message and Part

```jsonc
{
  "kind": "message",
  "messageId": "8c3...",     // UUID, required
  "role": "user",            // "user" | "agent"
  "parts": [
    { "kind": "text", "text": "Find me KR pet creators >50k" },
    { "kind": "file", "file": { "uri": "gs://bucket/brief.pdf" }, "mimeType": "application/pdf", "name": "brief.pdf" },
    { "kind": "data", "data": { "budget_usd": 5000, "platform": "tiktok" } }
  ],
  "taskId": "task-abc",      // optional — present when continuing a task
  "contextId": "ctx-123",    // optional — groups related tasks
  "metadata": { "trace_id": "..." },
  "extensions": ["https://ap2-protocol.org/extensions/a2a/v0.2"],
  "referenceTaskIds": []
}
```

`Part.kind` is one of `text`, `file`, `data`. `FilePart.file` is either `{ "bytes": "<base64>" }` (`FileWithBytes`) or `{ "uri": "..." }` (`FileWithUri`).

#### Task

```jsonc
{
  "kind": "task",
  "id": "task-abc",          // UUID
  "contextId": "ctx-123",    // UUID
  "status": { "state": "working", "message": null, "timestamp": "2026-05-19T03:21:00Z" },
  "history": [/* Message[] */],
  "artifacts": [/* Artifact[] */],
  "metadata": { ... }
}
```

#### Task lifecycle

```
                ┌────────────────────────────────────────────────────────┐
                │                                                        ▼
   submitted ──► working ──► input-required ──► working ──► completed   │
       │            │              │               │            │       │
       │            ▼              ▼               ▼            │       │
       │         failed         canceled        rejected        │       │
       │            ▲              ▲               ▲            │       │
       └────────────┴──────────────┴───────────────┴────────────┘       │
                                                                        │
                              auth-required ─── (out-of-band auth) ─────┘
                              unknown (indeterminate, transient)
```

| State | Terminal? | Meaning |
|---|---|---|
| `submitted` | no | accepted, not yet started |
| `working` | no | agent is processing |
| `input-required` | no | paused, needs further user input |
| `auth-required` | no | needs out-of-band authentication |
| `completed` | yes | finished successfully |
| `failed` | yes | execution error |
| `canceled` | yes | terminated by client via `tasks/cancel` |
| `rejected` | yes | agent declined the task before running it |
| `unknown` | transient | state cannot be determined |

### 1.4 Streaming and push notifications

**Streaming** uses Server-Sent Events. The client calls `message/stream` (or `tasks/resubscribe` for an existing task), and the server responds with `200 OK`, `Content-Type: text/event-stream`. Each `data:` frame is a complete JSON-RPC response envelope wrapping either a `Message`, a `TaskStatusUpdateEvent`, or a `TaskArtifactUpdateEvent`. Stream terminates when status reaches a terminal state or `final: true` is set on the last update event.

**Push notifications** allow disconnected delivery. The client registers a webhook via `tasks/pushNotificationConfig/set`:

```jsonc
{
  "url": "https://client.example.com/a2a/webhook",
  "events": ["status_update", "artifact_update", "completion"],
  "authentication": {
    "schemes": ["Bearer"],
    "credentials": "<opaque-token-client-will-recognise>"
  }
}
```

The agent POSTs `TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent` payloads to that URL whenever state changes. The client uses `tasks/pushNotificationConfig/{get,list,delete}` to manage configs.

### 1.5 Authentication

Credentials are obtained **out of band** — A2A does not mint tokens, it only consumes them via HTTP headers. The AgentCard's `securitySchemes` follows the OpenAPI 3.0 SecurityScheme shape, so any standard library can render the requirements:

- **`apiKey`** — header (e.g. `X-API-Key`) or query parameter
- **`http`** — Basic, Bearer (RFC 6750 — used for OAuth 2.x access tokens)
- **`oauth2`** — full authorization-code, client-credentials, or device-code flow; A2A v0.3 explicitly aligns with OAuth 2.1 best practice (PKCE mandatory for public clients, no implicit flow, refresh-token rotation)
- **`openIdConnect`** — points at the OIDC discovery doc (`openIdConnectUrl`), client follows the standard OIDC flow
- **`mutualTLS`** — server validates client certs presented during TLS handshake

`AgentCard.security` is OR-of-AND: each array element is an alternative; within an element, every map key must be satisfied. So `[{ "oauth": [...] }, { "apiKey": [], "mtls": [] }]` means "OAuth alone OR (API key AND mTLS together)".

On auth failure the server returns HTTP `401` (missing/invalid credentials) or `403` (authenticated but not authorised). The spec mandates TLS 1.2+ and modern cipher suites; production deployments must reject plaintext HTTP.

### 1.6 Signed AgentCard, cryptographic identity, key rotation

An AgentCard MAY carry a `signatures` array. Each entry follows **RFC 7515 JSON Web Signature (JWS), JSON Serialization form**:

```jsonc
{
  "protected": "<base64url(JSON header)>",
  "signature": "<base64url(signature bytes)>",
  "header":    { "kid": "key-2026-05", "jku": "https://agent.example.com/.well-known/jwks.json" }
}
```

The `protected` header is the standard JWS header (`alg`, `typ`, `kid`, `jku`). Recommended algorithms are `ES256` (P-256 ECDSA, default), `EdDSA` (Ed25519), and `RS256` (RSA 2048+). Verifiers fetch the JWK Set from `header.jku`, look up the key by `kid`, and verify the signature over the canonicalised AgentCard payload (with `signatures` field removed before hashing).

**Key rotation**: the spec does not mandate a fixed rotation cadence but recommends:

1. Serve the JWK Set at a stable, cacheable URL (e.g. `https://{domain}/.well-known/jwks.json`).
2. Include both the new and the previous key in the JWK Set for an overlap window ≥ the maximum cached card TTL clients are expected to honour.
3. Bump the `kid` on every rotation; never re-use a `kid` for a new key.
4. Re-sign and re-publish the AgentCard with the new `kid` before retiring the old key.

For Cloud Marketplace, the JWK Set MUST be reachable over HTTPS, MUST return valid JSON, and MUST be served with a `Cache-Control` header that lets the Marketplace validator cache it for ≤ 24h.

### 1.7 Discovery flow

1. Client GETs `https://{domain}/.well-known/agent-card.json` (the well-known URI). For private agents, the client may instead consult a registry or use direct configuration; A2A does not standardise registry APIs.
2. Client parses `capabilities`, picks a transport from `url`/`preferredTransport`/`additionalInterfaces`.
3. Client verifies `signatures` if present (fetch JWK Set from `jku`, validate over the JWS-protected payload).
4. Client selects a security scheme from `security`, obtains the credential out of band.
5. If `supportsAuthenticatedExtendedCard` is true and the client wants richer skill metadata, it calls `agent/getAuthenticatedExtendedCard` (or `GET /v1/card`) with the credential to obtain the extended card.
6. Client matches its needs against `skills[]` and proceeds to `message/send` or `message/stream`.

### 1.8 Worked example — agent A calls agent B

**Setup.** Agent A (Social Seeding Mission Control) wants to ask Agent B (TikTok-MCP-Server-Agent) to scout creators. Agent B's card is at `https://agent.socialseed.ing/.well-known/agent-card.json` and is signed.

**Step 1 — discovery (HTTP):**
```http
GET /.well-known/agent-card.json HTTP/1.1
Host: agent.socialseed.ing
```
Response is the AgentCard from §1.3 above. Agent A verifies the JWS via `jku=https://agent.socialseed.ing/.well-known/jwks.json` and `kid=key-2026-05`.

**Step 2 — obtain OAuth access token** (out of band, standard OAuth 2.1 authorization-code + PKCE against `securitySchemes.oauth.flows.authorizationCode.tokenUrl`). Returns `access_token=eyJ...`, scope `agent.invoke`.

**Step 3 — send a message (JSON-RPC):**
```http
POST /a2a HTTP/1.1
Host: agent.socialseed.ing
Authorization: Bearer eyJ...
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "message/stream",
  "params": {
    "message": {
      "kind": "message",
      "messageId": "msg-001",
      "role": "user",
      "parts": [
        { "kind": "text", "text": "Find KR pet creators 50k-300k, last-30d ER ≥ 4%, English-capable, budget $5000." }
      ],
      "contextId": "ctx-camp-42"
    },
    "configuration": { "acceptedOutputModes": ["application/json"] }
  }
}
```

**Step 4 — SSE stream from agent B:**
```http
HTTP/1.1 200 OK
Content-Type: text/event-stream

data: {"jsonrpc":"2.0","id":"req-1","result":{"kind":"task","id":"task-7","contextId":"ctx-camp-42","status":{"state":"submitted"}}}

data: {"jsonrpc":"2.0","id":"req-1","result":{"kind":"status-update","taskId":"task-7","status":{"state":"working"}}}

data: {"jsonrpc":"2.0","id":"req-1","result":{"kind":"artifact-update","taskId":"task-7","artifact":{"artifactId":"art-1","parts":[{"kind":"data","data":{"creators":[{"handle":"@kr_petlover","followers":124000,"er":0.052}]}}]}}}

data: {"jsonrpc":"2.0","id":"req-1","result":{"kind":"status-update","taskId":"task-7","status":{"state":"completed"},"final":true}}
```

**Step 5 — equivalent over gRPC** (same semantics, server-streaming RPC):
```python
import grpc
from a2a.v1 import a2a_pb2, a2a_pb2_grpc

channel = grpc.secure_channel("agent.socialseed.ing:443", grpc.ssl_channel_credentials())
# Bearer token via call credentials
md = grpc.composite_channel_credentials(
    grpc.ssl_channel_credentials(),
    grpc.access_token_call_credentials("eyJ...")
)
stub = a2a_pb2_grpc.A2AServiceStub(grpc.secure_channel("agent.socialseed.ing:443", md))

req = a2a_pb2.SendMessageRequest(
    message=a2a_pb2.Message(
        message_id="msg-001",
        role=a2a_pb2.ROLE_USER,
        parts=[a2a_pb2.Part(text=a2a_pb2.TextPart(text="Find KR pet creators ..."))],
        context_id="ctx-camp-42",
    )
)
for event in stub.SendStreamingMessage(req):
    print(event)   # TaskStatusUpdateEvent / TaskArtifactUpdateEvent
```

Both transports deliver the same task `task-7` reaching the same terminal `completed` state with the same artifacts — that equivalence is mandatory under A2A v0.3.

---

## 2. AP2 v0.2.0 — Agent Payments Protocol

### 2.1 What AP2 is

AP2 is an open extension of A2A (and MCP) that adds **cryptographically verifiable payment authorisation** to agent-mediated commerce. It answers three questions that A2A alone cannot:

1. **Authorisation** — did the user actually authorise this purchase, with this scope?
2. **Authenticity** — is the agent's purchase request a faithful representation of the user's intent?
3. **Accountability** — who is liable if the transaction goes wrong (user vs agent vs merchant vs network)?

It does this by chaining three Verifiable Digital Credentials (VDCs) — **Intent Mandate → Cart Mandate → Payment Mandate** — each cryptographically bound to the previous. AP2 v0.2.0 (tagged 2026-04-28) is the FIDO Alliance donation candidate; AP2 is being moved under FIDO governance for long-term standardisation.

### 2.2 The three Mandates

All three are **SD-JWT credentials with Key Binding (`+kb`)** — Selective Disclosure JWTs that allow the holder to reveal only specific claims while still proving the issuer's signature and the holder's possession of a binding key.

#### 2.2.1 Intent Mandate

User → Shopping Agent, signed with the user's hardware-backed key (WebAuthn / passkey / device-bound key). Captures the **scope of authority** delegated to the agent.

```jsonc
{
  "credential_type": "ap2.IntentMandate",
  "version": "0.2.0",
  "iss": "did:web:user.example.com",        // user identifier
  "sub": "did:web:shopper-agent.example.ai", // agent that holds the credential
  "iat": 1747641600,
  "exp": 1747728000,                         // TTL — strict expiry
  "jti": "intent-7f3...",                    // unique credential id, anti-replay
  "shopping_intent": {
    "category": "running-shoes",
    "attributes": { "color": "white", "size": "US-10" },
    "price_max": { "amount": "150.00", "currency": "USD" },
    "merchant_allowlist": ["did:web:merchant.example.com"],
    "refundable_required": true
  },
  "prompt_playback": "I want white running shoes, size 10, under $150, refundable.",
  "delegation_mode": "human_not_present",    // or "human_present"
  "cnf": { "jwk": { "kty": "EC", "crv": "P-256", "x": "...", "y": "..." } }, // key binding
  "risk_payload": { "device_id": "...", "location": "..." }
}
```

Critical fields: `exp` (TTL), `jti` (replay protection), `shopping_intent.price_max` (scope limit), `merchant_allowlist` (whom the agent may transact with), `cnf` (key the agent uses to prove possession).

#### 2.2.2 Cart Mandate

Merchant → User (presented for signing); the user signs the cart and returns it. This is the **specific authorisation** for one exact transaction. In human-present mode this is the foundational credential. In delegated mode, the agent can auto-sign a Cart Mandate against a pre-signed Intent Mandate **only if every condition in the Intent is satisfied** (price within `price_max`, merchant on allowlist, items match intent attributes).

```jsonc
{
  "credential_type": "ap2.CartMandate",
  "version": "0.2.0",
  "iss": "did:web:merchant.example.com",     // issued by merchant
  "sub": "did:web:user.example.com",         // for this user
  "iat": 1747641800,
  "exp": 1747645400,                         // short TTL — cart freshness
  "jti": "cart-9a2...",
  "intent_mandate_hash": "sha256-...",       // cryptographic binding to Intent
  "payer": { "id": "did:web:user.example.com", "credential_provider": "did:web:google-wallet" },
  "payee": { "id": "did:web:merchant.example.com", "credential_provider": "did:web:adyen" },
  "payment_method": {
    "token": "tok_xyz",                      // network-tokenised card or PSP token
    "type": "card", "network": "mastercard",
    "last4": "4242"
  },
  "transaction_details": {
    "items": [
      { "sku": "RUN-W10-WHT", "name": "Whisper Runner", "qty": 1, "unit_price": { "amount": "139.00", "currency": "USD" } }
    ],
    "subtotal":     { "amount": "139.00", "currency": "USD" },
    "tax":          { "amount":   "8.34", "currency": "USD" },
    "shipping":     { "amount":   "0.00", "currency": "USD" },
    "total":        { "amount": "147.34", "currency": "USD" },
    "destination":  { "country": "KR", "postal_code": "06236" }
  },
  "merchant_authorization": "<merchant JWS of cart>",  // merchant signs first
  "risk_payload": { ... },
  "user_signature": "<user JWS of full cart incl. merchant_authorization>"
}
```

**Nested cryptographic binding.** The merchant signs the cart terms first (`merchant_authorization`). The user then signs the entire object including the merchant's signature. This proves both "merchant offered these exact terms" and "user accepted these exact terms".

#### 2.2.3 Payment Mandate

A **derived** credential the user (or agent on their behalf, per Intent) issues to the Credentials Provider / network. The network never sees the Cart in full — it sees the Payment Mandate, which references the Cart by hash. This is what flows over the existing card/network/issuer rails alongside the standard authorisation message.

```jsonc
{
  "credential_type": "ap2.PaymentMandate",
  "version": "0.2.0",
  "iss": "did:web:user.example.com",
  "sub": "did:web:adyen",                    // recipient (merchant's payment processor)
  "iat": 1747641900,
  "exp": 1747645500,
  "jti": "pay-2b1...",
  "cart_mandate_hash": "sha256-...",         // cryptographic binding to Cart
  "intent_mandate_hash": "sha256-...",       // and back to Intent (full chain)
  "payment_instrument": { "token": "tok_xyz", "type": "card", "network": "mastercard" },
  "amount": { "amount": "147.34", "currency": "USD" },
  "agentic_signals": {                        // helps issuer assess risk
    "agent_id": "did:web:shopper-agent.example.ai",
    "human_present": false,
    "delegation_proof": "<JWS over Intent>"
  },
  "user_signature": "..."
}
```

### 2.3 Cryptographic chain

```
Intent Mandate  ──signed by user──►  agent holds it (cnf: agent key)
       │
       │  sha256
       ▼
Cart Mandate    ──signed by merchant, then by user (or agent under Intent rules)
       │
       │  sha256
       ▼
Payment Mandate ──signed by user (or agent), sent to network/issuer with the auth message
```

Every Mandate carries the SHA-256 hash of its parent in the `*_mandate_hash` claim. Verifiers walk the chain backward to prove the user authorised this exact purchase under the exact scope of the Intent. The chain is non-repudiable: each step has a real-world identity (user, merchant, issuer) tied to a signing key.

### 2.4 Verifiable Credentials integration

AP2 uses **SD-JWT VC** ([draft-ietf-oauth-sd-jwt-vc](https://datatracker.ietf.org/doc/draft-ietf-oauth-sd-jwt-vc/), the IETF profile of W3C Verifiable Credentials over JWT). This gives:

- **Selective disclosure** — the user can prove `price_max ≤ $150` to the merchant without revealing other Intent fields, by withholding the corresponding disclosures.
- **Key binding** — the `cnf` claim binds the credential to a specific holder key; replay to a different holder fails.
- **JWT-native ecosystem** — issuers, holders, and verifiers can use any RFC 7519 / RFC 7515 library; W3C VC JSON-LD profiles are also supported but SD-JWT is the recommended baseline in v0.2.0.

Signing algorithms: `ES256` (default, hardware-backed device keys), `EdDSA` (Ed25519), `RS256` (server-side issuers with HSM). Issuer key discovery follows DID Web (`did:web:...`) or the JWS `jku` mechanism.

### 2.5 AP2 over A2A — the A2A extension

AP2 declares itself as an A2A extension via the URI **`https://ap2-protocol.org/extensions/a2a/v0.2`**. An A2A-capable agent that speaks AP2 advertises this in `AgentCard.capabilities.extensions[]`. Mandates travel as `DataPart` payloads inside `Message.parts`:

```jsonc
{
  "kind": "data",
  "data": {
    "ap2.mandate_type": "CartMandate",
    "ap2.sd_jwt": "eyJhbGciOiJFUzI1NiIsImtpZCI6Im1lcmNoYW50LWtleS0xIn0.....~<disclosure1>~<disclosure2>~<kb_jwt>"
  }
}
```

The receiving agent unpacks the SD-JWT, validates the chain, and proceeds. Tasks that involve payment typically use a multi-message exchange: `IntentMandate` (request) → agent searches → `CartMandate` (presented) → user/agent signs → `PaymentMandate` (issued) → settlement.

### 2.6 Partner ecosystem (60+ at v0.2.0)

Per the [Google Cloud launch announcement](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol), the v0.2.0 partner roster includes (non-exhaustive — see announcement for full list; bold = original launch partners):

- **Card networks & issuers**: American Express, Mastercard, JCB, UnionPay International, Discover
- **Payment processors / acquirers / orchestration**: PayPal, Adyen, Worldpay, Checkout.com, DLocal, JusPay, Nexi, Airwallex, Ant International, Ebanx, Gr4vy, Payoneer, Fiuu, KCP, BHN, Worldline
- **Wallets & BNPL**: Klarna (joined post-launch)
- **Crypto / Web3 (via `a2a-x402` companion extension)**: Coinbase, Mysten Labs, MetaMask, Ethereum Foundation, Lightspark, Crossmint, BVNK, Mesh
- **Commerce platforms**: Shopify, Etsy, Shopee, Global Fashion Group
- **SaaS / enterprise**: Salesforce, ServiceNow, Intuit, Adobe
- **Identity & security**: Okta / Auth0, 1Password, Forter
- **Infrastructure**: Confluent, Gravitee, Eigenlabs, Cloudflare
- **Consulting / SI**: Accenture, Deloitte, Dell, PwC
- **Other**: ManusAI

Visa and Stripe are notably **absent** from the AP2 launch partner list — they back competing protocols (Visa's Trusted Agent Protocol / TAP, Stripe's Agentic Commerce Protocol / ACP). AP2 reaches them only via merchant-side orchestration (e.g. Adyen routing to a Stripe-acquired merchant).

### 2.7 Risk model

| Threat | AP2 mitigation |
|--------|----------------|
| **Replay** | `jti` (unique per credential) + `exp` (short TTL — Cart Mandates expire in minutes, not hours) + Key Binding (`+kb`) JWT proves holder possession at use-time |
| **Out-of-scope purchases** | Intent Mandate `shopping_intent.price_max`, `merchant_allowlist`, attribute matching — auto-Cart-signing only allowed if every Intent constraint is satisfied |
| **Agent hallucination** | Cart Mandate is signed by the merchant first; the user signs over the merchant's signature — the user is never trusting the agent's restated terms, they're signing the merchant's authoritative offer |
| **Revocation** | Mandates carry short TTLs; long-running Intents may be revoked by publishing to a status list (W3C VC Status List 2021) referenced from the SD-JWT's `status` claim |
| **Stolen device / key compromise** | Key Binding requires fresh proof at use-time; revoking the device passkey invalidates all unsigned-yet Mandates |
| **Compromised agent** | Agentic signals in Payment Mandate (`agent_id`, `human_present`, `delegation_proof`) let the issuer apply risk-adjusted authorisation; merchant can refuse Carts not bound to a known agent |
| **Liability attribution** | Each Mandate is non-repudiably signed by exactly one real-world entity → forensics are deterministic |

### 2.8 Worked example — user → agent → merchant → payment

**Scenario.** User asks their shopping agent (with delegated authority) to buy white running shoes ≤ $150 from `merchant.example.com`. User is not present at purchase time.

1. **User signs Intent Mandate** on their phone via passkey (`ES256`, `cnf` = agent's public key). Hands it to the agent. Intent has `delegation_mode: "human_not_present"`, `price_max: $150`, `merchant_allowlist: [merchant.example.com]`, `exp: now + 24h`.

2. **Agent searches merchant** via A2A (`message/send`). Merchant agent returns a candidate cart: Whisper Runner, $147.34 incl. tax & shipping.

3. **Merchant signs Cart Mandate** with its DID key (`merchant_authorization`). Sends back via A2A as a `DataPart`.

4. **Agent validates Cart against Intent**: price $147.34 ≤ $150 ✓; merchant on allowlist ✓; attributes match (running-shoes, white, US-10) ✓; Cart's `intent_mandate_hash` equals SHA-256 of the Intent it holds ✓.

5. **Agent counter-signs Cart Mandate** using the key bound by Intent's `cnf` — this is legal because the Intent authorised auto-signing within scope. Result: a fully signed Cart Mandate.

6. **Agent issues Payment Mandate** referencing Cart by hash; includes agentic signals (`agent_id`, `human_present: false`, `delegation_proof` = the Intent JWS).

7. **Merchant's PSP (Adyen) receives Payment Mandate alongside the standard ISO 8583 / network auth message.** Network forwards `agentic_signals` to issuer. Issuer applies risk policy; approves.

8. **Settlement** proceeds on existing rails. The Mandate chain is archived by all parties for audit.

If anything goes wrong (e.g. fraud claim), each party can produce its signed Mandate; the chain reconstructs exactly who authorised what.

---

## 3. Marketplace `agent.json` Agent Card schema

This is the **same** schema as A2A's AgentCard (§1.3) — Cloud Marketplace re-uses it directly. The Marketplace adds a few hard requirements on top of the A2A baseline. The card is hosted in a **Cloud Storage bucket** in your producer project; you give Producer Portal the `gs://` or `https://storage.googleapis.com/...` URL.

### 3.1 Marketplace-specific requirements on the A2A AgentCard

- `name`, `description`, `version`, `provider.organization`, `provider.url` — **required for listing** (Marketplace will reject cards missing these).
- `iconUrl` — required and must be HTTPS-reachable; SVG or PNG, ≤ 256 KB.
- `skills[]` — at least one skill; each skill must have `id`, `name`, `description`, and at least one `tag`.
- `capabilities` — must accurately reflect what the agent supports. Marketplace will probe the endpoint during validation and reject cards that lie.
- `securitySchemes` and `security` — required, with at least one production-viable scheme (OAuth 2.1 or OIDC strongly preferred; raw API keys are accepted but downgrade the Cloud Ready evaluation score).
- `signatures[]` — **required** for Cloud Marketplace. The card must be JWS-signed with a key whose JWK Set is publicly resolvable and which the producer controls.
- `url` and `additionalInterfaces[].url` — must be HTTPS, must respond to the A2A protocol probe.

### 3.2 Sample `agent.json` — MCP-tool-style agent (TikTok scraper)

This is a realistic listing for the Social Seeding `tiktok-scraper-api` family if it were exposed as a marketplace agent. It wraps the MCP tools in A2A skills so a Gemini Enterprise customer can call it agentically.

```jsonc
{
  "protocolVersion": "0.3.0",
  "name": "TikTok Insights Agent",
  "description": "Sources, enriches, and ranks TikTok creators and posts for influencer-marketing campaigns. Wraps Social Seeding's TikTok scraper toolchain (user-info, user-posts, search-users, post-detail) as A2A skills.",
  "url": "https://tiktok-agent.socialseed.ing/a2a",
  "preferredTransport": "JSONRPC",
  "additionalInterfaces": [
    { "url": "https://tiktok-agent.socialseed.ing/grpc", "transport": "GRPC" }
  ],
  "iconUrl": "https://cdn.socialseed.ing/tiktok-agent.svg",
  "version": "1.0.0",
  "documentationUrl": "https://docs.socialseed.ing/tiktok-agent",
  "provider": {
    "organization": "Social Seeding Inc.",
    "url": "https://socialseed.ing"
  },
  "capabilities": {
    "streaming": true,
    "pushNotifications": true,
    "stateTransitionHistory": true,
    "extensions": []
  },
  "securitySchemes": {
    "oauth": {
      "type": "oauth2",
      "flows": {
        "authorizationCode": {
          "authorizationUrl": "https://auth.socialseed.ing/oauth/authorize",
          "tokenUrl": "https://auth.socialseed.ing/oauth/token",
          "scopes": {
            "tiktok.read":  "Read public TikTok profile and post data",
            "tiktok.write": "Submit scrape jobs and receive callbacks"
          }
        }
      }
    }
  },
  "security": [
    { "oauth": ["tiktok.read"] },
    { "oauth": ["tiktok.read", "tiktok.write"] }
  ],
  "defaultInputModes":  ["text/plain", "application/json"],
  "defaultOutputModes": ["application/json"],
  "skills": [
    {
      "id": "search-users",
      "name": "Search TikTok users",
      "description": "Search creators by keyword, follower range, and geography.",
      "tags": ["tiktok", "search", "discovery"],
      "examples": ["KR pet creators 50k-300k followers"],
      "inputModes":  ["text/plain", "application/json"],
      "outputModes": ["application/json"],
      "security": [{ "oauth": ["tiktok.read"] }]
    },
    {
      "id": "fetch-user-info",
      "name": "Fetch creator profile",
      "description": "Returns enriched profile data, last-30d engagement metrics, contact hints.",
      "tags": ["tiktok", "creator", "enrichment"],
      "examples": ["@kr_petlover full profile"],
      "inputModes":  ["application/json"],
      "outputModes": ["application/json"],
      "security": [{ "oauth": ["tiktok.read"] }]
    },
    {
      "id": "fetch-user-posts",
      "name": "Fetch recent posts",
      "description": "Returns the most-recent N posts for a creator with engagement deltas.",
      "tags": ["tiktok", "posts", "engagement"],
      "examples": ["@kr_petlover last 20 posts"],
      "inputModes":  ["application/json"],
      "outputModes": ["application/json"],
      "security": [{ "oauth": ["tiktok.read"] }]
    },
    {
      "id": "submit-scrape-job",
      "name": "Submit async scrape job",
      "description": "Schedules a bulk scrape; results delivered via push notification.",
      "tags": ["tiktok", "bulk", "async"],
      "examples": ["Scrape 500 creators, return CSV"],
      "inputModes":  ["application/json"],
      "outputModes": ["application/json"],
      "security": [{ "oauth": ["tiktok.read", "tiktok.write"] }]
    }
  ],
  "supportsAuthenticatedExtendedCard": true,
  "signatures": [
    {
      "protected": "eyJhbGciOiJFUzI1NiIsImtpZCI6InNzLWtleS0yMDI2LTA1Iiwiamt1IjoiaHR0cHM6Ly90aWt0b2stYWdlbnQuc29jaWFsc2VlZC5pbmcvLndlbGwta25vd24vandrcy5qc29uIn0",
      "signature": "MEUCIQ...base64url-encoded-ES256-sig...",
      "header": { "kid": "ss-key-2026-05" }
    }
  ]
}
```

### 3.3 Sample `agent.json` — ADK-native agent

An agent built on Google's Agent Development Kit, deployed on Vertex AI Agent Engine, fronted by A2A.

```jsonc
{
  "protocolVersion": "0.3.0",
  "name": "Brief-to-Campaign Planner",
  "description": "Turns a free-text brand brief into a structured campaign plan: target audience, KPIs, creator persona, content brief, budget allocation.",
  "url": "https://us-central1-aiplatform.googleapis.com/v1/projects/social-seeding-prod/locations/us-central1/agentEngines/12345/a2a",
  "preferredTransport": "JSONRPC",
  "iconUrl": "https://cdn.socialseed.ing/brief-planner.svg",
  "version": "2.1.0",
  "documentationUrl": "https://docs.socialseed.ing/brief-planner",
  "provider": { "organization": "Social Seeding Inc.", "url": "https://socialseed.ing" },
  "capabilities": {
    "streaming": true,
    "pushNotifications": false,
    "stateTransitionHistory": true,
    "extensions": []
  },
  "securitySchemes": {
    "oidc": {
      "type": "openIdConnect",
      "openIdConnectUrl": "https://accounts.google.com/.well-known/openid-configuration"
    }
  },
  "security": [{ "oidc": [] }],
  "defaultInputModes":  ["text/plain", "application/pdf"],
  "defaultOutputModes": ["application/json", "text/markdown"],
  "skills": [
    {
      "id": "plan-campaign",
      "name": "Plan a campaign",
      "description": "Given a brief, returns a full campaign plan JSON.",
      "tags": ["planning", "campaign", "marketing"],
      "examples": [
        "Plan a Q3 campaign for a Korean pet-food brand, $50k budget, TikTok + Instagram."
      ],
      "inputModes":  ["text/plain", "application/pdf"],
      "outputModes": ["application/json", "text/markdown"]
    }
  ],
  "supportsAuthenticatedExtendedCard": false,
  "signatures": [
    {
      "protected": "eyJhbGciOiJFUzI1NiIsImtpZCI6InNzLWtleS0yMDI2LTA1IiwiamtuIjoiaHR0cHM6Ly9zb2NpYWxzZWVkLmluZy8ud2VsbC1rbm93bi9qd2tzLmpzb24ifQ",
      "signature": "MEYCIQD...base64url-encoded-ES256-sig...",
      "header": { "kid": "ss-key-2026-05" }
    }
  ]
}
```

### 3.4 Pricing / billing declarations

`agent.json` itself does **not** carry pricing — pricing is configured separately in Producer Portal (subscription, usage-based, free, outcome-based, or hybrid). What does live on the Agent Card is the `securitySchemes.oauth.scopes` declaration that defines what a paying customer's token is entitled to call; Producer Portal binds plan tiers to scope sets at procurement time.

### 3.5 Validation tooling

| Tool | Source | Use |
|------|--------|-----|
| **A2A Inspector** | `github.com/a2aproject/a2a-inspector` | Web UI (`http://127.0.0.1:5001`) that fetches an AgentCard from a URL or local file, validates against the A2A schema, exercises the endpoint, shows live request/response. Install: `uv sync`, then `uv run a2a-inspector`. |
| **A2A TCK** | `github.com/a2aproject/a2a-tck` | Technology Compatibility Kit — a black-box conformance suite. Produces a compliance level (Mandatory / Recommended / Optional) and a scorecard. Use this as your CI gate before submitting to Marketplace. |
| **a2a-validation-tool (a2v)** | `github.com/llmx-tech/a2a-validation-tool` | Third-party CLI alternative for batch-validating multiple cards. |
| **A2A Protocol Validator** | `a2aprotocol.ai/a2a-protocol-validator` | Hosted validator; useful for ad-hoc checks. |
| **Producer Portal Save and validate** | `console.cloud.google.com/producer-portal` → product → Agent Card → Save and validate | The authoritative Google-side validator. Returns a gap list if the card fails Marketplace policy. |

There is no `gcloud agents validate` subcommand as of May 2026 — validation is performed by Producer Portal server-side and via the A2A Inspector / TCK client-side.

---

## 4. Registration flow — from local JSON to Gemini Enterprise gallery

### Step 1 — Produce `agent.json`

Author the AgentCard per §1.3 and §3.1 above. Validate locally with A2A Inspector and the A2A TCK. Host the file at `gs://your-producer-bucket/agent.json` (or any HTTPS URL Marketplace can reach). The well-known URI at your agent's domain (`https://agent.example.com/.well-known/agent-card.json`) should also serve this card so non-Marketplace clients can discover it.

### Step 2 — Sign the AgentCard (Agent Identity)

1. **Generate a signing key** (ES256 recommended). Store it in Google Cloud KMS or a hardware HSM.
   ```bash
   gcloud kms keys create agent-card-signing \
     --location=global \
     --keyring=agent-keys \
     --purpose=asymmetric-signing \
     --default-algorithm=ec-sign-p256-sha256
   ```
2. **Publish the JWK Set** at `https://{your-domain}/.well-known/jwks.json`. Marketplace must be able to GET this anonymously.
3. **Compute and embed the JWS** in `agent.json` per §1.6. Practical tooling: `node-jose`, `jose` (Python), `go-jose` — sign the canonicalised card (with `signatures` field removed), then re-attach the signature object.
4. **Verify locally** with A2A Inspector → signature panel.

IAM at this step: the producer project's service account needs `roles/cloudkms.signer` on the signing key, and `roles/iam.serviceAccountTokenCreator` on itself if it impersonates other identities. No Marketplace role is required yet.

### Step 3 — Publish to the Agent Registry (your hosting)

The Agent Registry is, in practice, **your own infrastructure** plus the `.well-known/agent-card.json` URI. Google does not run a centralised public agent registry as of May 2026 — Cloud Marketplace itself is the de-facto registry for discoverable enterprise agents. You publish by:

1. Deploying the A2A endpoint behind HTTPS with a valid TLS certificate.
2. Serving the AgentCard at `https://{domain}/.well-known/agent-card.json`.
3. Serving the JWK Set at `https://{domain}/.well-known/jwks.json`.
4. Uploading the same AgentCard JSON to a Cloud Storage bucket in your producer project:
   ```bash
   gsutil cp agent.json gs://my-producer-project-public/agent.json
   gsutil iam ch allUsers:objectViewer gs://my-producer-project-public
   ```
   The bucket can be public-read (Marketplace will fetch it once during onboarding) or private with Marketplace granted read.

### Step 4 — Submit to Marketplace via Producer Portal

**Prerequisite — Cloud Marketplace Project Info Form.** Before you can access Producer Portal you must complete the form provided by the Cloud Marketplace partner team. Once approved, the team grants your project Producer access.

**Required IAM roles** (granted on the producer project to the people who will operate it):

| Role | Purpose |
|------|---------|
| `roles/commerceproducer.admin` | Full Producer Portal access — create/edit/publish products |
| `roles/commerceproducer.viewer` | Read-only Producer Portal access |
| `roles/commercebusinessenablement.admin` | Manage Partner Network account and org-level settings |
| `roles/commercebusinessenablement.paymentConfig.admin` | Manage payment profile |
| `roles/commercepricemanagement.privateoffers.admin` | Create/edit private offers |
| `roles/servicemanagement.admin` | Required alongside `commerceproducer.admin` for product listing |
| `roles/iam.serviceAccountAdmin` | SaaS products that mint per-customer service accounts |

Grant example:
```bash
gcloud projects add-iam-policy-binding my-producer-project \
  --member="user:operator@example.com" \
  --role="roles/commerceproducer.admin"
```

**Producer Portal submission (the 7-step onboarding):**

1. Open `https://console.cloud.google.com/producer-portal` → **Add product** → select **AI agent as a service** → name it → **Create**. Solution ID and product type are permanent.
2. **Add Agent Card**: in the product → **Agent Card** tab → enter the `gs://` URL of your `agent.json` → **Save and validate**. Fix any gaps the validator reports.
3. **Add product details**: marketing copy, screenshots, support contact, documentation URL, categories.
4. **Add pricing**: choose free / subscription / usage-based / outcome-based / hybrid. Pricing review can take up to **4 business days** — you cannot submit Technical Integration until pricing review completes.
5. **Integrate with Cloud Marketplace**: configure entitlement webhook (Cloud Commerce Partner Procurement API), Pub/Sub topic for purchase notifications, OAuth authentication for buyer linking.
6. **Submit Technical Integration for review** — only possible after pricing review is complete.
7. **Overview → Submit for review** (or **Publish changes** for updates).

### Step 5 — Pass the 4-step Google Cloud Ready evaluation

To earn the **Google Cloud Ready — Gemini Enterprise** designation (which is what gets you featured in the gallery, not just merely listed), the agent must pass:

1. **Basic Functionality** — core skills declared in `agent.json` actually work end-to-end against the live endpoint. Marketplace operations team runs scripted invocations against each declared skill.
2. **Output Accuracy** — outputs match the input contract and meet quality thresholds for the skill's domain. Subjective evaluation by Google operations + automated scoring where applicable.
3. **Autonomous Execution** — agent reliably handles multi-step / long-running tasks; lifecycle states are emitted correctly; streaming and push notifications behave per spec; `tasks/cancel` actually cancels.
4. **Enterprise Standards** — TLS 1.2+, OAuth 2.1 / OIDC for production auth, signed AgentCard, Model Armor wired up via REST API in the agent's code, observability via OpenTelemetry / W3C Trace Context, sane rate limits, GDPR/CCPA/HIPAA posture documented.

Failures return a written gap list; you fix and re-submit the affected tab.

### Step 6 — Listed in the Gemini Enterprise gallery

Once Google operations completes validation, they give you a `gcloud` command (sent via the partner channel) to flip your listing to publicly visible. After that:

- **Listing appears** in Cloud Marketplace and in the Gemini Enterprise gallery (`https://cloud.withgoogle.com/agentfinder`).
- **Customer admins discover it** via the AI Agent Finder or natural-language search inside their Gemini Enterprise app.
- **Customer procurement**: admin requests, approves, procures via Marketplace. Pub/Sub fires; your entitlement webhook gets a `PROCURED` event; you provision and return success via the Partner Procurement API.
- **Customer registration**: admin opens their Gemini Enterprise app → **Agents → Add Agents → Agents via Marketplace** → picks your agent → enters required auth details (OAuth client config if needed) → **Finish**. Or via REST:
  ```bash
  curl -X POST \
    -H "Authorization: Bearer $(gcloud auth print-access-token)" \
    -H "Content-Type: application/json" \
    "https://us-discoveryengine.googleapis.com/v1alpha/projects/PROJECT_ID/locations/us/collections/default_collection/engines/APP_ID/assistants/default_assistant/agents" \
    -d '{ "displayName": "...", "a2aAgentDefinition": { "jsonAgentCard": "<stringified agent.json>" } }'
  ```
  Customer admin IAM required: **Gemini Enterprise Admin** (`roles/discoveryengine.agentSpaceAdmin`) + **Consumer Procurement Entitlement Viewer**. Discovery Engine API must be enabled on the customer's project.
- **Customer end-users invoke**: the Gemini Enterprise chat surface routes prompts to your agent over A2A. Your endpoint sees standard A2A `message/send` / `message/stream` calls with the customer-side OAuth token.

### Step 7 — Operate

- Watch the Partner Procurement Pub/Sub topic for `PROCURED`, `CANCELLED`, `PLAN_CHANGED` events.
- Rotate JWK keys per §1.6 with overlap.
- Update the AgentCard by re-uploading `agent.json` and clicking **Save and validate**; any material change re-triggers technical-integration review.
- Configure Model Armor via the REST API inside your agent's code — Producer Portal console settings do **not** auto-protect A2A agents; Model Armor wiring is the producer's responsibility per the Marketplace docs.

---

## 5. Cross-protocol cheat sheet

| You want to… | Use |
|---|---|
| Have your agent talk to another agent | **A2A v0.3** over JSON-RPC or gRPC |
| Stream partial results to the caller | A2A `message/stream` (SSE) |
| Resume after disconnect | A2A `tasks/resubscribe` or push notifications |
| Cryptographically authorise a purchase the agent will make | **AP2 v0.2** Intent Mandate (signed by user) |
| Lock the merchant's terms before charging | AP2 Cart Mandate (signed by merchant, counter-signed by user/agent) |
| Send risk-aware authorisation to the issuer | AP2 Payment Mandate (with `agentic_signals`) |
| List your agent for Gemini Enterprise customers | Author `agent.json` per A2A AgentCard schema, sign it, submit via Producer Portal |
| Earn the gallery "Google Cloud Ready" badge | Pass the 4-step evaluation (Basic Functionality, Output Accuracy, Autonomous Execution, Enterprise Standards) |
| Validate locally before submitting | A2A Inspector + A2A TCK; Producer Portal "Save and validate" is the final gate |

---

## Sources (official primaries)

**A2A Protocol**
- Specification v0.3.0 — [a2a-protocol.org/v0.3.0/specification/](https://a2a-protocol.org/v0.3.0/specification/)
- Latest specification — [a2a-protocol.org/latest/specification/](https://a2a-protocol.org/latest/specification/)
- Enterprise-ready features — [a2a-protocol.org/latest/topics/enterprise-ready/](https://a2a-protocol.org/latest/topics/enterprise-ready/)
- Agent discovery — [a2a-protocol.org/v0.3.0/topics/agent-discovery/](https://a2a-protocol.org/v0.3.0/topics/agent-discovery/)
- Core concepts — [a2a-protocol.org/latest/topics/key-concepts/](https://a2a-protocol.org/latest/topics/key-concepts/)
- Custom protocol bindings — [a2a-protocol.org/latest/topics/custom-protocol-bindings/](https://a2a-protocol.org/latest/topics/custom-protocol-bindings/)
- Reference implementations — [github.com/a2aproject/A2A](https://github.com/a2aproject/A2A)
- A2A Inspector — [github.com/a2aproject/a2a-inspector](https://github.com/a2aproject/a2a-inspector)
- A2A TCK — [github.com/a2aproject/a2a-tck](https://github.com/a2aproject/a2a-tck)

**AP2 Protocol**
- AP2 documentation site — [ap2-protocol.org](https://ap2-protocol.org/)
- Specification — [ap2-protocol.org/specification/](https://ap2-protocol.org/specification/)
- Agent Payments Protocol detail — [ap2-protocol.org/ap2/specification/](https://ap2-protocol.org/ap2/specification/)
- Core concepts — [ap2-protocol.org/topics/core-concepts/](https://ap2-protocol.org/topics/core-concepts/)
- Life of a transaction — [ap2-protocol.org/topics/life-of-a-transaction/](https://ap2-protocol.org/topics/life-of-a-transaction/)
- A2A extension for AP2 — [ap2-protocol.org/a2a-extension/](https://ap2-protocol.org/a2a-extension/)
- AP2 and x402 — [ap2-protocol.org/topics/ap2-and-x402/](https://ap2-protocol.org/topics/ap2-and-x402/)
- AP2, A2A and MCP — [ap2-protocol.org/topics/ap2-a2a-and-mcp/](https://ap2-protocol.org/topics/ap2-a2a-and-mcp/)
- FAQ — [ap2-protocol.org/faq/](https://ap2-protocol.org/faq/)
- Reference repo — [github.com/google-agentic-commerce/AP2](https://github.com/google-agentic-commerce/AP2)
- Launch announcement — [cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol)

**Google Cloud Marketplace — AI Agents**
- Offer AI agents — [docs.cloud.google.com/marketplace/docs/partners/ai-agents](https://docs.cloud.google.com/marketplace/docs/partners/ai-agents)
- Add product in Producer Portal — [docs.cloud.google.com/marketplace/docs/partners/ai-agents/add-product](https://docs.cloud.google.com/marketplace/docs/partners/ai-agents/add-product)
- Add Agent Card — [docs.cloud.google.com/marketplace/docs/partners/ai-agents/agent-card](https://docs.cloud.google.com/marketplace/docs/partners/ai-agents/agent-card)
- Publish AI agent — [docs.cloud.google.com/marketplace/docs/partners/ai-agents/publish](https://docs.cloud.google.com/marketplace/docs/partners/ai-agents/publish)
- Producer Portal access control (IAM) — [docs.cloud.google.com/marketplace/docs/partners/access-control](https://docs.cloud.google.com/marketplace/docs/partners/access-control)
- AI Agent Marketplace announcement — [cloud.google.com/blog/topics/partners/google-cloud-ai-agent-marketplace](https://cloud.google.com/blog/topics/partners/google-cloud-ai-agent-marketplace)
- AI Agent Finder — [cloud.withgoogle.com/agentfinder](https://cloud.withgoogle.com/agentfinder)

**Gemini Enterprise — A2A agent management**
- Add/manage Marketplace agents — [docs.cloud.google.com/gemini/enterprise/docs/register-and-manage-marketplace-agents](https://docs.cloud.google.com/gemini/enterprise/docs/register-and-manage-marketplace-agents)
- Register/manage an A2A agent — [docs.cloud.google.com/gemini/enterprise/docs/register-and-manage-an-a2a-agent](https://docs.cloud.google.com/gemini/enterprise/docs/register-and-manage-an-a2a-agent)
- Gemini Enterprise Agent Platform — [docs.cloud.google.com/gemini-enterprise-agent-platform](https://docs.cloud.google.com/gemini-enterprise-agent-platform)
- Agent evaluation — [docs.cloud.google.com/gemini-enterprise-agent-platform/optimize/evaluation/agent-evaluation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/optimize/evaluation/agent-evaluation)
