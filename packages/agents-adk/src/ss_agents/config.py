"""Runtime configuration — Vertex AI project/region/model, observability, budget.

Loaded via pydantic-settings so env vars are validated once at startup and the
rest of the package uses typed accessors.

Citations:
    D5  — Gemini model tiers. (Superseded by D53: Google AI Agents Challenge
          mandates the Gemini 3.1 series exclusively, so the fleet runs on
          gemini-3.1-pro and gemini-3.1-flash-lite — no 2.5 ids remain.)
    D53 — Gemini 3.1-only mandate (operator override, 2026-05-20). Every agent
          uses exactly one of two ids: `gemini-3.1-pro` (judgment tier) or
          `gemini-3.1-flash-lite` (bulk/flash tier).
    D17 — Vertex AI Agent Runtime.
    D39 — $1500 GCP credits (default daily ceiling lifted from $5 to $25).
    D47 — Route LLM reasoning through Model Garden (Track 3 designed_guide.pdf
          requirement #3). When `MODEL_GARDEN_ROUTING=true` the runtime rewrites
          each agent's short Gemini id (e.g. `gemini-3.1-flash-lite`) into the
          Vertex AI Model Garden publisher-model resource path
          (`projects/{project}/locations/{location}/publishers/google/models/
          gemini-3.1-flash-lite`) before constructing the ADK `LlmAgent`. This pins
          reasoning to the Vertex-served Model Garden plane — the same plane the
          "strict data security" controls (VPC Service Controls perimeter, CMEK,
          data residency per D13/D20) are enforced on — rather than the public
          AI Studio `generativelanguage.googleapis.com` endpoint. See
          deploy/model-garden/README.md.
"""
from __future__ import annotations

import os
from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Default GCP region matches ADK-GUIDE.md §1.1 example and most Vertex AI quickstarts.
DEFAULT_REGION = "us-central1"

# Per spec/sourcing.spec.md and intake.spec.md, the production model for
# conversational/bulk agents is gemini-3.1-flash-lite. Pro is agent-specific.
# D53: the fleet is Gemini 3.1-only (Google AI Agents Challenge mandate).
DEFAULT_INTAKE_MODEL = "gemini-3.1-flash-lite"

# Gemini 3.1 Pro pricing (Preview 2026-02-19, Vertex AI list).
# https://cloud.google.com/vertex-ai/generative-ai/pricing
GEMINI_31_PRO_INPUT_PER_TOKEN = 2.00 / 1_000_000     # $2.00 / 1M input tokens
GEMINI_31_PRO_OUTPUT_PER_TOKEN = 12.00 / 1_000_000   # $12.00 / 1M output tokens

# Gemini 3.1 Flash-Lite pricing (GA Apr 2026).
GEMINI_31_FLASH_LITE_INPUT_PER_TOKEN = 0.25 / 1_000_000   # $0.25 / 1M input tokens
GEMINI_31_FLASH_LITE_OUTPUT_PER_TOKEN = 1.50 / 1_000_000  # $1.50 / 1M output tokens


# Map model id → (input_$/tok, output_$/tok). Used by cost_record callback.
# D53: exactly two ids — gemini-3.1-pro (judgment) and gemini-3.1-flash-lite (bulk).
MODEL_PRICING: dict[str, tuple[float, float]] = {
    "gemini-3.1-pro": (
        GEMINI_31_PRO_INPUT_PER_TOKEN,
        GEMINI_31_PRO_OUTPUT_PER_TOKEN,
    ),
    "gemini-3.1-flash-lite": (
        GEMINI_31_FLASH_LITE_INPUT_PER_TOKEN,
        GEMINI_31_FLASH_LITE_OUTPUT_PER_TOKEN,
    ),
}


