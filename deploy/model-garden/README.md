# `deploy/model-garden/` — routing LLM reasoning through Vertex AI Model Garden (D47)

> **Requirement**: Track 3 `designed_guide.pdf` p.6, requirement #3 — *"Route LLMs through Model Garden. Ensure strict data security by powering your reasoning engine with Gemini or a third-party/open-source LLM deployed specifically through Model Garden."*
>
> **Decision**: D47 — `gcp-research/decisions/DECISIONS.md:148`.
>
> **Audience**: the human operator who flips the production gate, plus anyone auditing where the agent fleet's reasoning is served from.

---

## 1. What "route through Model Garden" means here

Vertex AI Model Garden is the catalog + serving plane for first-party (Gemini) and third-party/open-source publisher models. A model served through Model Garden is addressed by a **publisher-model resource path** rather than a bare model id:

```
projects/{project}/locations/{location}/publishers/google/models/gemini-2.5-flash
```

(The location-free form `publishers/google/models/gemini-2.5-flash` is also accepted by the `google-genai` Vertex backend.)

The contrast the PDF draws is against the **AI Studio** path — `generativelanguage.googleapis.com` with a `GOOGLE_API_KEY`, which is convenient but is *not* covered by the Google Cloud project-level security perimeter. Routing through Model Garden (the Vertex AI plane) is what lets the "strict data security" controls in §3 apply to every reasoning call.

This package's runtime makes the routing **one env-var flip**, with no per-agent edits:

| Knob | Effect |
|---|---|
| `GOOGLE_GENAI_USE_VERTEXAI=TRUE` | The `google-genai` SDK (used by ADK) targets the **Vertex AI** backend, not AI Studio. Already the default in `config.py` and `.env.example`. This is the prerequisite for any Model Garden routing. |
| `MODEL_GARDEN_ROUTING=true` | Each agent's short Gemini id (`gemini-2.5-flash`) is rewritten to the **Model Garden publisher-model path** before the ADK `LlmAgent` is constructed. Explicit, auditable routing string. |
| `MODEL_GARDEN_ROUTING=false` (default) | The short id is passed straight through. The Vertex backend still resolves it to the same publisher model, but the wire string is the short form — used for dev/CI where the verbose path adds nothing and where the stub model client is in play anyway. |

The flag is **gated, not always-on**, precisely so the offline stub path (`SS_LIVE=0` / `SS_OFFLINE=1`, the entire pytest suite) is unaffected. See `tests/test_model_garden.py`.

---

## 2. Where the routing happens in code

| File | Change | Cites |
|---|---|---|
| `packages/agents-adk/src/ss_agents/config.py` | `MODEL_GARDEN_ROUTING` setting + `model_garden_model_path()` + `resolve_runtime_model()` + `canonical_model_id()` (so pricing resolves whichever model-string form). | D47 |
| `packages/agents-adk/src/ss_agents/runtime.py` | `_run_with_adk` calls `resolve_runtime_model(agent_def.model)` and hands the result to `LlmAgent(model=…)`. Cost accounting still keys off the **declared short id** (`model_pricing(agent_def.model)`), so the USD budget guard is byte-for-byte unchanged by the rewrite. | D47 |
| `packages/agents-adk/tests/test_model_garden.py` | 20 unit tests proving the gate default, the publisher-path construction, the env-gated resolve, pricing invariance, the intake-agent end-to-end, and the open-source-endpoint pass-through. | D47 |

The seam is deliberately at the single `LlmAgent` construction site in `runtime.py` — *the one place an LLM is called* — so there is exactly one routing decision for all 22 agents.

---

## 3. Strict data security — the controls the routing enables

Routing through the Vertex AI Model Garden plane is the prerequisite that lets these Google Cloud security controls apply to reasoning traffic. None of them apply to AI Studio API-key calls. These are existing project decisions; this folder only documents how Model Garden routing is what makes them bind to the LLM calls.

