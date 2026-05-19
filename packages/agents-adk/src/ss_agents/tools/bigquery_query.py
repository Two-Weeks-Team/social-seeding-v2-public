"""bigquery_query — capability layer per D41.

Runs a *parameterized* BigQuery SQL query against the analytics dataset.

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Returns deterministic canned rows so the analyst agent + downstream
    workflow can exercise the report-narration path with no live BigQuery
    traffic, no billing, and no risk of cross-tenant data exposure.

Live mode (CAPABILITY_LAYER_MODE=live):
    Real BigQuery call — wired in W7 (deploy phase) once the Workforce
    Identity Federation key + Spanner→AlloyDB→BigQuery ELT pipeline land.
    Today: raises NotImplementedError so the runtime converts the call
    into an `EscalateToHuman` outcome rather than crashing.

SQL-injection guardrail (CRITICAL, per analyst.spec.md + D8 framing):
    Callers pass a **registered template name** (e.g. `"campaign_summary"`),
    not raw SQL. The template name is looked up in `_QUERY_TEMPLATES` and
    only the corresponding pre-vetted SQL is executed. Any value that looks
    like raw SQL (whitespace, semicolons, `select`/`from`/`where` keywords,
    SQL comments, dashes) is rejected at the Pydantic layer.

    Without this guardrail the analyst LLM could exfiltrate cross-tenant
    rows by composing a `SELECT * FROM analytics.tenant_secrets` template.
    With this guardrail the worst the LLM can do is name a template that
    doesn't exist, which raises `KeyError` and escalates to a human.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern (CAPABILITY_LAYER_MODE).
    D28 — Per-view pricing pipeline (Pub/Sub → BigQuery → billing). Live
          queries must observe per-tenant row-level security against the
          per-view metering tables.
    D15 — OLTP hybrid (Spanner + AlloyDB + Firestore); BigQuery sits on the
          analytics side of this split.
    analyst.spec.md §6 — tool table row `bigquery.query` (analytics queries).
    ARCHITECTURE.md §3 row 8 — analyst agent's tool list.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

logger = logging.getLogger(__name__)

# Per-invocation USD cost estimate; `cost_watch` reads this attribute via
# `getattr(bigquery_query, "usd_cost", 0.0)`. BigQuery on-demand pricing is
# $5.00 / TB scanned — for the small per-campaign rollups the analyst runs
# (sub-MB scans against `v2_campaign_metrics`) the marginal cost is well
# under a tenth of a cent. We round to $0.0005 / call (5x headroom).
USD_COST: float = 0.0005

# ─────────────────────────────────────────────────────────────────────────────
# Template registry — the ONLY SQL the tool will ever execute.
#
# Adding a template:
#   1. Pre-vet the SQL (no PII, row-level security via @tenant_id param,
#      LIMIT enforced, no SELECT *).
#   2. List the params the template consumes — runtime checks every supplied
#      param appears here, so a typo'd param name fails closed.
#   3. Stub fixture below MUST return shape-compatible rows so unit tests
#      that swap stub ↔ live mode see the same downstream schema.
#
# Today (W2 / Phase 3) only `campaign_summary` ships. W4 adds:
#   - `cross_campaign_benchmark` (analyst's longer-window cross-campaign view)
#   - `per_view_billing` (D28 cost-watch aggregator)
# ─────────────────────────────────────────────────────────────────────────────


_QUERY_TEMPLATES: dict[str, dict[str, Any]] = {
    "campaign_summary": {
        "sql": (
            "SELECT campaign_id, verified_posts, total_views, spent_usd "
            "FROM `@project.analytics.v2_campaign_metrics` "
            "WHERE campaign_id = @campaign_id AND tenant_id = @tenant_id "
            "LIMIT 100"
        ),
        "params": frozenset({"campaign_id", "tenant_id"}),
        "description": (
            "Per-campaign rollup (verified posts + total views + spend). "
            "Joins v2_creator_tracks (Spanner) ⇄ v2_view_metrics (BigQuery)."
        ),
    },
}


# ─────────────────────────────────────────────────────────────────────────────
# Raw-SQL detector — runs at Pydantic validation time.
# ─────────────────────────────────────────────────────────────────────────────


# Conservative pattern: any of these tokens in a template name = caller is
# trying to inject raw SQL rather than name a registered template. We err on
# the side of rejecting odd-looking names (the legitimate alternative is
# `snake_case_letters_only`).
_RAW_SQL_INDICATORS = re.compile(
    r"""(
        \bselect\b | \bfrom\b   | \bwhere\b | \binsert\b | \bupdate\b |
        \bdelete\b | \bdrop\b   | \balter\b | \bunion\b  | \bjoin\b   |
        \bcreate\b | \btruncate\b
        | --                                # SQL line comment
        | /\*                               # SQL block comment open
        | ;                                 # statement terminator
        | \*/                               # SQL block comment close
        | \s                                # any whitespace
    )""",
    re.IGNORECASE | re.VERBOSE,
)


def _looks_like_raw_sql(name: str) -> bool:
    """True when `name` contains SQL keywords / punctuation / whitespace.

    Used as the SQL-injection guardrail (analyst.spec.md §6 + D8). Tested
    against the canonical injection corpus in `tests/tools/test_bigquery_query.py`.
    """
    if not name:
        return False
    return bool(_RAW_SQL_INDICATORS.search(name))


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class BigQueryQueryInput(BaseModel):
    """Capability input. Mirrors analyst.spec.md §6 `bigquery.query`.

    Attributes:
        query_template_name: Lookup key into the pre-vetted template
            registry. MUST NOT be raw SQL — the validator below rejects any
            value containing SQL keywords, whitespace, comments, or
            semicolons. Naming convention: `snake_case_letters_only`,
            ≤ 64 chars.
        params: Parameter map fed to BigQuery's query-parameter binding.
            Every key must appear in the template's declared `params` set;
            unknown keys fail at runtime so a typo'd binding never silently
            scans a different shard.
        dry_run: When True, the tool returns shape-compatible rows but
            attributes `dry_run=True` in the response so the workflow can
            distinguish billed vs estimated traffic.
    """

    model_config = ConfigDict(extra="forbid")

    query_template_name: str = Field(
        min_length=1,
        max_length=64,
        description="Registered SQL template name. NEVER raw SQL.",
    )
    params: dict[str, Any] = Field(
        default_factory=dict,
        description="BigQuery query parameters. Keys must match template.",
    )
    dry_run: bool = Field(
        default=False,
        description=(
            "When True: BigQuery 'dry run' mode (no billing, schema + "
            "bytes_processed estimate returned). Stub honors this flag."
        ),
    )

    @field_validator("query_template_name")
    @classmethod
    def _reject_raw_sql(cls, v: str) -> str:
        """SQL-injection guardrail — rejects raw SQL or anything resembling it.

        Per analyst.spec.md §6 + D8 framing: the analyst LLM hands a name to
        this tool, never SQL itself. We fail closed if the value contains
        anything beyond `[a-z_][a-z0-9_]*`-ish characters.
        """
        if _looks_like_raw_sql(v):
            raise ValueError(
                f"query_template_name must be a registered template name, "
                f"not raw SQL (got {v[:40]!r})"
            )
        # Tighten further: must be lowercase letters / digits / underscores
        # only. Mirrors v2's capability registry naming convention.
        if not re.fullmatch(r"[a-z][a-z0-9_]*", v):
            raise ValueError(
                f"query_template_name must match [a-z][a-z0-9_]* "
                f"(got {v!r})"
            )
        return v


class BigQueryQueryOutput(BaseModel):
    """Capability output. Shape mirrors `google.cloud.bigquery.QueryJob`
    semantics (rows + schema + scan stats).

    Attributes:
        rows: Materialized result set, one dict per row. The analyst agent
            consumes this directly — never sees the underlying job object.
        schema: Field metadata `[{"name": str, "type": str, "mode": str}]`.
            Stub mirrors BigQuery's standard SQL type names.
        total_rows: Total rows the query returned (may exceed `len(rows)`
            if pagination kicks in — stub never paginates so the two match).
        bytes_processed: BigQuery's on-demand billing metric. Stub returns
            a deterministic small value so cost-aware tests can pin it.
        slot_ms: Slot-time consumed (BigQuery's reservation metric).
        dry_run: True when the call was a dry-run estimate (no billing).
        fetched_via: 'stub' vs 'live' — same convention as the rest of the
            capability fleet (OTel distinguishes the two streams).
    """

    model_config = ConfigDict(extra="forbid")

    rows: list[dict[str, Any]] = Field(default_factory=list)
    schema_: list[dict[str, str]] = Field(
        default_factory=list, alias="schema",
        description="Field metadata; aliased as 'schema' externally.",
    )
    total_rows: int = Field(ge=0)
    bytes_processed: int = Field(ge=0)
    slot_ms: int = Field(ge=0)
    dry_run: bool = Field(default=False)
    fetched_via: Literal["stub", "live"]


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def bigquery_query(payload: BigQueryQueryInput) -> BigQueryQueryOutput:
    """Run a parameterized analytics query against BigQuery.

    Stub vs live is selected via the `CAPABILITY_LAYER_MODE` env var (D41).
    Stub returns deterministic canned rows; live performs the real BigQuery
    call (wired in W7).

    Args:
        payload: Validated `BigQueryQueryInput`. The Pydantic validator has
            already enforced the SQL-injection guardrail by this point.

    Returns:
        `BigQueryQueryOutput` with rows + schema + scan stats.

    Raises:
        KeyError: When `query_template_name` is not a registered template.
            The runtime converts this to an `EscalateToHuman` so the
            workflow routes to the human queue.
        NotImplementedError: When `CAPABILITY_LAYER_MODE=live` — until W7
            wires the real google-cloud-bigquery client.
    """
    if payload.query_template_name not in _QUERY_TEMPLATES:
        raise KeyError(
            f"unknown query_template_name {payload.query_template_name!r}; "
            f"registered: {sorted(_QUERY_TEMPLATES.keys())}"
        )

    # Reject params that don't appear in the template's declared set. This
    # is the second layer of injection defense: even with a valid template
    # name, a caller can't sneak `tenant_id="' OR 1=1 --"` past the param
    # binding because we surface unknown bindings as a typed error.
    template = _QUERY_TEMPLATES[payload.query_template_name]
    declared_params: frozenset[str] = template["params"]
    supplied = set(payload.params.keys())
    extra = supplied - declared_params
    if extra:
        raise KeyError(
            f"template {payload.query_template_name!r} does not accept "
            f"params {sorted(extra)}; declared: {sorted(declared_params)}"
        )

    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
bigquery_query.usd_cost = USD_COST  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub — deterministic canned data.
#
# `campaign_summary` returns exactly 3 rows so workflow + analyst tests can
# pin row counts without coupling to a hash. The numbers are picked so:
#   - they look plausibly like a small Korean skincare campaign
#   - their sum maps cleanly onto the analyst's "Numbers" markdown section
#   - they don't accidentally trip any of the report-flag thresholds
# ─────────────────────────────────────────────────────────────────────────────


def _stub(payload: BigQueryQueryInput) -> BigQueryQueryOutput:
    """Deterministic stub. Same input → same output, always."""
    if payload.query_template_name == "campaign_summary":
        rows: list[dict[str, Any]] = [
            {
                "campaign_id": "cmp_demo001",
                "verified_posts": 7,
                "total_views": 124_000,
                "spent_usd": 210.50,
            },
            {
                "campaign_id": "cmp_demo002",
                "verified_posts": 12,
                "total_views": 286_400,
                "spent_usd": 312.00,
            },
            {
                "campaign_id": "cmp_demo003",
                "verified_posts": 4,
                "total_views": 51_900,
                "spent_usd": 88.75,
            },
        ]
        schema_rows: list[dict[str, str]] = [
            {"name": "campaign_id", "type": "STRING", "mode": "NULLABLE"},
            {"name": "verified_posts", "type": "INT64", "mode": "NULLABLE"},
            {"name": "total_views", "type": "INT64", "mode": "NULLABLE"},
            {"name": "spent_usd", "type": "FLOAT64", "mode": "NULLABLE"},
        ]
        return BigQueryQueryOutput(
            rows=[] if payload.dry_run else rows,
            schema=schema_rows,
            total_rows=0 if payload.dry_run else len(rows),
            # Sub-MB scan typical for v2_campaign_metrics rollups.
            bytes_processed=192_000,
            slot_ms=420,
            dry_run=payload.dry_run,
            fetched_via="stub",
        )

    # Unknown registered template — shouldn't happen because the caller's
    # validator + dispatcher rejected unknown names. Defense in depth.
    raise KeyError(
        f"stub has no fixture for template {payload.query_template_name!r}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# Live — wired in W7 (deploy phase). Raises NotImplementedError so the
# runtime converts to an `EscalateToHuman` rather than crashing.
# ─────────────────────────────────────────────────────────────────────────────


def _live(payload: BigQueryQueryInput) -> BigQueryQueryOutput:
    """Live BigQuery call. Wired in W7 deploy phase."""
    raise NotImplementedError(
        "bigquery_query live mode wired in W7 deploy phase "
        "(google-cloud-bigquery client + Workforce Identity Federation)"
    )


__all__ = [
    "BigQueryQueryInput",
    "BigQueryQueryOutput",
    "USD_COST",
    "bigquery_query",
]
