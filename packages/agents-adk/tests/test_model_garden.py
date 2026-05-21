"""Tests for Model Garden routing (D47 — Track 3 designed_guide.pdf req #3).

These prove the config seam that routes LLM reasoning through the Vertex AI
Model Garden plane:

1. The `MODEL_GARDEN_ROUTING` gate defaults OFF (stub/dev/CI unaffected).
2. `model_garden_model_path` emits the correct publisher-model resource path,
   in both the location-free short form and the fully-qualified form.
3. `resolve_runtime_model` honors the env gate end-to-end.
4. `canonical_model_id` / `model_pricing` round-trip a publisher path back to
   its short id so cost accounting is identical whether or not routing is on.
5. A real agent (`intake`) resolves to a Model Garden publisher path when the
   gate is on, and to its bare short id when off.
6. Self-deployed Model Garden endpoint resources (the "third-party/open-source
   LLM deployed specifically through Model Garden" clause) pass through
   un-mangled.

No live Vertex call is required — this is the env-gated config proof. The
single live call (cost ~$0.01) is documented in deploy/model-garden/README.md
§"Verify"; it is an `integration`-marked path, skipped by default.
"""
from __future__ import annotations

import pytest

from ss_agents.config import (
    MODEL_PRICING,
    canonical_model_id,
    get_settings,
    model_garden_model_path,
    model_pricing,
    reset_settings_cache,
    resolve_runtime_model,
)

# ─────────────────────────────────────────────────────────────────────────────
# 1. Gate defaults OFF.
# ─────────────────────────────────────────────────────────────────────────────


def test_routing_gate_defaults_off(monkeypatch: pytest.MonkeyPatch) -> None:
    """With no MODEL_GARDEN_ROUTING env var, routing is off — stub/dev path."""
    monkeypatch.delenv("MODEL_GARDEN_ROUTING", raising=False)
    reset_settings_cache()
    assert get_settings().model_garden_routing is False


@pytest.mark.parametrize("truthy", ["true", "TRUE", "1", "yes"])
def test_routing_gate_enabled(monkeypatch: pytest.MonkeyPatch, truthy: str) -> None:
    monkeypatch.setenv("MODEL_GARDEN_ROUTING", truthy)
    reset_settings_cache()
    assert get_settings().model_garden_routing is True


# ─────────────────────────────────────────────────────────────────────────────
# 2. Publisher-model path construction.
# ─────────────────────────────────────────────────────────────────────────────


def test_short_form_publisher_path() -> None:
    """No project/location → location-free publisher path."""
    assert (
        model_garden_model_path("gemini-3.1-flash-lite")
        == "publishers/google/models/gemini-3.1-flash-lite"
    )


def test_fully_qualified_publisher_path() -> None:
    assert model_garden_model_path(
        "gemini-3.1-pro",
        project="ss-v2-prod",
        location="us-central1",
    ) == (
        "projects/ss-v2-prod/locations/us-central1"
        "/publishers/google/models/gemini-3.1-pro"
    )


def test_already_qualified_path_passes_through() -> None:
    """A path that already contains a slash (publisher or endpoint resource) is
    returned unchanged — we must not double-wrap or mangle it."""
    endpoint = "projects/ss-v2-prod/locations/us-central1/endpoints/123456"
    assert model_garden_model_path(endpoint) == endpoint
    pub = "publishers/google/models/gemini-3.1-flash-lite"
    assert model_garden_model_path(pub) == pub


# ─────────────────────────────────────────────────────────────────────────────
# 3. resolve_runtime_model honors the gate.
# ─────────────────────────────────────────────────────────────────────────────


def test_resolve_runtime_model_off_is_identity(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MODEL_GARDEN_ROUTING", raising=False)
    reset_settings_cache()
    assert resolve_runtime_model("gemini-3.1-flash-lite") == "gemini-3.1-flash-lite"


def test_resolve_runtime_model_on_rewrites(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MODEL_GARDEN_ROUTING", "true")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "ss-v2-prod")
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "europe-west1")
    reset_settings_cache()
    assert resolve_runtime_model("gemini-3.1-flash-lite") == (
        "projects/ss-v2-prod/locations/europe-west1"
        "/publishers/google/models/gemini-3.1-flash-lite"
    )


# ─────────────────────────────────────────────────────────────────────────────
# 4. Pricing is invariant to the model-string form.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("model_id", sorted(MODEL_PRICING.keys()))
def test_canonical_id_round_trips_publisher_path(model_id: str) -> None:
    pub = f"publishers/google/models/{model_id}"
    qualified = f"projects/p/locations/l/publishers/google/models/{model_id}"
    assert canonical_model_id(model_id) == model_id
    assert canonical_model_id(pub) == model_id
    assert canonical_model_id(qualified) == model_id


@pytest.mark.parametrize("model_id", sorted(MODEL_PRICING.keys()))
def test_pricing_identical_for_short_and_publisher_path(model_id: str) -> None:
    short = model_pricing(model_id)
    via_path = model_pricing(f"publishers/google/models/{model_id}")
    via_qualified = model_pricing(
        f"projects/p/locations/l/publishers/google/models/{model_id}"
    )
    assert short == via_path == via_qualified


# ─────────────────────────────────────────────────────────────────────────────
# 5. A real agent resolves through Model Garden when the gate is on.
# ─────────────────────────────────────────────────────────────────────────────


def test_intake_agent_routes_through_model_garden(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The intake agent (Gemini 3.1 Flash-Lite) resolves to a Model Garden publisher
    path when routing is on, and to its short id when off — the model_pricing
    lookup must succeed in both cases (proving the budget guard is intact)."""
    from ss_agents.agents.intake import intake_agent_def

    declared = intake_agent_def.model
    assert declared == "gemini-3.1-flash-lite"

    monkeypatch.setenv("MODEL_GARDEN_ROUTING", "true")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "ss-v2-prod")
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "us-central1")
    reset_settings_cache()

    routed = resolve_runtime_model(declared)
    assert routed == (
        "projects/ss-v2-prod/locations/us-central1"
        "/publishers/google/models/gemini-3.1-flash-lite"
    )
    # Cost accounting still keys off the declared short id — must not KeyError.
    assert model_pricing(declared) == MODEL_PRICING["gemini-3.1-flash-lite"]

    monkeypatch.setenv("MODEL_GARDEN_ROUTING", "false")
    reset_settings_cache()
    assert resolve_runtime_model(declared) == declared


# ─────────────────────────────────────────────────────────────────────────────
# 6. Open-source / third-party endpoint clause: pass an endpoint resource as the
#    model and routing must leave it untouched.
# ─────────────────────────────────────────────────────────────────────────────


def test_endpoint_resource_passes_through_when_routing_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MODEL_GARDEN_ROUTING", "true")
    reset_settings_cache()
    endpoint = "projects/ss-v2-prod/locations/us-central1/endpoints/987654"
    assert resolve_runtime_model(endpoint) == endpoint
