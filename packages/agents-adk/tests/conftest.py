"""pytest fixtures + Gemini stub for offline test runs.

Per `gcp-research/tests/MATRIX.md §4.3`:
    The 16 specs share these fixtures under `tests/conftest.py`.

This file is the canonical fixture surface. Phase 3 adds:
    - `tiktok_creator`        — fake creator profile matching v2's golden test fixture
    - `brand_brief`           — the Hydra Serum brief used across goldens
    - `vertex_live`           — marker fixture to skip on SS_LIVE=0
"""
from __future__ import annotations

import datetime as dt
import os
from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest
from pydantic import BaseModel

from ss_agents.agents.intake import (
    AskingOutput,
    BrandProduct,
    CampaignBrief,
    DoneOutput,
    Goals,
    IntakeInput,
    IntakeMessage,
    IntakeOutputWrapper,
    Logistics,
    Targeting,
)
from ss_agents.runtime import RunContext


# ─────────────────────────────────────────────────────────────────────────────
# Environment isolation — pytest must not bleed real GCP credentials into
# tests. Force SS_LIVE off + clear ambient GOOGLE_* unless explicitly opted in.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Run every test with SS_LIVE=0 unless the test marks itself integration."""
    if os.environ.get("SS_LIVE") != "1":
        monkeypatch.setenv("SS_LIVE", "0")
    monkeypatch.setenv("SS_OFFLINE", "1")
    monkeypatch.setenv("SS_OTEL_ENABLED", "false")
    # Reset settings cache so env vars take effect for this test.
    from ss_agents.config import reset_settings_cache

    reset_settings_cache()
    yield
    reset_settings_cache()


# ─────────────────────────────────────────────────────────────────────────────
# Stub model client — the substitute for live Vertex AI.
# ─────────────────────────────────────────────────────────────────────────────


class ScriptedStub:
    """A stub model client that returns scripted Pydantic outputs.

    Test pattern:
        stub = ScriptedStub(turns=[AskingOutput(...), DoneOutput(...)])
        ctx = RunContext(..., model_client=stub)
        outcome1 = await run_agent(def, input1, ctx)  # asking
        outcome2 = await run_agent(def, input2, ctx)  # done

    The stub returns the *wrapper* output (IntakeOutputWrapper) on each call.
    USD cost per call is set via `usd_per_call`. The stub respects
    `error_on_call` so tests can simulate Vertex-side failures.
    """

    def __init__(
        self,
        *,
        turns: list[BaseModel],
        usd_per_call: float = 0.005,
        error_on_call: int | None = None,
    ):
        self._turns: list[BaseModel] = list(turns)
        self._usd_per_call = usd_per_call
        self._error_on_call = error_on_call
        self._call_count = 0
        self._stub_usd = 0.0
        self.calls_seen: list[dict[str, Any]] = []

    async def generate(
        self,
        *,
        agent_id: str,
        system_prompt: str,
        input_payload: BaseModel,
        output_schema: type[BaseModel],
    ) -> BaseModel:
        self._call_count += 1
        self.calls_seen.append(
            {
                "agent_id": agent_id,
                "system_prompt_len": len(system_prompt),
                "input_payload": input_payload.model_dump(by_alias=True),
                "output_schema": output_schema.__name__,
            }
        )
        if self._error_on_call is not None and self._call_count == self._error_on_call:
            raise RuntimeError("scripted vertex failure")
        # Per-invocation cost (the runtime reads _stub_usd to compute the
        # ‘usd_spent’ for THIS invocation only). Reset to the per-call cost so
        # multi-turn tests see each turn's cost in isolation.
        self._stub_usd = self._usd_per_call
        if not self._turns:
            raise RuntimeError("ScriptedStub: no more scripted turns")
        next_output = self._turns.pop(0)
        return next_output


@pytest.fixture
def make_stub() -> Iterator[Any]:
    """Factory that builds a ScriptedStub. Use as:

        stub = make_stub(turns=[...], usd_per_call=0.005)
    """

    def _factory(
        *,
        turns: list[BaseModel],
        usd_per_call: float = 0.005,
        error_on_call: int | None = None,
    ) -> ScriptedStub:
        return ScriptedStub(
            turns=turns, usd_per_call=usd_per_call, error_on_call=error_on_call
        )

    yield _factory


# ─────────────────────────────────────────────────────────────────────────────
# Run context — every test gets a default, override per-test as needed.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def run_context() -> RunContext:
    return RunContext(
        tenant_id="t_test000000000001",
        workspace_id="ws_test_intake_001",
        trace_id="trace-test-001",
        autonomy_level="checkpointed",
        invoked_by="pytest@social-seeding.test",
    )


# ─────────────────────────────────────────────────────────────────────────────
# Brief / message fixtures — golden values reused across tests.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def example_brief() -> CampaignBrief:
    """The 'Freshly Vitamin C Serum' brief from intake.spec.md §5 (Mermaid)."""
    return CampaignBrief(
        workspaceId="ws_test_intake_001",
        createdBy="op@social-seeding.test",
        brandProduct=BrandProduct(
            name="Freshly Vitamin C Serum",
            category="skincare/serum",
            description="Brightening Vitamin C serum with hyaluronic acid.",
            keyClaims=["10% vitamin C", "fragrance-free", "vegan"],
        ),
        targeting=Targeting(
            creatorCount=20,
            minEngagementRate=0.03,
            languages=["ko"],
            hashtags=["스킨케어", "비타민C"],
        ),
        logistics=Logistics(shipsSamples=True),
        goals=Goals(
            targetLivePosts=15,
            deadline=dt.datetime(2026, 6, 30, 23, 59, tzinfo=dt.UTC),
        ),
    )


@pytest.fixture
def asking_turn() -> IntakeOutputWrapper:
    """A canonical 'asking' turn output."""
    return IntakeOutputWrapper(
        result=AskingOutput(
            status="asking",
            question="What's the product name and category?",
            fieldFocus="brandProduct",
        )
    )


@pytest.fixture
def done_turn(example_brief: CampaignBrief) -> IntakeOutputWrapper:
    """A canonical 'done' turn output."""
    return IntakeOutputWrapper(result=DoneOutput(status="done", brief=example_brief))


@pytest.fixture
def intake_input_ko() -> IntakeInput:
    return IntakeInput(
        messages=[
            IntakeMessage(
                role="user",
                content="한국 스킨케어 캠페인을 20명의 크리에이터와 함께 진행하고 싶어요.",
            )
        ],
        workspaceId="ws_test_intake_001",
        createdBy="op@social-seeding.test",
        locale="ko",
    )


@pytest.fixture
def intake_input_en() -> IntakeInput:
    return IntakeInput(
        messages=[
            IntakeMessage(
                role="user",
                content="Run a Korean skincare campaign with 20 creators.",
            )
        ],
        workspaceId="ws_test_intake_001",
        createdBy="op@social-seeding.test",
        locale="en",
    )


# ─────────────────────────────────────────────────────────────────────────────
# Async marker — pytest-asyncio "auto" mode means all async test fns are
# auto-collected. We still expose this for explicit @pytest.mark.asyncio uses.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
async def async_noop() -> AsyncIterator[None]:
    yield
