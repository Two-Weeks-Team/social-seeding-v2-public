"""tests/tools/test_gmail_send_reply.py — W2-B7 capability layer test.

Coverage matrix:
    TestInputContract      — Pydantic validation gates (D41).
    TestStubDeterminism    — same (thread_id, recipient) → same message_id.
    TestDryRunPreserved    — stub forces `dry_run_applied=True` regardless of input.
    TestD10Allowlist       — live mode rejects recipients NOT in {app.2weeks@gmail.com}.
    TestLiveModeRaises     — allow-listed recipient + live ⇒ NotImplementedError.
    TestCostAttribute      — `gmail_send_reply.usd_cost` exposed.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.gmail_send_reply import (
    USD_COST,
    GmailSendReplyInput,
    GmailSendReplyOutput,
    gmail_send_reply,
)


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _force_stub_mode_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default every test to stub mode — live tests opt back into 'live'."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")


def _input(**overrides: object) -> GmailSendReplyInput:
    """Construct a baseline GmailSendReplyInput, allowing field overrides."""
    defaults: dict[str, object] = {
        "thread_id": "thr_demo_001",
        "reply_subject": "Thanks for your interest",
        "reply_body": "Hi there — here are the details you asked about.",
        "recipient_email": "app.2weeks@gmail.com",
        "sender_alias": None,
        "dry_run": False,
    }
    defaults.update(overrides)
    return GmailSendReplyInput(**defaults)  # type: ignore[arg-type]


# ─────────────────────────────────────────────────────────────────────────────
# TestInputContract.
# ─────────────────────────────────────────────────────────────────────────────


class TestInputContract:
    def test_minimal_input_validates(self) -> None:
        payload = _input()
        assert payload.thread_id == "thr_demo_001"
        assert payload.sender_alias is None
        assert payload.dry_run is False

    def test_empty_subject_rejected(self) -> None:
        with pytest.raises(ValidationError):
            _input(reply_subject="")

    def test_empty_body_rejected(self) -> None:
        with pytest.raises(ValidationError):
            _input(reply_body="")

    def test_invalid_recipient_email_rejected(self) -> None:
        with pytest.raises(ValidationError):
            _input(recipient_email="not-an-email")

    def test_unknown_field_rejected(self) -> None:
        with pytest.raises(ValidationError):
            GmailSendReplyInput.model_validate(
                {
                    "thread_id": "thr_demo_001",
                    "reply_subject": "Hello",
                    "reply_body": "Hi",
                    "recipient_email": "app.2weeks@gmail.com",
                    "dry_run": False,
                    "extra_field": "rejected",
                }
            )

    def test_dry_run_field_is_required(self) -> None:
        # `dry_run` has no default — callers must commit to a value.
        with pytest.raises(ValidationError):
            GmailSendReplyInput.model_validate(
                {
                    "thread_id": "thr_demo_001",
                    "reply_subject": "Hello",
                    "reply_body": "Hi",
                    "recipient_email": "app.2weeks@gmail.com",
                }
            )


# ─────────────────────────────────────────────────────────────────────────────
# TestStubDeterminism.
# ─────────────────────────────────────────────────────────────────────────────


class TestStubDeterminism:
    def test_same_inputs_yield_same_message_id(self) -> None:
        a = gmail_send_reply(_input())
        b = gmail_send_reply(_input())
        assert a.message_id == b.message_id

    def test_different_recipients_yield_different_message_ids(self) -> None:
        # We avoid hitting the live-mode allow-list here by staying in stub.
        a = gmail_send_reply(_input(recipient_email="app.2weeks@gmail.com"))
        b = gmail_send_reply(_input(recipient_email="other.demo@example.com"))
        assert a.message_id != b.message_id

    def test_different_threads_yield_different_message_ids(self) -> None:
        a = gmail_send_reply(_input(thread_id="thr_demo_001"))
        b = gmail_send_reply(_input(thread_id="thr_demo_002"))
        assert a.message_id != b.message_id


# ─────────────────────────────────────────────────────────────────────────────
# TestDryRunPreserved — stub MUST force dry_run_applied=True regardless of input.
# ─────────────────────────────────────────────────────────────────────────────


class TestDryRunPreserved:
    def test_stub_forces_dry_run_applied_true_when_input_is_false(self) -> None:
        """Even when caller passes `dry_run=False`, stub must NEVER send.
        Stub forces dry_run_applied=True."""
        out = gmail_send_reply(_input(dry_run=False))
        assert isinstance(out, GmailSendReplyOutput)
        assert out.dry_run_applied is True

    def test_stub_preserves_dry_run_true_when_input_is_true(self) -> None:
        out = gmail_send_reply(_input(dry_run=True))
        assert out.dry_run_applied is True

    def test_stub_echoes_recipient(self) -> None:
        out = gmail_send_reply(_input(recipient_email="app.2weeks@gmail.com"))
        assert out.sent_to == "app.2weeks@gmail.com"

    def test_stub_message_id_has_expected_prefix(self) -> None:
        out = gmail_send_reply(_input())
        # Stub mints `stub_msg_<hash>` ids so OTel / replay can spot them.
        assert out.message_id.startswith("stub_msg_")


# ─────────────────────────────────────────────────────────────────────────────
# TestD10Allowlist — the critical demo-safety guardrail.
#
# Per D10, in LIVE mode only `app.2weeks@gmail.com` may receive a send.
# Any other recipient must raise ValueError BEFORE any send would fire.
# ─────────────────────────────────────────────────────────────────────────────


class TestD10Allowlist:
    @pytest.mark.parametrize(
        "blocked_recipient",
        [
            "real.creator@example.com",
            "victim@gmail.com",
            "ceo@brand.co",
            "test@socialseed.ing",
            "anyone-not-allowlisted@example.org",
        ],
    )
    def test_live_mode_rejects_non_allowlisted_recipient(
        self,
        monkeypatch: pytest.MonkeyPatch,
        blocked_recipient: str,
    ) -> None:
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        with pytest.raises(ValueError, match=r"D10 allow-list"):
            gmail_send_reply(_input(recipient_email=blocked_recipient))

    def test_live_mode_error_names_blocked_recipient(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        with pytest.raises(ValueError, match=r"victim@example\.com") as exc:
            gmail_send_reply(_input(recipient_email="victim@example.com"))
        # The error names the violated recipient so the operator can diagnose.
        assert "victim@example.com" in str(exc.value)

    def test_stub_mode_does_not_enforce_allowlist(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Stub mode forces dry_run=True so the allow-list check is moot —
        an out-of-allow-list recipient in stub mode must not raise (it just
        records the dry-run output)."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = gmail_send_reply(_input(recipient_email="non.allowlisted@example.com"))
        assert out.dry_run_applied is True
        assert out.sent_to == "non.allowlisted@example.com"


# ─────────────────────────────────────────────────────────────────────────────
# TestLiveModeRaises — allow-listed recipient + live mode ⇒ NotImplementedError.
# ─────────────────────────────────────────────────────────────────────────────


class TestLiveModeRaises:
    def test_live_mode_with_allowlisted_recipient_raises_not_implemented(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Live mode with the allow-listed recipient should reach the W7
        deploy-phase NotImplementedError — not the allow-list ValueError."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        with pytest.raises(NotImplementedError, match=r"W7 deploy phase"):
            gmail_send_reply(_input(recipient_email="app.2weeks@gmail.com"))


# ─────────────────────────────────────────────────────────────────────────────
# TestCostAttribute.
# ─────────────────────────────────────────────────────────────────────────────


class TestCostAttribute:
    def test_cost_attribute_exposed(self) -> None:
        assert hasattr(gmail_send_reply, "usd_cost")
        assert gmail_send_reply.usd_cost == USD_COST  # type: ignore[attr-defined]
        assert isinstance(gmail_send_reply.usd_cost, float)  # type: ignore[attr-defined]
