"""Unit tests for ``model_armor.py`` — custom-regex pre-filter + stub mode."""

from __future__ import annotations

import asyncio

import pytest

from tiktok_orchestrator import model_armor
from tiktok_orchestrator.model_armor import (
    SanitizationOutcome,
    _scan_custom_patterns,
    sanitize_prompt,
    sanitize_response,
)


def test_custom_regex_catches_gcp_api_key() -> None:
    hits = _scan_custom_patterns(
        "leaked: AIzaSyDxVlAabc1234567890abc1234567890abcdEF"
    )
    assert "gcp_api_key" in hits


def test_custom_regex_catches_aws_access_key() -> None:
    hits = _scan_custom_patterns("oops AKIAEXAMPLEEXAMPLEXX in config")
    assert "aws_access_key" in hits


def test_custom_regex_catches_influencer_id() -> None:
    hits = _scan_custom_patterns("Lookup INF-12345678 for the campaign.")
    assert "influencer_id" in hits


def test_custom_regex_catches_private_key_block() -> None:
    hits = _scan_custom_patterns(
        "credential\n-----BEGIN RSA PRIVATE KEY-----\nMIIE..."
    )
    assert "private_key_block" in hits


def test_custom_regex_clean_text_returns_empty() -> None:
    hits = _scan_custom_patterns("a totally benign brief about vegan skincare")
    assert hits == []


def test_sanitize_prompt_stub_mode_passes_through() -> None:
    out: SanitizationOutcome = asyncio.run(sanitize_prompt("vegan skincare brief"))
    assert out.blocked is False
    assert out.text == "vegan skincare brief"
    assert "stub_mode" in out.reasons


def test_sanitize_response_stub_mode_passes_through() -> None:
    out = asyncio.run(sanitize_response("ranked creators output"))
    assert out.blocked is False
    assert out.text == "ranked creators output"


def test_sanitize_prompt_blocks_on_custom_pattern_even_in_stub_mode() -> None:
    # Custom-regex pre-filter runs BEFORE stub mode → it should still fire.
    out = asyncio.run(
        sanitize_prompt("here is my GCP key AIzaSyDxVlAabc1234567890abc1234567890abcdEF")
    )
    assert out.blocked is True
    assert out.text == ""
    assert any(r.startswith("custom_regex:gcp_api_key") for r in out.reasons)


def test_fail_closed_when_template_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    """Disable stub; clear template — fail mode closed must block."""
    monkeypatch.setattr(model_armor, "STUB_MODE", False)
    monkeypatch.setattr(model_armor, "TEMPLATE_INPUT", "")
    monkeypatch.setattr(model_armor, "FAIL_MODE", "closed")
    out = asyncio.run(sanitize_prompt("benign brief"))
    assert out.blocked is True
    assert "template_not_configured" in out.reasons


def test_fail_open_passes_through_when_misconfigured(monkeypatch: pytest.MonkeyPatch) -> None:
    """Verify the audit-only ``open`` toggle does what it claims (so the
    audit playbook can confirm it catches a misconfig)."""
    monkeypatch.setattr(model_armor, "STUB_MODE", False)
    monkeypatch.setattr(model_armor, "TEMPLATE_INPUT", "")
    monkeypatch.setattr(model_armor, "FAIL_MODE", "open")
    out = asyncio.run(sanitize_prompt("benign brief"))
    assert out.blocked is False
    assert "fail_open_degraded" in out.reasons
