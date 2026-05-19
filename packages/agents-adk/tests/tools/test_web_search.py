"""Tests for `ss_agents.tools.web_search` (W2-A7).

Coverage matrix:

  1. Stub determinism — same input ⇒ identical output across N calls.
  2. URL/secret redaction — results with `password=` / `token=` etc. dropped.
  3. Pydantic input/output validation — boundary cases, bad URLs, length caps.
  4. Live mode raises NotImplementedError when CAPABILITY_LAYER_MODE=live.

These tests are the W2-A1 canonical test template applied to the W2-A7
inputs. Determinism + redaction failures are real security regressions, so
the assertions are tight.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.web_search import (
    USD_COST,
    WebSearchInput,
    WebSearchOutput,
    WebSearchResult,
    web_search,
)


# Ensure the test runs under the deterministic stub by default. The
# `_isolate_env` autouse fixture in tests/conftest.py sets SS_OFFLINE=1
# but leaves CAPABILITY_LAYER_MODE alone — we explicitly default it here
# so every test has a known starting state.
@pytest.fixture(autouse=True)
def _force_stub_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    yield


# ─────────────────────────────────────────────────────────────────────────────
# 1. Stub determinism.
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_reference_query_returns_five_canned_rows() -> None:
    """Reference query `'social seeding'` returns the canned 5-row corpus."""
    payload = WebSearchInput(query="social seeding", locale="en", maxResults=10)
    out = web_search(payload)
    assert isinstance(out, WebSearchOutput)
    assert len(out.results) == 5
    # The first row is the deterministic primer entry.
    assert out.results[0].title.startswith("What is social seeding")
    assert out.results[0].url == "https://example.com/social-seeding-primer"


def test_stub_is_deterministic_across_invocations() -> None:
    """Two back-to-back stub calls produce byte-identical JSON output."""
    payload = WebSearchInput(query="social seeding", locale="en")
    a = web_search(payload).model_dump_json()
    b = web_search(payload).model_dump_json()
    c = web_search(payload).model_dump_json()
    assert a == b == c, "stub must be deterministic — got drift across calls"


def test_stub_respects_max_results_cap() -> None:
    """`max_results=2` slices the canned corpus to 2 rows."""
    payload = WebSearchInput(query="social seeding", maxResults=2)
    out = web_search(payload)
    assert len(out.results) == 2


def test_stub_synthesizes_rows_for_unknown_query() -> None:
    """Unknown queries get up to 5 deterministic synthesized rows."""
    payload = WebSearchInput(query="random fictional brand xyz", maxResults=10)
    out = web_search(payload)
    assert 1 <= len(out.results) <= 5
    for r in out.results:
        # Synthesized rows live on the reserved `stub.invalid` host.
        assert r.url.startswith("https://stub.invalid/"), r.url


def test_stub_synthesis_is_deterministic_for_unknown_query() -> None:
    """Even synthesized rows must be deterministic — same query ⇒ same rows."""
    payload = WebSearchInput(query="foo bar baz", maxResults=3)
    a = web_search(payload).model_dump_json()
    b = web_search(payload).model_dump_json()
    assert a == b


# ─────────────────────────────────────────────────────────────────────────────
# 2. URL / secret redaction safety.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "sensitive_url",
    [
        "https://example.com/x?password=hunter2",
        "https://example.com/x?token=abc123",
        "https://example.com/x?api_key=k_live_xxx",
        "https://example.com/x?access_token=ya29.foo",
        "https://example.com/x?session_id=sess_abcdef",
        "https://example.com/x?secret=topsecret",
        "https://example.com/x?Authorization=Bearer+xxx",
    ],
)
def test_redaction_drops_results_with_sensitive_url(sensitive_url: str) -> None:
    """Module-level _redact_results must drop any sensitive-pattern URL.

    We exercise the redaction by manually constructing a mixed result set
    + calling the helper directly, since the stub corpus is clean.
    """
    from ss_agents.tools.web_search import _redact_results

    rows = [
        WebSearchResult(
            title="clean row",
            url="https://example.com/clean",
            snippet="nothing sensitive",
        ),
        WebSearchResult(
            title="leaky row",
            url=sensitive_url,
            snippet="incidental snippet",
        ),
    ]
    cleaned = _redact_results(rows)
    assert len(cleaned) == 1, (
        f"redaction must drop leaky row; got {[r.url for r in cleaned]!r}"
    )
    assert cleaned[0].url == "https://example.com/clean"


def test_redaction_is_case_insensitive() -> None:
    """`Password=`, `PASSWORD=`, `pAsSwOrD=` all trip."""
    from ss_agents.tools.web_search import _redact_results

    rows = [
        WebSearchResult(
            title="x",
            url="https://example.com/x?PASSWORD=hunter2",
            snippet="x",
        ),
    ]
    cleaned = _redact_results(rows)
    assert cleaned == []


# ─────────────────────────────────────────────────────────────────────────────
# 3. Pydantic input/output validation.
# ─────────────────────────────────────────────────────────────────────────────


def test_input_rejects_empty_query() -> None:
    with pytest.raises(ValidationError):
        WebSearchInput(query="")


def test_input_rejects_whitespace_only_query() -> None:
    with pytest.raises(ValidationError):
        WebSearchInput(query="   \t  ")


def test_input_rejects_overlong_query() -> None:
    with pytest.raises(ValidationError):
        WebSearchInput(query="x" * 401)


def test_input_rejects_unknown_locale() -> None:
    with pytest.raises(ValidationError):
        WebSearchInput(query="ok", locale="fr")  # type: ignore[arg-type]


def test_input_rejects_max_results_out_of_range() -> None:
    with pytest.raises(ValidationError):
        WebSearchInput(query="ok", maxResults=0)
    with pytest.raises(ValidationError):
        WebSearchInput(query="ok", maxResults=26)


def test_input_rejects_extra_fields() -> None:
    """extra='forbid' must reject unknown fields."""
    with pytest.raises(ValidationError):
        WebSearchInput.model_validate(
            {"query": "ok", "extra_field": "should_fail"}
        )


def test_result_rejects_non_http_url() -> None:
    with pytest.raises(ValidationError):
        WebSearchResult(
            title="x",
            url="not-a-url",
            snippet="x",
        )


def test_result_rejects_javascript_url() -> None:
    with pytest.raises(ValidationError):
        WebSearchResult(
            title="x",
            url="javascript:alert(1)",
            snippet="x",
        )


def test_output_caps_results_at_25() -> None:
    """Pydantic max_length on results[] is hard-capped at 25."""
    too_many = [
        WebSearchResult(
            title=f"t{i}",
            url=f"https://example.com/{i}",
            snippet=f"s{i}",
        )
        for i in range(26)
    ]
    with pytest.raises(ValidationError):
        WebSearchOutput(results=too_many)


def test_module_usd_cost_attribute_is_positive() -> None:
    """D41/D42: per-tool USD cost surfaced at module level."""
    assert USD_COST > 0
    # And mirrored on the function itself for callers that only import it.
    assert getattr(web_search, "usd_cost") == USD_COST


# ─────────────────────────────────────────────────────────────────────────────
# 4. Live mode + bad-mode handling.
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`CAPABILITY_LAYER_MODE=live` must raise NotImplementedError."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    payload = WebSearchInput(query="social seeding")
    with pytest.raises(NotImplementedError):
        web_search(payload)


def test_unknown_mode_raises_value_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unrecognized mode value must raise ValueError — not silently
    fall back to stub or live."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "shadow")
    payload = WebSearchInput(query="social seeding")
    with pytest.raises(ValueError, match="CAPABILITY_LAYER_MODE"):
        web_search(payload)


def test_default_mode_is_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    """If `CAPABILITY_LAYER_MODE` is unset the default is `stub`."""
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    payload = WebSearchInput(query="social seeding")
    out = web_search(payload)
    assert len(out.results) == 5
