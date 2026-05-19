"""Runtime configuration — Vertex AI project/region/model, observability, budget.

Loaded via pydantic-settings so env vars are validated once at startup and the
rest of the package uses typed accessors.

Citations:
    D5  — Gemini 2.5 baseline; 3.1 Preview only for final demo.
    D17 — Vertex AI Agent Runtime.
    D39 — $1500 GCP credits (default daily ceiling lifted from $5 to $25).
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
# conversational agents is gemini-2.5-flash. Pro/Flash-Lite are agent-specific.
DEFAULT_INTAKE_MODEL = "gemini-2.5-flash"

# Gemini 2.5 Flash pricing (2026 H1, Vertex AI list).
# https://cloud.google.com/vertex-ai/generative-ai/pricing
GEMINI_25_FLASH_INPUT_PER_TOKEN = 0.30 / 1_000_000   # $0.30 / 1M input tokens
GEMINI_25_FLASH_OUTPUT_PER_TOKEN = 2.50 / 1_000_000  # $2.50 / 1M output tokens

# Gemini 2.5 Pro pricing (2026 H1).
GEMINI_25_PRO_INPUT_PER_TOKEN = 1.25 / 1_000_000     # $1.25 / 1M input tokens
GEMINI_25_PRO_OUTPUT_PER_TOKEN = 10.00 / 1_000_000   # $10.00 / 1M output tokens

# Gemini 2.5 Flash-Lite pricing (2026 H1).
GEMINI_25_FLASH_LITE_INPUT_PER_TOKEN = 0.10 / 1_000_000
GEMINI_25_FLASH_LITE_OUTPUT_PER_TOKEN = 0.40 / 1_000_000


# Map model id → (input_$/tok, output_$/tok). Used by cost_record callback.
MODEL_PRICING: dict[str, tuple[float, float]] = {
    "gemini-2.5-pro": (
        GEMINI_25_PRO_INPUT_PER_TOKEN,
        GEMINI_25_PRO_OUTPUT_PER_TOKEN,
    ),
    "gemini-2.5-flash": (
        GEMINI_25_FLASH_INPUT_PER_TOKEN,
        GEMINI_25_FLASH_OUTPUT_PER_TOKEN,
    ),
    "gemini-2.5-flash-lite": (
        GEMINI_25_FLASH_LITE_INPUT_PER_TOKEN,
        GEMINI_25_FLASH_LITE_OUTPUT_PER_TOKEN,
    ),
    # Preview model — pricing same as 2.5 Pro per Gemini 3.1 Pro Preview pricing
    # notice (2026-Q2 console announcement). Update when GA hits.
    "gemini-3.1-pro-preview": (
        GEMINI_25_PRO_INPUT_PER_TOKEN,
        GEMINI_25_PRO_OUTPUT_PER_TOKEN,
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


def model_pricing(model_id: str) -> tuple[float, float]:
    """Return (input_$/tok, output_$/tok) for a Gemini model id.

    Raises:
        KeyError: when the model is unknown. Caller is expected to validate the
                  model id via the Pydantic ModelId enum first.
    """
    if model_id not in MODEL_PRICING:
        raise KeyError(
            f"Unknown model id {model_id!r}. Valid: {sorted(MODEL_PRICING.keys())}"
        )
    return MODEL_PRICING[model_id]


def is_offline() -> bool:
    """True when we should NOT call live Vertex AI.

    The runtime injects a stub model client in this case. See tests/conftest.py.
    """
    return not get_settings().ss_live or os.environ.get("SS_OFFLINE") == "1"
