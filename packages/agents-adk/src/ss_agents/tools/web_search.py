"""`web.search` capability — public-web search for brand/competitor context.

Capability-layer FunctionTool following the **W2-A1 canonical form** locked in
DECISIONS.md **D41** (capability layer ADK FunctionTool stub/live):

    def tool_fn(input: PydanticInputModel) -> PydanticOutputModel

The runtime selects between `stub` and `live` implementations via the
`CAPABILITY_LAYER_MODE` environment variable (default = `stub`). Stubs return
deterministic canned data so dev + CI traffic is fully reproducible. Live mode
will dispatch to Vertex AI Search / Google Search grounding when wired —
until then it raises `NotImplementedError` with a precise migration hint.

Per-tool USD cost is surfaced via the module-level `USD_COST` attribute so
`cost_watch` (D42) can deduct from the campaign budget without instantiating
the tool. Cost reflects the **median** Google Search grounding spend per call
($35 / 1 000 queries × 1 query ≈ $0.035) per `GEMINI-MODELS §6.5`.

Used by:
    research agent (Tier-1 #9, D23) — brand/competitor pre-campaign briefing.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern.
    D21 — Model Armor scans the result text before it reaches the model
          (the URL redaction here is the in-process belt-and-braces).
    research.spec.md §6 — `web.search` tool entry on the research agent.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Final, Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator

logger = logging.getLogger(__name__)


# Per-tool USD cost surfaced as a module attribute so `cost_watch` (D42) can
# read it without instantiating the tool. Median Google Search grounding
# spend per call ($35 / 1 000 queries × 1 query). See GEMINI-MODELS §6.5.
USD_COST: Final[float] = 0.035

# Capability-layer mode env var (D41). Default `stub` keeps CI/dev offline.
_CAPABILITY_MODE_ENV: Final[str] = "CAPABILITY_LAYER_MODE"
_VALID_MODES: Final[tuple[str, ...]] = ("stub", "live")

# Locales supported by the surrounding agent fleet (D34: ko/en/ja/zh-CN).
WebSearchLocale = Literal["ko", "en", "ja", "zh-CN"]

# URL substrings that suggest a secret leak in the URL (query params often
# carry tokens, sessions, passwords from misconfigured backends). Anything
# matching is **redacted** before being returned to the agent — the URL is
# replaced with `[redacted]` and the snippet is stripped of the matched value.
# Conservative on purpose; false positives cost UX, false negatives leak creds.
_SENSITIVE_URL_PATTERNS: Final[tuple[re.Pattern[str], ...]] = (
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


class WebSearchInput(BaseModel):
    """Search the public web for brand or competitor context.

    Fields:
        query:        Search terms (1-400 chars). Free text — the runtime
                      prompt-guard has already scanned the upstream payload,
                      but we still cap the length so an over-long query
                      can't blow the Vertex round-trip cost.
        locale:       Output language hint. Maps to a `gl=` / `hl=` Google
                      Search parameter at live wiring time. D34 = 4 locales.
        max_results:  Hard cap on `results[]` (1-25, default 10). The spec
                      ships 10 because that's the median pre-campaign card
                      result count operators care about.
    """

    model_config = ConfigDict(extra="forbid")

    query: str = Field(min_length=1, max_length=400)
    locale: WebSearchLocale = "en"
    max_results: int = Field(default=10, ge=1, le=25, alias="maxResults")

    @field_validator("query")
    @classmethod
    def _strip_query(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("query must be non-empty after stripping whitespace")
        return v


class WebSearchResult(BaseModel):
    """One search-result row. Validated as a strict Pydantic model so the
    live wiring can't silently widen the contract."""

    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=300)
    url: str = Field(min_length=1, max_length=2_000)
    snippet: str = Field(min_length=1, max_length=600)
    published_date: str | None = Field(
        default=None,
        alias="publishedDate",
        description="ISO-8601 date when known; null otherwise.",
    )

    @field_validator("url")
    @classmethod
    def _validate_url_shape(cls, v: str) -> str:
        """Reject anything that doesn't parse as an http(s) URL.

        Uses Pydantic's `HttpUrl` only for the **validation pass** — we
        return the raw string so downstream callers don't lose the exact
        URL the search engine emitted (HttpUrl normalizes trailing slashes,
        which would break citation matching against the model's parametric
        knowledge)."""
        try:
            HttpUrl(v)
        except Exception as exc:  # noqa: BLE001 — propagate as ValueError
            raise ValueError(f"url must be a valid http(s) URL: {exc}") from exc
        return v


class WebSearchOutput(BaseModel):
    """Validated search-tool output. `results[]` is hard-capped by Pydantic
    so a misbehaving live backend can't flood the model context."""

    model_config = ConfigDict(extra="forbid")

    results: list[WebSearchResult] = Field(default_factory=list, max_length=25)


# ─────────────────────────────────────────────────────────────────────────────
# Redaction.
# ─────────────────────────────────────────────────────────────────────────────


def _contains_secret(url: str) -> bool:
    """Does `url` carry an obvious credential in its query string?"""
    return any(pat.search(url) for pat in _SENSITIVE_URL_PATTERNS)


