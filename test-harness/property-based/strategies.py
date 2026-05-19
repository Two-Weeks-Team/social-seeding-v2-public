"""strategies.py — Hypothesis strategies for the 22-agent fleet's Pydantic shapes.

Cites: D17 (Agent Runtime — Python), D34 (4-locale parity), D37 (5-layer TDD).
MATRIX: §4.3 shared fixtures across the 16 T1 specs.

These strategies are the L3 property-test counterparts of the v2 Zod schemas
in `packages/contracts/`. They are deliberately **shape-faithful but not
exhaustive** — exhaustive ranges live in the per-agent Pydantic models
shipped under `packages/agents-adk/`.

The shapes here are the bare-bones contracts the harness asserts. When the
production Pydantic models land, this file imports them and re-exports
`builds(Model)` strategies — the test code does not change.
"""

from __future__ import annotations

import string

from hypothesis import strategies as st


# ---------------------------------------------------------------- locales
LOCALES = ["ko", "en", "ja", "zh"]  # D34


def locale() -> st.SearchStrategy[str]:
    return st.sampled_from(LOCALES)


# ---------------------------------------------------------------- atomic
def ulid() -> st.SearchStrategy[str]:
    # Crockford base32 — 26 chars. Faithful to MATRIX §5.1 `scenario_id` ULID format.
    return st.text(
        alphabet="0123456789ABCDEFGHJKMNPQRSTVWXYZ",
        min_size=26, max_size=26,
    )


def tenant_id() -> st.SearchStrategy[str]:
    return st.from_regex(r"^tnt_[a-z0-9_]{3,32}$", fullmatch=True)


def workspace_id() -> st.SearchStrategy[str]:
    return st.from_regex(r"^ws_[a-z0-9]{2,20}$", fullmatch=True)


def usd() -> st.SearchStrategy[float]:
    # Tenant budget cap: $0–$100,000.
    return st.floats(min_value=0.0, max_value=100_000.0, allow_nan=False, allow_infinity=False)


def follower_count() -> st.SearchStrategy[int]:
    # TikTok creator follower counts span 0 → ~100M.
    return st.integers(min_value=0, max_value=100_000_000)


def engagement_rate() -> st.SearchStrategy[float]:
    return st.floats(min_value=0.0, max_value=1.0, allow_nan=False)


# ---------------------------------------------------------------- inputs
def brand_brief_text(min_len: int = 1, max_len: int = 8_000) -> st.SearchStrategy[str]:
    """Free-text brand brief. The intake agent must accept any non-empty UTF-8
    string and either parse, sanitize, or escalate (EC-1.01..EC-1.10)."""
    return st.text(min_size=min_len, max_size=max_len)


def creator_handle() -> st.SearchStrategy[str]:
    # TikTok handle: @ + 2-24 chars [a-zA-Z0-9_.]
    return st.from_regex(r"^@[a-zA-Z0-9_.]{2,24}$", fullmatch=True)


def email_address() -> st.SearchStrategy[str]:
    # Loose RFC 5322; deliberately lax for fuzz coverage.
    user = st.from_regex(r"^[a-z0-9._]{2,20}$", fullmatch=True)
    host = st.sampled_from(["example.com", "example.org", "tenant.com", "creator.io"])
    return st.builds(lambda u, h: f"{u}@{h}", user, host)


# ---------------------------------------------------------------- outputs
def reply_label() -> st.SearchStrategy[str]:
    return st.sampled_from([
        "interested", "rejecting", "negotiating", "ambiguous",
        "out_of_scope", "spam", "complaint", "unsubscribe",
    ])


def escalation_reason() -> st.SearchStrategy[str]:
    return st.sampled_from([
        "insufficient_context", "budget_exceeded", "tool_failure",
        "prompt_injection_detected", "compliance_block",
        "sanctions_recipient", "replay_attack",
    ])


# ---------------------------------------------------------------- composites
@st.composite
def sourcing_input(draw) -> dict:
    """Shape-faithful Pydantic-equivalent for the sourcing agent."""
    return {
        "tenant_id": draw(tenant_id()),
        "workspace_id": draw(workspace_id()),
        "locale": draw(locale()),
        "budget_envelope_usd": draw(usd()),
        "creator_count_target": draw(st.integers(min_value=1, max_value=200)),
        "exclude_creator_ids": draw(st.lists(creator_handle(), max_size=20)),
        "brief": draw(brand_brief_text()),
    }


@st.composite
def vetting_input(draw) -> dict:
    return {
        "tenant_id": draw(tenant_id()),
        "creator_handle": draw(creator_handle()),
        "follower_count": draw(follower_count()),
        "engagement_rate": draw(engagement_rate()),
        "locale": draw(locale()),
    }


@st.composite
def outreach_input(draw) -> dict:
    return {
        "tenant_id": draw(tenant_id()),
        "creator_handle": draw(creator_handle()),
        "locale": draw(locale()),
        "brief_text": draw(brand_brief_text(min_len=20, max_len=4_000)),
        "force_spam_score": draw(st.floats(min_value=0.0, max_value=1.0)),
    }


@st.composite
def conversation_input(draw) -> dict:
    return {
        "tenant_id": draw(tenant_id()),
        "locale": draw(locale()),
        "reply_text": draw(st.text(min_size=0, max_size=2_000)),
    }


@st.composite
def payment_mandate_input(draw) -> dict:
    """D27 — Intent Mandate composition. Field-set is invariant."""
    return {
        "tenant_id": draw(tenant_id()),
        "locale": draw(locale()),
        "amount_usd": draw(usd()),
        "budget_cap_usd": draw(st.floats(min_value=0.0, max_value=100_000.0)),
        "recipient_country": draw(st.sampled_from(["US", "KR", "JP", "CN", "IR", "DE"])),
        "mandate_id": draw(ulid()),
    }
