"""Integration test for the LIVE ADK reasoning path (`runtime._run_with_adk`).

Closes review gaps **G2** + **G3** ([[project_v2_track3_review]], 2026-05-20):

* **G3** — `tests/conftest.py` forces `SS_OFFLINE=1` on every test, so the only
  place a real Gemini call is issued (`_run_with_adk`) was never exercised:
  real-reasoning code coverage was 0%. This module overrides that fixture
  (in-body monkeypatch *after* the autouse fixture has run) so `is_offline()`
  returns False and `run_agent` dispatches to `_run_with_adk` — without any
  live Vertex call. The whole ADK layer (`LlmAgent`, `InMemoryRunner`,
  `google.genai.types`) is mocked, so this is CI-safe: no credentials, no
  network, no billing.

* **G2 / D47** — Track 3 official requirement #3 is "route LLM reasoning through
  Model Garden". The routing seam exists (`config.resolve_runtime_model` +
  `MODEL_GARDEN_ROUTING`; `runtime._run_with_adk` hands its result to
  `LlmAgent(model=…)`). The Model-Garden *config* unit tests
  (`tests/test_model_garden.py`) prove the string is built correctly, but
  nothing proved the publisher path is what actually reaches the model layer.
  Here we capture the `model=` kwarg the fake `LlmAgent` constructor receives
  and assert it equals `config.model_garden_model_path(...)` — proving D47's
  rewrite reaches the one place an LLM is constructed.

Honest scoping (RULES.md, GRAND-NARRATIVE-PLAN.md §7): this offline test proves
the *wiring* (the Model Garden publisher path reaches `LlmAgent`, cost
accounting still keys off the short id). It does NOT make a live Model Garden
call. The live 200 is verified separately by the operator-run, SS_LIVE-gated
smoke `scripts/smoke-test/model_garden_live_smoke.py` (~$0.01/run).

Citations:
    D47 — Route LLM reasoning through Model Garden (designed_guide.pdf req #3).
    D5  — Gemini 3.1 Flash-Lite baseline for the intake agent.
    D17 — Vertex AI Agent Runtime is the path `_run_with_adk` constructs against.
"""
from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest

from ss_agents.agents.intake import (
    AskingOutput,
    IntakeOutputWrapper,
    intake_agent_def,
)
from ss_agents.runtime import OutcomeOk, RunContext, run_agent

# This whole module exercises the live-dispatch path; mark it so it groups with
# the operator-gated live work even though every dependency here is mocked.
pytestmark = pytest.mark.integration


# The cost the fake Vertex usage_metadata yields. Picked so the routed run's
# usd_spent is non-zero and well under the intake agent's $0.20 cap.
_FAKE_AGENT_USD = 0.007

# A canonical, schema-valid "asking" response the fake model emits as the final
# event text. Must be parseable by intake's output_schema (IntakeOutputWrapper).
_FINAL_RESPONSE_JSON = IntakeOutputWrapper(
    result=AskingOutput(
        status="asking",
        question="How many creators and in which language should we target?",
        fieldFocus="targeting",
    )
).model_dump_json(by_alias=True)


# ─────────────────────────────────────────────────────────────────────────────
# Fakes for the ADK layer. `_run_with_adk` lazy-imports these from their source
# modules, so we patch the source modules (not a runtime-local alias).
# ─────────────────────────────────────────────────────────────────────────────


class _FakePart:
    """Stand-in for google.genai.types.Part — only `.text` is read."""

    def __init__(self, *, text: str | None = None) -> None:
        self.text = text


class _FakeContent:
    """Stand-in for google.genai.types.Content — only `.parts` is read."""

    def __init__(self, *, role: str = "model", parts: list[Any] | None = None) -> None:
        self.role = role
        self.parts = parts or []


class _FakeSchema:
    """Stand-in for google.genai.types.Schema — `_SchemaFunctionTool` only
    calls `model_validate(dict)` and hands the result to FunctionDeclaration."""

    @classmethod
    def model_validate(cls, data: Any) -> Any:
        return data


