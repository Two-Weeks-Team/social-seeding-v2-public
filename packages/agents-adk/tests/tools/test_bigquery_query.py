"""tests/tools/test_bigquery_query.py

Covers four contracts on the `bigquery_query` capability tool:

1. **Stub determinism** — same input → byte-identical output (the analyst
   agent + workflow goldens rely on this). Canonical `campaign_summary`
   template returns exactly 3 rows with the brief's documented values.
2. **SQL-injection guardrail** (CRITICAL per analyst.spec.md §6 + D8) —
   raw SQL strings supplied as `query_template_name` must be rejected at
   the Pydantic validation layer. We sweep the canonical injection corpus
   so any future regression to a less-strict validator fails loudly.
3. **Pydantic validation** — `extra=forbid`, length bounds, unknown
   template names, and unknown param keys all surface as typed errors.
4. **Live NotImplementedError** — flipping `CAPABILITY_LAYER_MODE=live`
   today must raise NotImplementedError (W7 hasn't wired the live client
   yet); the runtime converts that to a typed escalation.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern.
    D28 — Per-view billing pipeline; bigquery_query is one of the readers.
    D15 — BigQuery sits on the analytics side of the OLTP hybrid.
    analyst.spec.md §6 — `bigquery.query` tool contract.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.bigquery_query import (
    USD_COST,
    BigQueryQueryInput,
    BigQueryQueryOutput,
    _looks_like_raw_sql,
    bigquery_query,
)


# ─────────────────────────────────────────────────────────────────────────────
# 1. Stub determinism — `campaign_summary` returns 3 deterministic rows.
# ─────────────────────────────────────────────────────────────────────────────


class TestStubDeterminism:
    """Stub mode is the default in dev/CI; outputs must be byte-stable."""

    def test_campaign_summary_returns_three_rows(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Canonical fixture: 3 rows, schema declared, fetched_via=='stub'."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = bigquery_query(
            BigQueryQueryInput(
                query_template_name="campaign_summary",
                params={
                    "campaign_id": "cmp_demo001",
                    "tenant_id": "t_test000000000001",
                },
            )
        )
        assert isinstance(out, BigQueryQueryOutput)
        assert out.fetched_via == "stub"
        assert out.total_rows == 3
        assert len(out.rows) == 3
        # First row pinned exactly — downstream goldens lock onto this shape.
        assert out.rows[0] == {
            "campaign_id": "cmp_demo001",
            "verified_posts": 7,
            "total_views": 124_000,
            "spent_usd": 210.50,
        }
        # Schema column count + names — the analyst's "Numbers" markdown
        # section iterates this list, so the column set is part of the contract.
        col_names = [c["name"] for c in out.schema_]
        assert col_names == [
            "campaign_id",
            "verified_posts",
            "total_views",
            "spent_usd",
        ]
        assert out.bytes_processed > 0
        assert out.slot_ms > 0
        assert out.dry_run is False

    def test_same_input_yields_byte_identical_output(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Re-invoking with the same input twice produces equal models.

        Equality of Pydantic models is structural, so this would catch any
        accidental introduction of timestamps / uuids into the stub.
        """
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        params = {"campaign_id": "cmp_demo001", "tenant_id": "t_test000000000001"}
        out_a = bigquery_query(
            BigQueryQueryInput(query_template_name="campaign_summary", params=params)
        )
        out_b = bigquery_query(
            BigQueryQueryInput(query_template_name="campaign_summary", params=params)
        )
        assert out_a == out_b

    def test_dry_run_returns_empty_rows_but_schema(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """`dry_run=True` returns 0 rows + the schema (BigQuery semantics)."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = bigquery_query(
            BigQueryQueryInput(
                query_template_name="campaign_summary",
                params={"campaign_id": "cmp_demo001", "tenant_id": "t_x000000000000000"},
                dry_run=True,
            )
        )
        assert out.dry_run is True
        assert out.rows == []
        assert out.total_rows == 0
        # Schema is still populated — that's the whole point of a dry run.
        assert len(out.schema_) == 4


# ─────────────────────────────────────────────────────────────────────────────
# 2. SQL-injection guardrail — the load-bearing safety test.
#
# Per analyst.spec.md §6 + D8: callers pass a registered template NAME, never
# raw SQL. The validator below MUST reject any value containing SQL keywords,
# whitespace, comments, or punctuation. Failure here = real security bug.
# ─────────────────────────────────────────────────────────────────────────────


_INJECTION_CORPUS: list[str] = [
    # Classic raw-SELECT
    "SELECT * FROM analytics.tenants",
    "select campaign_id from v2_campaign_metrics",
    # Comment / terminator splice
    "campaign_summary; DROP TABLE users",
    "campaign_summary--",
    "campaign_summary/*evil*/",
    # Tautology-style ORs
    "x' OR '1'='1",
    # Union-based exfil
    "campaign_summary UNION SELECT id, secret FROM v2_tenant_secrets",
    # Leading whitespace + SQL
    "  DELETE FROM v2_campaign_metrics WHERE 1=1",
    # Mixed-case keyword
    "CamPaign_Summary; InSeRt INTO leak SELECT * FROM secrets",
    # Newlines hidden in the name
    "campaign_summary\nDROP TABLE users",
]


class TestSqlInjectionGuardrail:
    """The most important class in this file — every raw-SQL attempt fails."""

    @pytest.mark.parametrize("evil_name", _INJECTION_CORPUS)
    def test_raw_sql_template_name_rejected(self, evil_name: str) -> None:
        """Pydantic validation must reject anything resembling raw SQL.

        We assert the error happens at MODEL INSTANTIATION — before any
        capability code runs — so even a bug in `bigquery_query` itself
        couldn't accidentally execute the injected payload.
        """
        with pytest.raises(ValidationError) as excinfo:
            BigQueryQueryInput(
                query_template_name=evil_name,
                params={"campaign_id": "cmp_demo001"},
            )
        # The error message should mention either the raw-SQL guard or
        # the snake_case constraint (depending on which fires first).
        msg = str(excinfo.value).lower()
        assert (
            "raw sql" in msg
            or "[a-z][a-z0-9_]*" in msg
            or "must match" in msg
            or "registered template" in msg
        ), f"unexpected error message for {evil_name!r}: {msg}"

    def test_internal_detector_flags_each_injection(self) -> None:
        """Belt-and-braces: the raw-SQL detector function itself flags every
        case in the corpus. This catches regressions where the validator
        wires up the wrong detector."""
        for evil in _INJECTION_CORPUS:
            assert _looks_like_raw_sql(evil), (
                f"_looks_like_raw_sql failed to flag {evil!r} — guardrail "
                f"would have leaked this payload through to BigQuery"
            )

    def test_internal_detector_passes_clean_names(self) -> None:
        """Symmetric check: legitimate snake_case template names pass."""
        for clean in ("campaign_summary", "cross_campaign_benchmark", "per_view_billing"):
            assert not _looks_like_raw_sql(clean), (
                f"_looks_like_raw_sql wrongly flagged clean name {clean!r}"
            )


# ─────────────────────────────────────────────────────────────────────────────
# 3. Pydantic validation — fail-closed semantics around the contract.
# ─────────────────────────────────────────────────────────────────────────────


class TestPydanticValidation:
    """`extra=forbid`, length bounds, unknown templates, unknown params."""

    def test_extra_field_rejected(self) -> None:
        """`extra=forbid` means unknown input fields fail at validation time."""
        with pytest.raises(ValidationError):
            BigQueryQueryInput.model_validate(
                {
                    "query_template_name": "campaign_summary",
                    "params": {"campaign_id": "cmp_x"},
                    "evil_extra_field": "haha",
                }
            )

    def test_empty_template_name_rejected(self) -> None:
        """min_length=1 on `query_template_name`."""
        with pytest.raises(ValidationError):
            BigQueryQueryInput(query_template_name="", params={})

    def test_overlong_template_name_rejected(self) -> None:
        """max_length=64 on `query_template_name`."""
        with pytest.raises(ValidationError):
            BigQueryQueryInput(
                query_template_name="a" * 65,
                params={},
            )

    def test_uppercase_letters_rejected(self) -> None:
        """Snake-case-only convention — even non-SQL uppercase strings fail.

        This is the second layer of injection defense: even if a future
        attack vector bypasses the SQL-keyword regex, restricting to
        `[a-z][a-z0-9_]*` keeps the surface area tiny.
        """
        with pytest.raises(ValidationError):
            BigQueryQueryInput(query_template_name="CampaignSummary", params={})

    def test_unknown_template_name_raises_keyerror(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Validation passes (it's a clean snake_case name) but dispatch
        fails — the runtime converts the KeyError into an `EscalateToHuman`."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        with pytest.raises(KeyError, match="unknown query_template_name"):
            bigquery_query(
                BigQueryQueryInput(
                    query_template_name="not_a_real_template",
                    params={},
                )
            )

    def test_unknown_param_key_rejected(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Param keys not declared by the template must surface as KeyError."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        with pytest.raises(KeyError, match="does not accept"):
            bigquery_query(
                BigQueryQueryInput(
                    query_template_name="campaign_summary",
                    params={"campaign_id": "cmp_x", "evil_extra": "1"},
                )
            )


# ─────────────────────────────────────────────────────────────────────────────
# 4. Live NotImplementedError + cost attribute surfacing.
# ─────────────────────────────────────────────────────────────────────────────


class TestLiveAndCost:
    """`CAPABILITY_LAYER_MODE=live` must raise — W7 wires the real client."""

    def test_live_mode_raises_not_implemented(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        with pytest.raises(NotImplementedError, match="W7 deploy phase"):
            bigquery_query(
                BigQueryQueryInput(
                    query_template_name="campaign_summary",
                    params={
                        "campaign_id": "cmp_demo001",
                        "tenant_id": "t_test000000000001",
                    },
                )
            )

    def test_usd_cost_attribute_surfaced(self) -> None:
        """`cost_watch` reads `tool.usd_cost` via getattr — must exist."""
        assert hasattr(bigquery_query, "usd_cost")
        assert bigquery_query.usd_cost == USD_COST  # type: ignore[attr-defined]
        assert USD_COST > 0.0
