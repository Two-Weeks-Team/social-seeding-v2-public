"""tests/tools/test_vector_search_creator.py — capability-layer seam tests.

Vector search adds two contract details on top of the standard 4 invariants:

  - Exactly-one-of (`queryText` | `embedding`) enforcement.
  - Descending-score determinism (`vs_001` → 0.99, `vs_002` → 0.98, …).
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.vector_search_creator import (
    USD_COST,
    VectorSearchCreatorInput,
    VectorSearchCreatorOutput,
    vector_search_creator,
)


# ─────────────────────────────────────────────────────────────────────────────
# 1. Default = stub (10 hits, descending scores)
# ─────────────────────────────────────────────────────────────────────────────


def test_default_mode_is_stub_returns_ten(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = vector_search_creator(
        VectorSearchCreatorInput(queryText="Korean vitamin C serum")
    )
    assert isinstance(out, VectorSearchCreatorOutput)
    assert len(out.hits) == 10
    assert [h.creator_id for h in out.hits] == [f"vs_{i:03d}" for i in range(1, 11)]


def test_stub_scores_descend_monotonically(monkeypatch: pytest.MonkeyPatch) -> None:
    """Scores walk 0.99 → 0.90 in 0.01 steps."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = vector_search_creator(VectorSearchCreatorInput(queryText="anything"))
    scores = [h.score for h in out.hits]
    assert scores == [0.99, 0.98, 0.97, 0.96, 0.95, 0.94, 0.93, 0.92, 0.91, 0.90]


def test_stub_honours_top_k(monkeypatch: pytest.MonkeyPatch) -> None:
    """top_k=3 ⇒ 3 hits, all from the highest-score head."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = vector_search_creator(
        VectorSearchCreatorInput(queryText="serum", topK=3)
    )
    assert [h.creator_id for h in out.hits] == ["vs_001", "vs_002", "vs_003"]


def test_stub_honours_min_score(monkeypatch: pytest.MonkeyPatch) -> None:
    """min_score=0.95 ⇒ trims tail to 5 hits."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = vector_search_creator(
        VectorSearchCreatorInput(queryText="serum", minScore=0.95)
    )
    assert len(out.hits) == 5
    assert all(h.score >= 0.95 for h in out.hits)


def test_stub_accepts_embedding(monkeypatch: pytest.MonkeyPatch) -> None:
    """The pre-computed-embedding branch also drives the stub."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = vector_search_creator(
        VectorSearchCreatorInput(embedding=[0.1, 0.2, 0.3])
    )
    assert len(out.hits) == 10


# ─────────────────────────────────────────────────────────────────────────────
# 2. Determinism
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_determinism(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = VectorSearchCreatorInput(queryText="vitamin C", topK=10)
    a = vector_search_creator(payload)
    b = vector_search_creator(payload)
    assert a.model_dump_json() == b.model_dump_json()


# ─────────────────────────────────────────────────────────────────────────────
# 3. Live mode raises with W7 message
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    with pytest.raises(NotImplementedError, match=r"W7 deploy phase"):
        vector_search_creator(VectorSearchCreatorInput(queryText="serum"))


# ─────────────────────────────────────────────────────────────────────────────
# 4. Input validation
# ─────────────────────────────────────────────────────────────────────────────


def test_input_rejects_both_query_and_embedding() -> None:
    """Exactly-one-of(queryText, embedding) — both set ⇒ error."""
    with pytest.raises(ValidationError):
        VectorSearchCreatorInput(queryText="serum", embedding=[0.1, 0.2])


def test_input_rejects_neither_query_nor_embedding() -> None:
    """Exactly-one-of(queryText, embedding) — neither ⇒ error."""
    with pytest.raises(ValidationError):
        VectorSearchCreatorInput()


def test_input_rejects_unknown_field() -> None:
    with pytest.raises(ValidationError):
        VectorSearchCreatorInput.model_validate(
            {"queryText": "x", "filter": "{lang:'ko'}"}
        )


def test_input_rejects_min_score_above_one() -> None:
    with pytest.raises(ValidationError):
        VectorSearchCreatorInput(queryText="x", minScore=1.5)


def test_input_rejects_top_k_above_cap() -> None:
    with pytest.raises(ValidationError):
        VectorSearchCreatorInput(queryText="x", topK=500)


# ─────────────────────────────────────────────────────────────────────────────
# Cost attribute
# ─────────────────────────────────────────────────────────────────────────────


def test_cost_attribute_exposed() -> None:
    assert hasattr(vector_search_creator, "usd_cost")
    assert vector_search_creator.usd_cost == USD_COST  # type: ignore[attr-defined]
    assert isinstance(vector_search_creator.usd_cost, float)  # type: ignore[attr-defined]