class Settings(BaseSettings):
    """Process-wide configuration loaded from environment.

    All fields are required for live Vertex AI runs; pytest sets sane defaults
    so the suite passes with no env file.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ── Vertex AI / Gemini ────────────────────────────────────────────
    google_genai_use_vertexai: bool = Field(default=True, alias="GOOGLE_GENAI_USE_VERTEXAI")
    google_cloud_project: str = Field(default="ss-v2-dev", alias="GOOGLE_CLOUD_PROJECT")
    google_cloud_location: str = Field(default=DEFAULT_REGION, alias="GOOGLE_CLOUD_LOCATION")
    google_api_key: str | None = Field(default=None, alias="GOOGLE_API_KEY")

    # ── Model Garden routing (D47, Track 3 designed_guide.pdf req #3) ──
    model_garden_routing: bool = Field(default=False, alias="MODEL_GARDEN_ROUTING")
    """When True, each agent's short Gemini id is rewritten into the Vertex AI
    Model Garden publisher-model resource path before the ADK `LlmAgent` is
    built — pinning reasoning to the Vertex-served Model Garden plane (the plane
    VPC-SC / CMEK / data-residency are enforced on, per D13/D20). When False the
    runtime passes the short id straight through, which the `google-genai`
    Vertex backend still resolves to the same publisher model — used for dev/CI
    where the verbose path adds nothing. Gated, not always-on, so stub tests and
    local runs are unaffected. Prod sets `MODEL_GARDEN_ROUTING=true`."""

    # ── App-level toggles ─────────────────────────────────────────────
    ss_environment: Literal["dev", "test", "staging", "prod"] = Field(
        default="dev", alias="SS_ENVIRONMENT"
    )
    ss_live: bool = Field(default=False, alias="SS_LIVE")
    """When False, run_agent uses the stub model client (set in tests).

    Live integration tests opt in with `SS_LIVE=1 pytest -m integration`."""

    # ── Cost guardrails ───────────────────────────────────────────────
    ss_default_max_usd: float = Field(default=0.20, alias="SS_DEFAULT_MAX_USD")
    """Per-invocation USD cap when AgentDef.max_usd is not set."""

    ss_default_campaign_budget_usd: float = Field(default=25.00, alias="SS_DEFAULT_CAMPAIGN_BUDGET_USD")
    """Per-campaign daily USD ceiling. D39 lifted this from $5 → $25."""

    # ── Observability ─────────────────────────────────────────────────
    otel_service_name: str = Field(default="ss-agents-adk", alias="OTEL_SERVICE_NAME")
    otel_enabled: bool = Field(default=False, alias="SS_OTEL_ENABLED")
    """Cloud Trace export is off by default in tests; CI/staging set it on."""

    # ── Firestore (Memory Bank backing per D15) ───────────────────────
    firestore_database: str = Field(default="(default)", alias="FIRESTORE_DATABASE")

    # ── Agent Memory Bank backend selection (D15) ─────────────────────
    memory_backend: Literal["stub", "firestore", "vertex"] = Field(
        default="firestore", alias="MEMORY_BACKEND"
    )
    """Which backend powers the Agent Memory Bank (D15).

    * ``firestore`` (default) — the Firestore key→payload store with the
      in-memory fallback. Offline/CI safe; this is what every existing test and
      `/goal` run uses.
    * ``stub`` — force the deterministic capability stub regardless of
      `CAPABILITY_LAYER_MODE`.
    * ``vertex`` — the REAL managed Vertex AI Agent Engine **Memory Bank** (GA).
      Operator-gated: requires `VERTEX_AGENT_ENGINE` + ADC (see the runbook in
      `memory/vertex_memory_bank.py`). When the managed backend is unreachable
      the read path falls back to the existing capability dispatch so a
      misconfigured prod never hard-fails an agent run."""

    vertex_agent_engine: str | None = Field(default=None, alias="VERTEX_AGENT_ENGINE")
    """Agent Engine (reasoning engine) resource owning the managed Memory Bank.
    Bare id (`1234567890`) or full
    `projects/{p}/locations/{l}/reasoningEngines/{id}`. Required only when
    `MEMORY_BACKEND=vertex`."""

    @property
    def vertex_init_kwargs(self) -> dict[str, str]:
        """Args for google.cloud.aiplatform.init() / vertexai.init()."""
        return {
            "project": self.google_cloud_project,
            "location": self.google_cloud_location,
        }


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Singleton settings accessor. Memoised so re-reading is free."""
    return Settings()


def reset_settings_cache() -> None:
    """Invalidate the cached settings — used by tests after monkeypatching env."""
    get_settings.cache_clear()


