"""Tests for `ss_agents.tools.vector_search_competitor` (W2-A7).

Coverage matrix:

  1. Stub determinism — same input ⇒ identical output across N calls;
     scores match the spec (0.91, 0.88, 0.85, 0.82, 0.79).
  2. Secret redaction — matches with `password=` / `token=` in snippet or
     source are dropped.
  3. Pydantic input/output validation — embedding shape, top_k bounds,
     extra-field rejection, score bounds.
  4. Live mode raises NotImplementedError when CAPABILITY_LAYER_MODE=live.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.vector_search_competitor import (
    USD_COST,
    VectorMatch,
    VectorSearchInput,
    VectorSearchOutput,
    vector_search_competitor,
)


@pytest.fixture(autouse=True)
def _force_stub_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    yield


# ─────────────────────────────────────────────────────────────────────────────
# 1. Stub determinism.
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_returns_five_matches_with_expected_scores() -> None:
    """W2-A7 brief: 5 deterministic matches with scores 0.91 desc."""
    payload = VectorSearchInput(
        brandName="Freshly",
        embeddingOrText="K-beauty serum competitors",
        topK=20,
    )
    out = vector_search_competitor(payload)
    assert isinstance(out, VectorSearchOutput)
    assert len(out.matches) == 5
    scores = [m.score for m in out.matches]
    assert scores == [0.91, 0.88, 0.85, 0.82, 0.79]
    # Strictly descending.
    assert scores == sorted(scores, reverse=True)


def test_stub_is_deterministic_across_invocations() -> None:
    """Two back-to-back stub calls produce byte-identical JSON output."""
    payload = VectorSearchInput(
        brandName="Freshly",
        embeddingOrText="competitor query",
    )
    a = vector_search_competitor(payload).model_dump_json()
    b = vector_search_competitor(payload).model_dump_json()
    c = vector_search_competitor(payload).model_dump_json()
    assert a == b == c


def test_stub_post_ids_are_brand_scoped() -> None:
    """Two different brands must yield distinct post_ids."""
    a = vector_search_competitor(
        VectorSearchInput(brandName="Freshly", embeddingOrText="x")
    )
    b = vector_search_competitor(
        VectorSearchInput(brandName="Glow Recipe", embeddingOrText="x")
    )
    a_ids = {m.post_id for m in a.matches}
    b_ids = {m.post_id for m in b.matches}
    assert a_ids.isdisjoint(b_ids), (
        f"brand-scoped ids must not overlap: {a_ids & b_ids!r}"
    )


def test_stub_respects_top_k() -> None:
    """`top_k=2` slices the canned 5-row corpus to 2."""
    payload = VectorSearchInput(
        brandName="Freshly",
        embeddingOrText="x",
        topK=2,
    )
    out = vector_search_competitor(payload)
    assert len(out.matches) == 2


def test_stub_accepts_embedding_vector_input() -> None:
    """`embedding_or_text=[float, ...]` is a valid input alternative."""
    payload = VectorSearchInput(
        brandName="Freshly",
        embeddingOrText=[0.1, 0.2, 0.3, 0.4],
    )
    out = vector_search_competitor(payload)
    assert len(out.matches) == 5


# ─────────────────────────────────────────────────────────────────────────────
# 2. Secret redaction.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "evil_snippet",
    [
        "harmless prefix password=hunter2",
        "token=abc123 leaked",
        "see API_KEY=k_live_xxx",
        "Authorization=Bearer xxx",
        "session_id=sess_abcdef in payload",
        "secret=topsecret",
        "access_token=ya29.foo",
    ],
)
def test_redaction_drops_matches_with_sensitive_snippet(
    evil_snippet: str,
) -> None:
    """Matches whose snippet carries a credential must be dropped."""
    from ss_agents.tools.vector_search_competitor import _redact_matches

    rows = [
        VectorMatch(
            postId="post_clean_01",
            score=0.9,
            snippet="clean snippet",
            source="corpus://competitor/clean/1",
        ),
        VectorMatch(
            postId="post_leaky_01",
            score=0.85,
            snippet=evil_snippet,
            source="corpus://competitor/leaky/1",
        ),
    ]
    cleaned = _redact_matches(rows)
    assert len(cleaned) == 1
    assert cleaned[0].post_id == "post_clean_01"


def test_redaction_drops_matches_with_sensitive_source() -> None:
    """Sensitive patterns in `source` (not just snippet) also redact."""
    from ss_agents.tools.vector_search_competitor import _redact_matches

    rows = [
        VectorMatch(
            postId="post_leaky_src",
            score=0.9,
            snippet="benign snippet",
            source="https://internal/dashboard?token=abc123",
        ),
    ]
    cleaned = _redact_matches(rows)
    assert cleaned == []


# ─────────────────────────────────────────────────────────────────────────────
# 3. Pydantic input/output validation.
# ─────────────────────────────────────────────────────────────────────────────


def test_input_rejects_empty_brand_name() -> None:
    with pytest.raises(ValidationError):
        VectorSearchInput(brandName="", embeddingOrText="x")


def test_input_rejects_whitespace_only_brand_name() -> None:
    with pytest.raises(ValidationError):
        VectorSearchInput(brandName="   ", embeddingOrText="x")


def test_input_rejects_empty_text_query() -> None:
    with pytest.raises(ValidationError):
        VectorSearchInput(brandName="Freshly", embeddingOrText="")


def test_input_rejects_empty_embedding() -> None:
    with pytest.raises(ValidationError):
        VectorSearchInput(brandName="Freshly", embeddingOrText=[])


def test_input_rejects_too_long_embedding() -> None:
    """Embeddings beyond 4096 dimensions must be rejected."""
    with pytest.raises(ValidationError):
        VectorSearchInput(
            brandName="Freshly",
            embeddingOrText=[0.1] * 4097,
        )


def test_input_rejects_top_k_out_of_range() -> None:
    with pytest.raises(ValidationError):
        VectorSearchInput(brandName="Freshly", embeddingOrText="x", topK=0)
    with pytest.raises(ValidationError):
        VectorSearchInput(brandName="Freshly", embeddingOrText="x", topK=101)


def test_input_rejects_extra_fields() -> None:
    with pytest.raises(ValidationError):
        VectorSearchInput.model_validate(
            {
                "brandName": "Freshly",
                "embeddingOrText": "x",
                "extra_field": "should_fail",
            }
        )


def test_match_rejects_score_out_of_range() -> None:
    """Cosine similarity must live in [0, 1]."""
    with pytest.raises(ValidationError):
        VectorMatch(
            postId="x",
            score=1.5,
            snippet="x",
            source="x",
        )
    with pytest.raises(ValidationError):
        VectorMatch(
            postId="x",
            score=-0.1,
            snippet="x",
            source="x",
        )


def test_output_caps_matches_at_100() -> None:
    """Pydantic max_length on matches[] is hard-capped at 100."""
    too_many = [
        VectorMatch(
            postId=f"p{i}",
            score=0.5,
            snippet=f"s{i}",
            source=f"src{i}",
        )
        for i in range(101)
    ]
    with pytest.raises(ValidationError):
        VectorSearchOutput(matches=too_many)


def test_module_usd_cost_attribute_is_positive() -> None:
    """D41/D42: per-tool USD cost surfaced at module level."""
    assert USD_COST > 0
    assert getattr(vector_search_competitor, "usd_cost") == USD_COST


# ─────────────────────────────────────────────────────────────────────────────
# 4. Live mode + bad-mode handling.
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`CAPABILITY_LAYER_MODE=live` must raise NotImplementedError."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    payload = VectorSearchInput(brandName="Freshly", embeddingOrText="x")
    with pytest.raises(NotImplementedError):
        vector_search_competitor(payload)


def test_unknown_mode_raises_value_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "shadow")
    payload = VectorSearchInput(brandName="Freshly", embeddingOrText="x")
    with pytest.raises(ValueError, match="CAPABILITY_LAYER_MODE"):
        vector_search_competitor(payload)


def test_default_mode_is_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    payload = VectorSearchInput(brandName="Freshly", embeddingOrText="x")
    out = vector_search_competitor(payload)
    assert len(out.matches) == 5
