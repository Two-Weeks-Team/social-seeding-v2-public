"""`vector_search.competitor` capability — semantic vector search for
cross-brand competitor mentions across a corpus of public posts.

Capability-layer FunctionTool following the **W2-A1 canonical form** locked
in DECISIONS.md **D41**:

    def tool_fn(input: PydanticInputModel) -> PydanticOutputModel

Backed by **Vertex AI Vector Search** (DECISIONS.md **D16**, a dedicated
service independent of any OLTP store, supporting 10M+ vectors at p99
< 50ms). The stub path returns deterministic canned matches so the research
agent's pre-campaign briefing loop is fully reproducible offline. Live mode
will dispatch to the Vertex AI Vector Search index when its adapter ships.

Used by:
    research agent (Tier-1 #9, D23) — competitor identification +
    differentiation per research.spec.md §6.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern.
    D16 — Vertex AI Vector Search dedicated service.
    research.spec.md §6 — `vector_search.competitor` tool entry.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Final

from pydantic import BaseModel, ConfigDict, Field, field_validator

logger = logging.getLogger(__name__)


# Per-tool USD cost surfaced as a module attribute (D42 cost_watch can read
# this without instantiation). Vertex AI Vector Search bills $0.0006 / 1k
# queries on the smallest index tier; one similarity query ≈ $0.0006.
USD_COST: Final[float] = 0.0006

_CAPABILITY_MODE_ENV: Final[str] = "CAPABILITY_LAYER_MODE"
_VALID_MODES: Final[tuple[str, ...]] = ("stub", "live")

# Patterns whose presence in a result snippet/source indicates a credential
# leak; matching rows are redacted before return. Same conservative list as
# web_search.py — both tools share the redaction contract.
_SENSITIVE_PATTERNS: Final[tuple[re.Pattern[str], ...]] = (
    re.compile(r"\bpassword\s*=", re.I),
    re.compile(r"\btoken\s*=", re.I),
    re.compile(r"\baccess[_-]?token\s*=", re.I),
    re.compile(r"\bapi[_-]?key\s*=", re.I),
    re.compile(r"\bauthorization\s*=", re.I),
    re.compile(r"\bsession[_-]?id\s*=", re.I),
    re.compile(r"\bsecret\s*=", re.I),
)


# ─────────────────────────────────────────────────────────────────────────────
# Input / output schemas.
# ─────────────────────────────────────────────────────────────────────────────


class VectorSearchInput(BaseModel):
    """Semantic search input.

    Either supply pre-computed `embedding` (preferred when the caller has
    already paid the embedding cost) OR plain `text`; the runtime will
    embed text when live wiring lands. The Pydantic validator below enforces
    "exactly one of" so the tool can dispatch on a clear discriminator.

    Fields:
        brand_name:           The brand whose competitors we are surfacing.
                              Used to filter own-brand hits before scoring
                              (research.spec.md §8 edge case #5).
        embedding_or_text:    The query — either pre-computed embedding
                              (list of floats) or raw text.
        top_k:                Hard cap on `matches[]` (1-100, default 20).
    """

    model_config = ConfigDict(extra="forbid")

    brand_name: str = Field(min_length=1, max_length=200, alias="brandName")
    embedding_or_text: str | list[float] = Field(alias="embeddingOrText")
    top_k: int = Field(default=20, ge=1, le=100, alias="topK")

    @field_validator("brand_name")
    @classmethod
    def _strip_brand(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("brand_name must be non-empty after stripping")
        return v

    @field_validator("embedding_or_text")
    @classmethod
    def _validate_embedding_or_text(
        cls, v: str | list[float]
    ) -> str | list[float]:
        if isinstance(v, str):
            stripped = v.strip()
            if not stripped:
                raise ValueError("text query must be non-empty")
            if len(stripped) > 4_000:
                raise ValueError("text query must be ≤4000 chars")
            return stripped
        # list[float]
        if not v:
            raise ValueError("embedding must be non-empty")
        if len(v) > 4_096:
            raise ValueError("embedding length must be ≤4096 dimensions")
        for x in v:
            if not isinstance(x, (int, float)):
                raise ValueError(
                    f"embedding entries must be float, got {type(x).__name__}"
                )
        return v


class VectorMatch(BaseModel):
    """One similarity match. Strict Pydantic so the live backend can't
    silently widen the contract."""

    model_config = ConfigDict(extra="forbid")

    post_id: str = Field(min_length=1, max_length=120, alias="postId")
    score: float = Field(ge=0.0, le=1.0)
    """Cosine similarity, [0, 1]. Higher = more similar."""
    snippet: str = Field(min_length=1, max_length=600)
    source: str = Field(min_length=1, max_length=2_000)
    """Free-form provenance — could be a URL, a `tiktok://` deep link, or
    an internal corpus pointer like `corpus://competitor/<id>`."""


class VectorSearchOutput(BaseModel):
    """Validated semantic-search output. `matches[]` is hard-capped so a
    misbehaving live backend can't flood the agent's context."""

    model_config = ConfigDict(extra="forbid")

    matches: list[VectorMatch] = Field(default_factory=list, max_length=100)


# ─────────────────────────────────────────────────────────────────────────────
# Redaction.
# ─────────────────────────────────────────────────────────────────────────────


def _has_secret(text: str) -> bool:
    """Does `text` carry a credential pattern?"""
    return any(pat.search(text) for pat in _SENSITIVE_PATTERNS)


def _redact_matches(matches: list[VectorMatch]) -> list[VectorMatch]:
    """Drop any match whose `snippet` or `source` carries a sensitive
    pattern (same contract as `web_search`)."""
    cleaned: list[VectorMatch] = []
    dropped = 0
    for m in matches:
        if _has_secret(m.snippet) or _has_secret(m.source):
            dropped += 1
            logger.info(
                "vector_search_redacted_secret",
                extra={"reason": "sensitive_pattern_in_match"},
            )
            continue
        cleaned.append(m)
    if dropped:
        logger.warning(
            "vector_search_redaction_summary",
            extra={"dropped": dropped, "kept": len(cleaned)},
        )
    return cleaned


# ─────────────────────────────────────────────────────────────────────────────
# Stub + live implementations.
# ─────────────────────────────────────────────────────────────────────────────


# Deterministic canned matches. Five rows with scores 0.91 desc, mirroring
# the W2-A7 brief exactly. The post_ids are deterministic + brand-prefixed
# so multiple stub calls with different brands produce distinct ids.
def _stub_search(payload: VectorSearchInput) -> VectorSearchOutput:
    """Deterministic stub.

    Returns 5 canned matches with scores 0.91, 0.88, 0.85, 0.82, 0.79.
    Stable across runs; the post_id embeds the brand slug so callers can
    grep traces by brand.
    """
    brand_slug = re.sub(
        r"[^a-z0-9]+",
        "-",
        payload.brand_name.lower(),
    ).strip("-") or "brand"

    scores = (0.91, 0.88, 0.85, 0.82, 0.79)
    rows: list[VectorMatch] = [
        VectorMatch(
            postId=f"post_{brand_slug}_{i + 1:02d}",
            score=scores[i],
            snippet=(
                f"Deterministic stub competitor snippet #{i + 1} mentioning "
                f"{payload.brand_name}. Top_k={payload.top_k}."
            ),
            source=f"corpus://competitor/{brand_slug}/{i + 1}",
        )
        for i in range(5)
    ]

    rows = rows[: payload.top_k]
    rows = _redact_matches(rows)
    return VectorSearchOutput(matches=rows)


def _live_search(payload: VectorSearchInput) -> VectorSearchOutput:
    """Live implementation placeholder.

    Per D41 + D16 the live path will issue a similarity query against the
    Vertex AI Vector Search competitor index (10M+ vectors, p99 < 50ms).
    Until that adapter ships we raise NotImplementedError with a precise
    migration hint.
    """
    raise NotImplementedError(
        "vector_search.competitor live mode is not wired yet (D41 — "
        "capability layer adapter pending; D16 names Vertex AI Vector "
        f"Search as the backing store). Set {_CAPABILITY_MODE_ENV}=stub "
        "to use the deterministic stub."
    )


# ─────────────────────────────────────────────────────────────────────────────
# Public entry point (the ADK FunctionTool surface).
# ─────────────────────────────────────────────────────────────────────────────


def vector_search_competitor(
    payload: VectorSearchInput,
) -> VectorSearchOutput:
    """Semantic vector search for competitor mentions across a corpus of
    public posts.

    The runtime selects stub vs live via `CAPABILITY_LAYER_MODE` (D41).
    Stub returns deterministic data; live raises NotImplementedError
    until the Vertex AI Vector Search adapter ships (D16).

    Args:
        payload: Validated `VectorSearchInput`.

    Returns:
        Validated `VectorSearchOutput`. Matches whose snippet or source
        carries a sensitive pattern are dropped before return.

    Raises:
        NotImplementedError: When live mode is requested. Phase-4 wiring
            will replace this with a real Vertex AI Vector Search call.
        ValueError: When `CAPABILITY_LAYER_MODE` is set to an unknown value.
    """
    mode = os.environ.get(_CAPABILITY_MODE_ENV, "stub").lower()
    if mode not in _VALID_MODES:
        raise ValueError(
            f"{_CAPABILITY_MODE_ENV} must be one of {_VALID_MODES!r}, "
            f"got {mode!r}"
        )
    if mode == "live":
        return _live_search(payload)
    return _stub_search(payload)


# Surface the USD cost on the function for cost_watch (D42).
vector_search_competitor.usd_cost = USD_COST  # type: ignore[attr-defined]


__all__ = [
    "USD_COST",
    "VectorMatch",
    "VectorSearchInput",
    "VectorSearchOutput",
    "vector_search_competitor",
]