# Model Garden / Vertex AI publisher-model path components (D47).
# A publisher-model resource is addressed as
#   projects/{project}/locations/{location}/publishers/{publisher}/models/{model}
# Gemini's publisher is always "google". The short, location-free form
#   publishers/google/models/{model}
# is also accepted by the google-genai Vertex backend and is what we emit in
# dev where project/location come from GOOGLE_CLOUD_* env vars instead.
MODEL_GARDEN_PUBLISHER = "google"


def canonical_model_id(model_ref: str) -> str:
    """Normalize any model reference to its bare Gemini id.

    Accepts the short id (`gemini-3.1-flash-lite`), a Model Garden publisher path
    (`publishers/google/models/gemini-3.1-flash-lite`), or a fully-qualified
    publisher resource (`projects/p/locations/l/publishers/google/models/
    gemini-3.1-flash-lite`) and returns just `gemini-3.1-flash-lite`. Endpoint resources
    (`projects/.../endpoints/...`) have no resolvable short id, so they are
    returned unchanged — `model_pricing` will then KeyError loudly, which is the
    intended signal that a self-deployed endpoint needs an explicit pricing row.
    """
    if "/models/" in model_ref:
        return model_ref.rsplit("/models/", 1)[-1]
    return model_ref


def model_pricing(model_ref: str) -> tuple[float, float]:
    """Return (input_$/tok, output_$/tok) for a Gemini model reference.

    `model_ref` may be the short id or a Model Garden publisher path (D47); it
    is normalized via `canonical_model_id` before the pricing lookup so cost
    accounting is identical whether or not Model Garden routing is on.

    Raises:
        KeyError: when the model is unknown. Caller is expected to validate the
                  model id via the Pydantic ModelId enum first.
    """
    model_id = canonical_model_id(model_ref)
    if model_id not in MODEL_PRICING:
        raise KeyError(
            f"Unknown model id {model_id!r}. Valid: {sorted(MODEL_PRICING.keys())}"
        )
    return MODEL_PRICING[model_id]


def model_garden_model_path(
    model_id: str,
    *,
    project: str | None = None,
    location: str | None = None,
) -> str:
    """Rewrite a short Gemini id into a Vertex AI Model Garden publisher path (D47).

    Returns the fully-qualified resource path when both `project` and
    `location` are supplied:
        projects/{project}/locations/{location}/publishers/google/models/{model}
    otherwise the location-free short form the google-genai Vertex backend also
    resolves:
        publishers/google/models/{model}

    Inputs that are already a publisher/endpoint resource path (contain a "/")
    are returned unchanged — callers may pin a self-deployed Model Garden
    endpoint (e.g. an open-source LLM per the designed_guide.pdf "third-party/
    open-source LLM deployed specifically through Model Garden" clause) by
    passing its `projects/.../endpoints/...` resource directly as the agent's
    model, and we must not mangle that.
    """
    if "/" in model_id:
        return model_id
    bare = canonical_model_id(model_id)
    if project and location:
        return (
            f"projects/{project}/locations/{location}"
            f"/publishers/{MODEL_GARDEN_PUBLISHER}/models/{bare}"
        )
    return f"publishers/{MODEL_GARDEN_PUBLISHER}/models/{bare}"


def resolve_runtime_model(model_id: str) -> str:
    """Return the model string to hand the ADK `LlmAgent`, honoring D47.

    When `MODEL_GARDEN_ROUTING=true` the short id is rewritten to the Model
    Garden publisher path (using the configured project/location); otherwise the
    short id is returned unchanged. This is the single seam the runtime uses so
    that Model Garden routing is one env-var flip with no per-agent edits.
    """
    settings = get_settings()
    if not settings.model_garden_routing:
        return model_id
    return model_garden_model_path(
        model_id,
        project=settings.google_cloud_project,
        location=settings.google_cloud_location,
    )


def is_offline() -> bool:
    """True when we should NOT call live Vertex AI.

    The runtime injects a stub model client in this case. See tests/conftest.py.
    """
    return not get_settings().ss_live or os.environ.get("SS_OFFLINE") == "1"