| Control | What it does for reasoning calls | Decision |
|---|---|---|
| **VPC Service Controls (VPC-SC) perimeter** | Defines a service perimeter so inference requests, results, and the Gemini models themselves cannot leave the perimeter. Mitigates data exfiltration via the model API. (Vertex AI docs: "certain artifacts … inference requests and results, and Gemini models cannot leave your service perimeter.") | D13 (`DECISIONS.md:57`), §5 Networking |
| **CMEK (customer-managed encryption keys)** | Data at rest for the Vertex AI plane (and every store) is encrypted with Cloud KMS keys we hold, per-region keyrings. | D20 (`DECISIONS.md:74`) |
| **Data residency** | The publisher-model path pins `location` (e.g. `europe-west1` for EU tenants), keeping the call in-region — the active-active region triplet of D13. | D13 (`DECISIONS.md:57`) |
| **Access Transparency** | Google-side access to the project's Vertex resources is logged. | §5 Security |
| **Model Armor** | PI+JB / PII / RAI policies and custom regex run on every model call at the Vertex layer; the in-process `prompt_guard` is the belt-and-braces complement (`runtime.py` non-negotiable #4). | D21 (`DECISIONS.md:75`) |

> Source for the VPC-SC / data-residency / CMEK / AXT claims: Vertex AI "Security controls for Generative AI" + "VPC Service Controls with Vertex AI" docs, confirmed via Context7 (`/websites/cloud_google_vertex-ai`) on 2026-05-20.

These controls are **provisioned by Terraform**, not by this folder — see `terraform/environments/<env>/` for the VPC-SC perimeter and KMS keyrings. This folder owns only the *routing* of model calls onto that protected plane.

---

## 4. Which agent uses which Gemini model through Model Garden

All 22 agents (D23, `DECISIONS.md:82`) share the single `runtime.py` seam, so when `MODEL_GARDEN_ROUTING=true` every reasoning call below routes through the Model Garden publisher path. Models are the D5 production baseline (Gemini 2.5 family; `DECISIONS.md:44`). The model id each agent declares is what is shown; the routed path is `…/publishers/google/models/<that id>`.

| # | Agent | Tier | Declared Gemini model | Routes through Model Garden when gate on |
|---|---|---|---|---|
| 1 | `sourcing` | 1 | `gemini-2.5-pro` | yes |
| 2 | `vetting` | 1 | `gemini-2.5-pro` | yes |
| 3 | `outreach_writer` | 1 | `gemini-2.5-pro` | yes |
| 4 | `conversation` | 1 | `gemini-2.5-flash-lite` | yes |
| 5 | `conversation_responder` | 1 | `gemini-2.5-pro` | yes |
| 6 | `logistics` | 1 | `gemini-2.5-flash` | yes |
| 7 | `content_verify` | 1 | `gemini-2.5-flash` (multimodal) | yes |
| 8 | `analyst` | 1 | `gemini-2.5-pro` | yes |
| 9 | `research` | 1 | `gemini-2.5-pro` | yes |
| 10 | `intake` | 1 | `gemini-2.5-flash` | yes |
| 11 | `lead_outreach_writer` | 1 | `gemini-2.5-pro` | yes |
| 12 | `payment_mandate` | 1 | `gemini-2.5-flash` | yes |
| 13 | `compliance` | 1 | `gemini-2.5-pro` | yes |
| 14 | `creative` | 1 | `gemini-2.5-pro` (+ Imagen 4 / Veo 3 via capability layer) | yes (text reasoning) |
| 15 | `a11y` | 1 | `gemini-2.5-flash` (multimodal) | yes |
| 16 | `customer_success` | 1 | `gemini-2.5-pro` | yes |
| M1 | `coordinator` | 2 | `gemini-2.5-flash` | yes |
| M2 | `critic` | 2 | `gemini-2.5-pro` | yes |
| M3 | `optimizer` | 2 | `gemini-2.5-pro` | yes |
| W1 | `anomaly_watch` | 3 | `gemini-2.5-flash` | yes |
| W2 | `cost_watch` | 3 | `none-rule-based` (sentinel, **no LLM**) | n/a — rule-based, never calls a model |
| W3 | `security_watch` | 3 | `gemini-2.5-flash` | yes |

`cost_watch` intentionally declares a sentinel that is **absent from `MODEL_PRICING`**, so if anyone ever wires it to call a model, `model_pricing()` raises a loud `KeyError` (see `cost_watch.py` and `tests/agents/test_cost_watch.py`). It is a rule-based watchdog and has nothing to route.

### Third-party / open-source models (PDF clause)

The PDF also permits *"a third-party/open-source LLM deployed specifically through Model Garden."* The runtime supports this without code changes: deploy the model from Model Garden to a Vertex AI endpoint and set an agent's `model` to the endpoint resource —
`projects/{p}/locations/{l}/endpoints/{id}` — and `resolve_runtime_model` passes it through un-mangled (proven by `test_endpoint_resource_passes_through_when_routing_on`). No agent ships pointed at a self-deployed endpoint today; Gemini 2.5 publisher models are the baseline (D5).

---

## 5. How to activate (prod)

The agents image and Agent Runtime deploy are owned by `deploy/agents/` (`deploy/README.md`). Model Garden routing is enabled by setting the env var on that service. Two paths:

**A. On the Cloud Run / Agent Runtime service env** (the production default per D47):

```bash
# Set on the agents service env so all 22 agents route through Model Garden.
gcloud run services update ss-agents \
  --region=us-central1 \
  --update-env-vars=MODEL_GARDEN_ROUTING=true,GOOGLE_GENAI_USE_VERTEXAI=TRUE
```

`GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` are already set on the service (they drive Vertex auth); `resolve_runtime_model` reads them to build the fully-qualified publisher path.

**B. Locally / staging**, in the package-local env file (never `.env` — copy `.env.example` to `.env.local`):

```env
GOOGLE_GENAI_USE_VERTEXAI=TRUE
GOOGLE_CLOUD_PROJECT=ss-v2-prod
GOOGLE_CLOUD_LOCATION=us-central1
MODEL_GARDEN_ROUTING=true
SS_LIVE=1
```

> Per repo policy, this README does **not** edit any `.env`. The variable is documented here and in `packages/agents-adk/.env.example`.

---

## 6. Verify

### Offline (default, no cost) — the config proof

```bash
cd packages/agents-adk
uv run pytest tests/test_model_garden.py -q
# → 20 passed
```

This proves the routing string, the env gate, and pricing invariance without any GCP call. It is the gating evidence for D47.

### Live (one call, ~$0.01) — optional, operator-run

A single live invocation confirms the publisher-model path actually serves a 200. Run it with the gate on; the intake agent is the cheapest (Flash, one short turn):

```bash
cd packages/agents-adk
MODEL_GARDEN_ROUTING=true \
GOOGLE_GENAI_USE_VERTEXAI=TRUE \
GOOGLE_CLOUD_PROJECT=ss-v2-prod \
GOOGLE_CLOUD_LOCATION=us-central1 \
SS_LIVE=1 \
uv run python -m ss_agents.agents.intake "Run a Korean skincare campaign with 20 creators."
# → prints the agent outcome JSON; requires `gcloud auth application-default login`.
```

Expected: a JSON outcome (`status:"asking"` or `status:"done"`) and a non-zero `usdSpent` (~$0.005–0.01 for one Flash turn). A 200 from the Vertex Model Garden plane is what the run depends on; a routing failure surfaces as an `Escalation` outcome with a transport error reason. This call is **not** part of CI (it is the `integration`-marked path, skipped unless `SS_LIVE=1`).

---

## 7. What this folder does NOT own

- **The VPC-SC perimeter, KMS keyrings, IAM** that constitute the "strict data security" controls — `terraform/environments/<env>/` (§3 lists which decision owns each).
- **The agents image / Agent Runtime deploy** — `deploy/agents/`.
- **Model Armor policies** (D21) — `terraform/modules/` (the in-process complement is in `runtime.py`).
- **Self-deploying an open-source model to a Model Garden endpoint** — a one-time `gcloud ai model-garden models deploy` the operator runs; the runtime only consumes the resulting endpoint resource.

---

## 8. Quick links

- D47 (route through Model Garden): `gcp-research/decisions/DECISIONS.md:148`
- D5 (Gemini 2.5 baseline): `gcp-research/decisions/DECISIONS.md:44`
- D13 (3-region active-active / data residency): `gcp-research/decisions/DECISIONS.md:57`
- D20 (CMEK + Secret Manager + DLP): `gcp-research/decisions/DECISIONS.md:74`
- D21 (Model Armor): `gcp-research/decisions/DECISIONS.md:75`
- D23 (22 agents): `gcp-research/decisions/DECISIONS.md:82`
- Config seam: `packages/agents-adk/src/ss_agents/config.py` (`resolve_runtime_model`)
- Runtime seam: `packages/agents-adk/src/ss_agents/runtime.py` (`_run_with_adk`)
- Tests: `packages/agents-adk/tests/test_model_garden.py`