def _redact_results(results: list[WebSearchResult]) -> list[WebSearchResult]:
    """Replace any result whose URL contains a secret pattern with a
    `[redacted]` placeholder. The snippet is dropped to `'[redacted]'` so the
    model can't reconstruct the secret from the surrounding context.

    Importantly: we DROP the row entirely rather than emit a `[redacted]`
    placeholder URL, because a placeholder URL fails Pydantic's HttpUrl
    validation downstream and the goal is to keep the agent's view of the
    web clean, not to advertise that something was hidden.
    """
    cleaned: list[WebSearchResult] = []
    dropped = 0
    for r in results:
        if _contains_secret(r.url):
            dropped += 1
            logger.info(
                "web_search_redacted_secret_url",
                extra={"reason": "sensitive_pattern_in_url"},
            )
            continue
        cleaned.append(r)
    if dropped:
        logger.warning(
            "web_search_redaction_summary",
            extra={"dropped": dropped, "kept": len(cleaned)},
        )
    return cleaned


# ─────────────────────────────────────────────────────────────────────────────
# Stub + live implementations.
# ─────────────────────────────────────────────────────────────────────────────


# Deterministic canned data for the spec's reference query. Keyed by the
# exact normalized query string so tests get pin-tight reproducibility.
_STUB_CORPUS: Final[dict[str, list[dict[str, str | None]]]] = {
    "social seeding": [
        {
            "title": "What is social seeding? A 2026 primer",
            "url": "https://example.com/social-seeding-primer",
            "snippet": (
                "Social seeding distributes products to a curated set of "
                "creators so genuine first-week posts seed downstream reach."
            ),
            "publishedDate": "2026-01-12",
        },
        {
            "title": "Social seeding vs paid influencer ads — the trade-offs",
            "url": "https://example.com/social-seeding-vs-paid",
            "snippet": (
                "Seeded posts feel native; paid ads scale predictably. "
                "Most K-beauty brands run both in parallel."
            ),
            "publishedDate": "2025-11-04",
        },
        {
            "title": "Case study: K-beauty seeding cohort retention",
            "url": "https://example.com/case-study-kbeauty-seeding",
            "snippet": (
                "Sixty creators were sent samples; thirty-eight posted within "
                "two weeks. Engagement rates beat the brand's paid baseline."
            ),
            "publishedDate": "2026-02-19",
        },
        {
            "title": "Social seeding toolchain comparison",
            "url": "https://example.com/seeding-toolchain-comparison",
            "snippet": (
                "Operators evaluated five seeding platforms by reply rate, "
                "shipping logistics, and reporting fidelity."
            ),
            "publishedDate": None,
        },
        {
            "title": "Social seeding glossary",
            "url": "https://example.com/seeding-glossary",
            "snippet": (
                "Key terms: seeded creator, sample-only deal, "
                "earned post, post-verification, and reply-rate baseline."
            ),
            "publishedDate": "2025-09-30",
        },
    ],
}


def _stub_search(payload: WebSearchInput) -> WebSearchOutput:
    """Deterministic stub.

    For the reference query `"social seeding"` returns the canned 5-row
    corpus above (sliced to `max_results`). For any other query, synthesizes
    `min(max_results, 5)` deterministic rows derived from the query string —
    enough to exercise the agent loop without ever touching the network.
    """
    normalized = payload.query.strip().lower()
    canned = _STUB_CORPUS.get(normalized)

    if canned is not None:
        rows = [WebSearchResult.model_validate(r) for r in canned]
    else:
        # Deterministic synthesis: 5 rows derived from the query slug.
        slug = re.sub(r"[^a-z0-9]+", "-", normalized).strip("-") or "query"
        rows = [
            WebSearchResult(
                title=f"Synthetic stub result {i + 1} for {payload.query!r}",
                url=f"https://stub.invalid/{slug}/{i + 1}",
                snippet=(
                    f"Deterministic stub snippet {i + 1} for query "
                    f"{payload.query!r} (locale={payload.locale})."
                ),
                publishedDate=None,
            )
            for i in range(min(payload.max_results, 5))
        ]

    rows = rows[: payload.max_results]
    rows = _redact_results(rows)
    return WebSearchOutput(results=rows)


def _live_search(payload: WebSearchInput) -> WebSearchOutput:
    """Live implementation placeholder.

    Per D41 the live path will dispatch to Vertex AI Search (or
    google_search grounding inside the LlmAgent). Until that adapter ships
    we raise NotImplementedError with the exact env var the operator must
    flip back to switch off live mode."""
    raise NotImplementedError(
        "web.search live mode is not wired yet (D41 — capability layer "
        f"adapter pending). Set {_CAPABILITY_MODE_ENV}=stub to use the "
        f"deterministic stub, or wait for the Vertex AI Search adapter."
    )


# ─────────────────────────────────────────────────────────────────────────────
# Public entry point (the ADK FunctionTool surface).
# ─────────────────────────────────────────────────────────────────────────────


def web_search(payload: WebSearchInput) -> WebSearchOutput:
    """Search the public web for brand or competitor context.

    The runtime selects stub vs live via the `CAPABILITY_LAYER_MODE`
    environment variable (D41). The default is `stub` so CI/dev stay
    offline; production sets `live`.

    Args:
        payload: Validated `WebSearchInput`.

    Returns:
        Validated `WebSearchOutput`. URLs containing sensitive patterns
        (e.g. `password=`, `token=`) are dropped before return.

    Raises:
        NotImplementedError: When live mode is requested. Phase-4 wiring
            will replace this with a real Vertex AI Search call.
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


# Surface the USD cost on the function itself too, so callers that import
# only the function (not the module) can still introspect it.
web_search.usd_cost = USD_COST  # type: ignore[attr-defined]


__all__ = [
    "USD_COST",
    "WebSearchInput",
    "WebSearchLocale",
    "WebSearchOutput",
    "WebSearchResult",
    "web_search",
]