class _FakeFunctionDeclaration:
    """Stand-in for google.genai.types.FunctionDeclaration — only constructed,
    never introspected (the fake LlmAgent ignores tool declarations)."""

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs


class _FakeGenaiTypes:
    """Mimics `from google.genai import types as genai_types` — the constructors
    `_run_with_adk` + `_SchemaFunctionTool` reach for."""

    Part = _FakePart
    Content = _FakeContent
    Schema = _FakeSchema
    FunctionDeclaration = _FakeFunctionDeclaration


class _FakeEvent:
    """Stand-in for an ADK Event. `_run_with_adk` calls `is_final_response()`
    and reads `.content.parts[0].text`."""

    def __init__(self, *, content: _FakeContent, final: bool) -> None:
        self.content = content
        self._final = final

    def is_final_response(self) -> bool:
        return self._final


class _FakeSession:
    """Stand-in for the ADK session. `_run_with_adk` reads `.id` and `.state`.

    `state` carries `agent_usd_spent` (the real `cost_record` callback would
    populate this from Vertex usage_metadata) so the runtime tallies a non-zero
    cost — proving cost accounting survives the Model Garden rewrite.
    """

    def __init__(self) -> None:
        self.id = "fake-session-1"
        self.state: dict[str, Any] = {"agent_usd_spent": _FAKE_AGENT_USD}


class _FakeSessionService:
    async def create_session(self, *, app_name: str, user_id: str) -> _FakeSession:
        return _FakeSession()


class _FakeInMemoryRunner:
    """Stand-in for google.adk.runners.InMemoryRunner.

    Records nothing about the model (the LlmAgent capture happens in the fake
    LlmAgent), yields exactly one final-response event whose text is a valid
    JSON string for the intake output schema.
    """

    def __init__(self, *, agent: Any, app_name: str) -> None:
        self.agent = agent
        self.app_name = app_name
        self.session_service = _FakeSessionService()

    async def run_async(
        self, *, user_id: str, session_id: str, new_message: Any
    ) -> AsyncIterator[_FakeEvent]:
        # One final event carrying the structured JSON response.
        yield _FakeEvent(
            content=_FakeContent(parts=[_FakePart(text=_FINAL_RESPONSE_JSON)]),
            final=True,
        )


def _install_adk_fakes(
    monkeypatch: pytest.MonkeyPatch,
) -> dict[str, Any]:
    """Patch the ADK + genai imports `_run_with_adk` reaches for, and return a
    mutable dict that captures the kwargs handed to the fake `LlmAgent`.

    Because `_run_with_adk` does `from google.adk.agents import LlmAgent` (etc.)
    *inside the function*, we must patch the attribute on the source module so
    the fresh import binds to the fake.
    """
    captured: dict[str, Any] = {}

    class _FakeLlmAgent:
        def __init__(self, **kwargs: Any) -> None:
            captured["llm_agent_kwargs"] = kwargs

    import google.adk.agents as adk_agents
    import google.adk.runners as adk_runners
    import google.genai as genai

    monkeypatch.setattr(adk_agents, "LlmAgent", _FakeLlmAgent, raising=True)
    monkeypatch.setattr(adk_runners, "InMemoryRunner", _FakeInMemoryRunner, raising=True)
    monkeypatch.setattr(genai, "types", _FakeGenaiTypes, raising=True)
    return captured


def _go_live(
    monkeypatch: pytest.MonkeyPatch,
    *,
    model_garden_routing: bool,
    project: str = "ss-v2-prod",
    location: str = "us-central1",
) -> None:
    """Undo the autouse `_isolate_env` offline pin so `_run_with_adk` is taken.

    The conftest autouse fixture has already set SS_LIVE=0 + SS_OFFLINE=1 and
    reset the settings cache by the time this runs. We flip them back here and
    re-reset the cache so `is_offline()` returns False for THIS test.
    """
    monkeypatch.setenv("SS_LIVE", "1")
    monkeypatch.delenv("SS_OFFLINE", raising=False)
    monkeypatch.setenv(
        "MODEL_GARDEN_ROUTING", "true" if model_garden_routing else "false"
    )
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", project)
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", location)

    from ss_agents.config import is_offline, reset_settings_cache

    reset_settings_cache()
    # Guard the precondition: if this is False, the test would silently take the
    # stub path and prove nothing.
    assert is_offline() is False, "expected live ADK dispatch; is_offline() is True"


