"""tests/tools/test_gmail_send_reply.py — W2-B7 capability layer test.

Coverage matrix:
    TestInputContract      — Pydantic validation gates (D41).
    TestStubDeterminism    — same (thread_id, recipient) → same message_id.
    TestDryRunPreserved    — stub forces `dry_run_applied=True` regardless of input.
    TestD10Allowlist       — live mode rejects recipients NOT in {app.2weeks@gmail.com}.
    TestLiveSend           — allow-listed recipient + live ⇒ SMTP send (mocked);
                             dry_run short-circuits; missing creds fail loud.
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
# TestLiveSend — W7: allow-listed recipient + live mode performs a real SMTP
# submission (mocked here). dry_run short-circuits; missing creds fail loud.
# ─────────────────────────────────────────────────────────────────────────────


class TestLiveSend:
    """Live mode = Gmail API send reusing the backend's connected OAuth token.
    All network legs (backend token fetch, OAuth refresh, Gmail send) are mocked
    so the suite stays offline."""

    def test_live_dry_run_short_circuits_without_network(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """dry_run=True in live mode returns a synthetic id and contacts nothing
        — the HITL preview gate relies on this."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")

        def _boom(*_a: object, **_k: object) -> object:  # pragma: no cover
            raise AssertionError("dry_run must not hit the network")

        monkeypatch.setattr("ss_agents.tools.backend_client.fetch_gmail_token", _boom)
        out = gmail_send_reply(_input(recipient_email="sejun@2weeks.co", dry_run=True))
        assert out.dry_run_applied is True

    def test_live_unconnected_account_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Allow-listed recipient + live + no connected token ⇒ RuntimeError
        pointing at the connect flow (fail loud, never a silent drop)."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")

        def _no_token(_email: str) -> dict:
            raise RuntimeError("no connected Gmail token — connect via apps/web /api/auth/gmail/start")

        monkeypatch.setattr("ss_agents.tools.backend_client.fetch_gmail_token", _no_token)
        with pytest.raises(RuntimeError, match=r"connect"):
            gmail_send_reply(_input(recipient_email="sejun@2weeks.co"))

    def test_live_send_uses_backend_token_and_gmail_api(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Allow-listed recipient + live + connected token ⇒ refresh + one Gmail
        API send, returning the Gmail message id and dry_run_applied=False."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        monkeypatch.setenv("GOOGLE_CLIENT_ID", "cid.apps.googleusercontent.com")
        monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "secret")
        monkeypatch.setattr(
            "ss_agents.tools.backend_client.fetch_gmail_token",
            lambda _e: {"refreshToken": "rt-123", "accessToken": "at-old", "scope": "gmail.send"},
        )

        posted: list[dict[str, object]] = []

        class _Resp:
            def __init__(self, status: int, payload: dict[str, object]) -> None:
                self.status_code = status
                self._payload = payload
                self.text = str(payload)

            def json(self) -> dict[str, object]:
                return self._payload

        def _fake_post(url: str, **kwargs: object) -> _Resp:
            posted.append({"url": url, **kwargs})
            if url.endswith("/token"):
                return _Resp(200, {"access_token": "at-fresh"})
            return _Resp(200, {"id": "gmail-msg-id-1", "threadId": "t1"})

        import httpx

        monkeypatch.setattr(httpx, "post", _fake_post)
        out = gmail_send_reply(_input(recipient_email="sejun@2weeks.co"))
        assert out.dry_run_applied is False
        assert out.message_id == "gmail-msg-id-1"
        assert out.sent_to == "sejun@2weeks.co"
        # Two POSTs: refresh + send; the send carried the fresh bearer token.
        urls = [p["url"] for p in posted]
        assert any(u.endswith("/token") for u in urls)
        send_call = next(p for p in posted if "messages/send" in str(p["url"]))
        assert send_call["headers"]["Authorization"] == "Bearer at-fresh"

    def test_live_send_html_body_is_multipart_alternative(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Regression: an HTML body (with <br>) must go out as
        multipart/alternative — a text/html part Gmail renders + a text/plain
        fallback. A lone text/plain part makes recipients see literal "<br>"
        (the bug this guards against)."""
        import base64
        from email import message_from_bytes
        from email.policy import default as default_policy

        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        monkeypatch.setenv("GOOGLE_CLIENT_ID", "cid.apps.googleusercontent.com")
        monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "secret")
        monkeypatch.setattr(
            "ss_agents.tools.backend_client.fetch_gmail_token",
            lambda _e: {"refreshToken": "rt-123", "scope": "gmail.send"},
        )

        posted: list[dict[str, object]] = []

        class _Resp:
            status_code = 200

            def __init__(self, payload: dict[str, object]) -> None:
                self._payload = payload
                self.text = str(payload)

            def json(self) -> dict[str, object]:
                return self._payload

        def _fake_post(url: str, **kwargs: object) -> _Resp:
            posted.append({"url": url, **kwargs})
            if url.endswith("/token"):
                return _Resp({"access_token": "at-fresh"})
            return _Resp({"id": "gmail-msg-id-2", "threadId": "t2"})

        import httpx

        monkeypatch.setattr(httpx, "post", _fake_post)
        gmail_send_reply(
            _input(
                recipient_email="sejun@2weeks.co",
                reply_body="Hi there,<br><br>Line two here.<br>Best,<br>The Team",
            )
        )

        send_call = next(p for p in posted if "messages/send" in str(p["url"]))
        raw_b64 = send_call["json"]["raw"]  # type: ignore[index]
        mime = message_from_bytes(base64.urlsafe_b64decode(raw_b64), policy=default_policy)
        assert mime.get_content_type() == "multipart/alternative"

        parts = {p.get_content_type(): p.get_content() for p in mime.walk() if p.get_content_type().startswith("text/")}
        assert "text/html" in parts and "text/plain" in parts
        # The HTML part keeps <br> (Gmail renders it as a line break)…
        assert "<br>" in parts["text/html"]
        # …and the plain-text fallback has NO literal <br> (turned into newlines).
        assert "<br>" not in parts["text/plain"]
        assert "Line two here." in parts["text/plain"]


# ─────────────────────────────────────────────────────────────────────────────
# TestCostAttribute.
# ─────────────────────────────────────────────────────────────────────────────


class TestCostAttribute:
    def test_cost_attribute_exposed(self) -> None:
        assert hasattr(gmail_send_reply, "usd_cost")
        assert gmail_send_reply.usd_cost == USD_COST  # type: ignore[attr-defined]
        assert isinstance(gmail_send_reply.usd_cost, float)  # type: ignore[attr-defined]