# ─────────────────────────────────────────────────────────────────────────────
# G2 + G3: the Model Garden publisher path reaches LlmAgent(model=…).
# ─────────────────────────────────────────────────────────────────────────────


async def test_run_with_adk_routes_model_garden_path_to_llm_agent(
    monkeypatch: pytest.MonkeyPatch,
    run_context: RunContext,
    intake_input_ko: Any,
) -> None:
    """With MODEL_GARDEN_ROUTING=true, `_run_with_adk` must construct the
    `LlmAgent` with the Vertex AI Model Garden publisher-model path (D47),
    NOT the bare short id — proving the routing seam reaches the model layer.
    """
    from ss_agents.config import model_garden_model_path

    _go_live(monkeypatch, model_garden_routing=True)
    captured = _install_adk_fakes(monkeypatch)

    # ctx.model_client MUST be None so run_agent step 5 dispatches to the live
    # ADK path (not the stub). The default RunContext fixture leaves it None.
    assert run_context.model_client is None

    outcome = await run_agent(intake_agent_def, intake_input_ko, run_context)

    # ── The load-bearing assertion (G2): the publisher path reached LlmAgent ──
    expected_model = model_garden_model_path(
        intake_agent_def.model, project="ss-v2-prod", location="us-central1"
    )
    assert expected_model == (
        "projects/ss-v2-prod/locations/us-central1"
        "/publishers/google/models/gemini-3.1-flash-lite"
    )
    assert captured["llm_agent_kwargs"]["model"] == expected_model

    # And the agent name/instruction were wired through too (sanity).
    assert captured["llm_agent_kwargs"]["name"] == "intake"
    assert captured["llm_agent_kwargs"]["instruction"]

    # ── G3: the real reasoning path produced a validated outcome + real cost ──
    assert isinstance(outcome, OutcomeOk)
    assert isinstance(outcome.value, IntakeOutputWrapper)
    assert outcome.value.result.status == "asking"
    # Cost accounting (keyed off the short id, unaffected by the rewrite) is the
    # value the fake session carried in agent_usd_spent.
    assert outcome.usd_spent == pytest.approx(_FAKE_AGENT_USD)
    assert outcome.usd_spent > 0.0
    # Round-trip the captured model string to its short id and confirm pricing
    # still resolves (the budget guard never KeyErrors on the routed path).
    from ss_agents.config import canonical_model_id, model_pricing

    assert canonical_model_id(captured["llm_agent_kwargs"]["model"]) == "gemini-3.1-flash-lite"
    assert model_pricing(captured["llm_agent_kwargs"]["model"]) == model_pricing(
        intake_agent_def.model
    )


async def test_run_with_adk_passes_short_id_when_routing_off(
    monkeypatch: pytest.MonkeyPatch,
    run_context: RunContext,
    intake_input_ko: Any,
) -> None:
    """The seam's other branch: MODEL_GARDEN_ROUTING=false → the bare short id
    reaches `LlmAgent` unchanged (the Vertex backend still resolves it, but the
    wire string is the short form). Proves the gate is honored at the model
    construction site, not just in `resolve_runtime_model` in isolation.
    """
    _go_live(monkeypatch, model_garden_routing=False)
    captured = _install_adk_fakes(monkeypatch)

    outcome = await run_agent(intake_agent_def, intake_input_ko, run_context)

    assert captured["llm_agent_kwargs"]["model"] == intake_agent_def.model
    assert captured["llm_agent_kwargs"]["model"] == "gemini-3.1-flash-lite"
    # "/" is the publisher/endpoint marker; the short id must NOT contain one.
    assert "/" not in captured["llm_agent_kwargs"]["model"]

    assert isinstance(outcome, OutcomeOk)
    assert outcome.usd_spent == pytest.approx(_FAKE_AGENT_USD)
