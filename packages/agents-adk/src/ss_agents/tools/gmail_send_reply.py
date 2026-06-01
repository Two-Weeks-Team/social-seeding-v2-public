"""gmail_send_reply — capability layer per D41 + D10 allow-list.

Sends a single reply on an existing Gmail thread on behalf of the workspace's
connected Gmail account. Used by the conversation_responder agent (Tier-1 #5)
AFTER the workflow's compliance + payment_mandate gates clear.

Demo-safety contract (D10):
    Gmail sends in this codebase are restricted to operator-owned test
    accounts. The current allow-list is exactly:
        {"app.2weeks@gmail.com"}
    Any attempt to send to an address outside the allow-list in **live**
    mode raises `ValueError` BEFORE any Gmail API call would fire. This is
    the in-process belt-and-braces; the Gmail OAuth scope + workspace
    policy at the edge do the deep work.

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Forces `dry_run=True` regardless of input — the stub MUST NEVER send.
    Returns a deterministic synthetic message_id derived from
    `thread_id + recipient` so /goal evaluator + golden tests can pin
    against a stable surface. `dry_run_applied=True` is the audit signal
    that the path was the stub.

Live mode (CAPABILITY_LAYER_MODE=live):
    Sends over Gmail SMTP submission (smtp.gmail.com:587 STARTTLS) using an
    app password, after enforcing the D10 allow-list. Credentials come from
    env: ``GMAIL_SMTP_USER`` (the operator mailbox, also the only allowed
    recipient) + ``GMAIL_APP_PASSWORD`` (a Google App Password — requires 2FA
    on the account). When the recipient is allow-listed but the credential
    env is absent, a ``RuntimeError`` names exactly which vars are missing so
    a misconfigured deploy fails loud instead of silently dropping the send.
    A ``dry_run=True`` input still short-circuits to a synthetic id without
    contacting SMTP (HITL preview gates rely on this).

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern.
    D10 — Gmail demo: send only to operator-owned test accounts.
    D33 — Memory 14d. Sent messages may be persisted to Memory Bank with a
          14-day TTL; the tool itself is stateless.
    conversation_responder.spec.md §5 — `WF->>SP: persist v2_outbox row
          (CMEK D20) → gmail.send dispatch`.

Per-call cost: $0.0001 (Gmail API call is essentially free at this volume).
"""
from __future__ import annotations

import logging
import os
import re
from datetime import UTC, datetime
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

USD_COST: float = 0.0001
"""Per-call USD attribution surfaced via `gmail_send_reply.usd_cost` for the
runtime's `cost_watch` aggregator (D41). Gmail API quota is effectively free
at the volume the demo operates at — the cost is dominated by the surrounding
Pub/Sub round-trip."""


# ─────────────────────────────────────────────────────────────────────────────
# D10 allow-list — the single source of truth.
#
# Kept as a frozenset (not a list) so it cannot be mutated at runtime; tests
# that need a different allow-list should monkeypatch `_ALLOWED_RECIPIENTS`
# rather than mutate in place.
# ─────────────────────────────────────────────────────────────────────────────


_ALLOWED_RECIPIENTS: frozenset[str] = frozenset(
    {"app.2weeks@gmail.com", "sejun@2weeks.co", "centisgood@gmail.com"}
)
"""D10: only operator-owned test accounts may receive a live send. The allow-list
is enforced in LIVE mode only — stub mode forces `dry_run=True` so the check is
moot. `sejun@2weeks.co` / `centisgood@gmail.com` are the operator's connected
Gmail test mailboxes (see the reusable connect flow in apps/web)."""


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, with `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class GmailSendReplyInput(BaseModel):
    """Input contract — per W2-B7 task brief.

    Attributes:
        thread_id:       Gmail thread id (`thr_…` or RFC-2822 Message-ID
                         prefix). The reply joins this thread; we do not
                         start new threads from this capability.
        reply_subject:   The reply's `Subject:` header. Should NOT include
                         a `Re:` prefix — the conversation_responder spec §6
                         explicitly forbids that.
        reply_body:      Plain-text body. HTML formatting is handled by the
                         live impl (rich text inferred from line breaks).
        recipient_email: RFC-5322 `To:` address. Enforced against the D10
                         allow-list in LIVE mode.
        sender_alias:    Optional friendly display name for the `From:`
                         header (e.g. "Freshly Vitamin C Team
                         <app.2weeks@gmail.com>"). The actual address is
                         the workspace's connected Gmail account.
        dry_run:         When True, the live path returns a synthetic
                         message_id WITHOUT calling the Gmail API. The
                         workflow uses this for HITL preview gates. Stub
                         mode forces `dry_run=True` regardless.
    """

    model_config = ConfigDict(extra="forbid")

    thread_id: str = Field(min_length=1, max_length=120)
    reply_subject: str = Field(min_length=1, max_length=120)
    reply_body: str = Field(min_length=1, max_length=8_000)
    recipient_email: str = Field(
        min_length=3,
        max_length=320,
        pattern=r"^[^\s@]+@[^\s@]+\.[^\s@]+$",
    )
    sender_alias: str | None = Field(default=None, max_length=200)
    dry_run: bool


class GmailSendReplyOutput(BaseModel):
    """Output contract — per W2-B7 task brief.

    Attributes:
        message_id:       Gmail-issued message id (live) OR a deterministic
                          synthetic id (stub).
        sent_at:          UTC timestamp at which the send was attempted /
                          recorded. In stub + dry_run the timestamp is the
                          current wall clock (still useful for replay
                          ordering — determinism is on the message_id, not
                          on this field).
        sent_to:          Echo of `recipient_email`. Audit-only.
        dry_run_applied:  True iff the send path skipped the actual Gmail
                          API call. Always True in stub mode; in live mode
                          tracks the `dry_run` input bit.
    """

    model_config = ConfigDict(extra="forbid")

    message_id: str = Field(min_length=1, max_length=200)
    sent_at: datetime
    sent_to: str = Field(min_length=3, max_length=320)
    dry_run_applied: bool


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def gmail_send_reply(payload: GmailSendReplyInput) -> GmailSendReplyOutput:
    """Send a reply on an existing Gmail thread.

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`. The D10 allow-list is enforced in LIVE
    mode BEFORE any send would fire.

    Args:
        payload: Validated `GmailSendReplyInput`.

    Returns:
        `GmailSendReplyOutput` with the resolved message_id, sent_at,
        sent_to, and `dry_run_applied` audit flag.

    Raises:
        ValueError: in LIVE mode when `recipient_email` is not in the D10
            allow-list. The error message names the violated recipient so
            the operator can diagnose without re-reading this docstring.
        NotImplementedError: in LIVE mode when the recipient IS allow-listed
            but the W7 deploy-phase Gmail client is not yet wired. The
            runtime converts to a typed `EscalateToHuman`.
    """
    # SS_GMAIL_LIVE=1 forces THIS tool live independent of the global
    # CAPABILITY_LAYER_MODE — mirrors SS_TIKTOK_LIVE, so a full-loop run can keep
    # the still-stubbed W7 tools (carrier/dam/bigquery) deterministic while gmail
    # really sends to the D10 allow-listed operator mailbox.
    gmail_live = os.getenv("SS_GMAIL_LIVE") == "1"
    mode = "live" if gmail_live else os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
gmail_send_reply.usd_cost = USD_COST  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub — deterministic, NEVER sends. dry_run is forced True.
#
# Algorithm:
#   1. Force `dry_run_applied = True` regardless of input (the stub MUST
#      never send a real email, even if the caller forgot to set the flag).
#   2. Mint a deterministic message_id from `thread_id + recipient_email`
#      so /goal + replay tests see byte-identical output.
#   3. Stamp `sent_at` with the current UTC wall clock — determinism is on
#      message_id, not on this field.
# ─────────────────────────────────────────────────────────────────────────────


def _stub(payload: GmailSendReplyInput) -> GmailSendReplyOutput:
    """Deterministic stub. Same (thread_id, recipient) → same message_id."""
    message_id = _synth_message_id(payload.thread_id, payload.recipient_email)
    sent_at = datetime.now(tz=UTC)

    logger.info(
        "gmail_send_reply_stub",
        extra={
            "thread_id": payload.thread_id,
            "recipient": payload.recipient_email,
            "message_id": message_id,
            "dry_run_input": payload.dry_run,
            "dry_run_applied": True,
        },
    )

    return GmailSendReplyOutput(
        message_id=message_id,
        sent_at=sent_at,
        sent_to=payload.recipient_email,
        dry_run_applied=True,
    )


def _synth_message_id(thread_id: str, recipient_email: str) -> str:
    """Mint a deterministic synthetic message_id.

    Format: `stub_msg_<8-char-hash>` — short enough to fit Gmail's message-id
    length budget, long enough to be unique within a test run. The hash is
    a tiny FNV-style 32-bit hash of `f"{thread_id}|{recipient_email}"` so
    different (thread, recipient) pairs hash to different ids.
    """
    seed = f"{thread_id}|{recipient_email}".encode()
    h = 0x811C9DC5
    for ch in seed:
        h ^= ch
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"stub_msg_{h:08x}"


# ─────────────────────────────────────────────────────────────────────────────
# Live — Gmail API send, reusing the v1 backend's connected OAuth token (W7).
#
# Token flow (reuses the platform's existing infrastructure rather than a new
# credential): the reusable connect flow (apps/web /api/auth/gmail/start) stores
# a gmail.send refresh token in the SHARED backend `user_tokens`. Here we fetch
# that token (backend_client), refresh it with the shared Google OAuth client,
# and call the Gmail API `users.messages.send`. D10 is enforced FIRST so a
# misconfigured run can never send to a non-operator address.
# ─────────────────────────────────────────────────────────────────────────────


_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
_GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
_HTTP_TIMEOUT = 30.0
# Gmail thread ids are hex strings (e.g. "19e8248d22073209"). Used to decide
# whether thread_id is a real Gmail thread (pass to the API) or a synthetic
# workflow id (omit, so the API doesn't 404).
_GMAIL_THREAD_ID_RE = re.compile(r"[0-9a-f]{8,20}")


def _sender_address(payload: GmailSendReplyInput) -> str:
    """The connected mailbox to send AS. Defaults to GMAIL_SENDER, else the
    recipient (operator self-send for verification). Must itself be operator-
    owned (the connected account whose token we use)."""
    return (os.getenv("GMAIL_SENDER", "").strip() or payload.recipient_email)


def _mint_access_token(refresh_token: str) -> str:
    """Exchange the connected refresh token for a fresh access token via the
    shared Google OAuth client (GOOGLE_CLIENT_ID/SECRET)."""
    import httpx

    # Accept both env names: the web service wires GOOGLE_OAUTH_CLIENT_ID,
    # local/agents use GOOGLE_CLIENT_ID — same shared OAuth client either way.
    client_id = (os.getenv("GOOGLE_OAUTH_CLIENT_ID") or os.getenv("GOOGLE_CLIENT_ID") or "").strip()
    client_secret = (
        os.getenv("GOOGLE_OAUTH_CLIENT_SECRET") or os.getenv("GOOGLE_CLIENT_SECRET") or ""
    ).strip()
    if not client_id or not client_secret:
        raise RuntimeError(
            "gmail_send_reply live mode: missing OAuth client env "
            "(GOOGLE_OAUTH_CLIENT_ID/SECRET or GOOGLE_CLIENT_ID/SECRET)"
        )
    resp = httpx.post(
        _GOOGLE_TOKEN_URL,
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        },
        timeout=_HTTP_TIMEOUT,
    )
    if resp.status_code != 200:
        raise RuntimeError(
            f"gmail_send_reply live mode: token refresh failed ({resp.status_code}); "
            "the connected Gmail token may be revoked — reconnect via "
            "apps/web /api/auth/gmail/start."
        )
    token = resp.json().get("access_token")
    if not token:
        raise RuntimeError("gmail_send_reply live mode: token refresh returned no access_token")
    return token


def _live(payload: GmailSendReplyInput) -> GmailSendReplyOutput:
    """Live Gmail send via the Gmail API, reusing the backend's stored token.

    Order of operations (fail-closed):
        1. D10 allow-list check — recipient MUST be operator-owned.
        2. ``dry_run`` short-circuit — return a synthetic id, contact nothing.
        3. Fetch the connected OAuth token (shared backend user_tokens).
        4. Refresh → access token (shared Google OAuth client).
        5. Build the MIME reply (threaded) and POST users.messages.send.

    Raises:
        ValueError: recipient not in the D10 allow-list.
        RuntimeError: account not connected, token revoked, or the Gmail API
            call fails — each message says exactly what to fix.
    """
    if payload.recipient_email not in _ALLOWED_RECIPIENTS:
        raise ValueError(
            f"gmail_send_reply live mode: recipient "
            f"{payload.recipient_email!r} is not in the D10 allow-list "
            f"{sorted(_ALLOWED_RECIPIENTS)!r}. "
            "Gmail sends are restricted to operator-owned test accounts."
        )

    # dry_run preview never contacts the network — synthetic id, audit flag True.
    if payload.dry_run:
        return GmailSendReplyOutput(
            message_id=_synth_message_id(payload.thread_id, payload.recipient_email),
            sent_at=datetime.now(tz=UTC),
            sent_to=payload.recipient_email,
            dry_run_applied=True,
        )

    import base64

    import httpx

    from . import backend_client

    sender = _sender_address(payload)
    token_doc = backend_client.fetch_gmail_token(sender)
    refresh_token = token_doc.get("refreshToken")
    if not refresh_token:
        raise RuntimeError(
            f"gmail_send_reply live mode: connected token for {sender!r} has no "
            "refresh token — reconnect via apps/web /api/auth/gmail/start."
        )
    access_token = _mint_access_token(refresh_token)

    message = EmailMessage()
    message["From"] = formataddr((payload.sender_alias, sender)) if payload.sender_alias else sender
    message["To"] = payload.recipient_email
    message["Subject"] = payload.reply_subject
    message["Date"] = formatdate(localtime=False)
    msg_id = make_msgid(domain="socialseed.ing")
    message["Message-ID"] = msg_id
    message.set_content(payload.reply_body)

    raw = base64.urlsafe_b64encode(message.as_bytes()).decode()
    # Gmail threads via the API `threadId`, not RFC In-Reply-To/References (we
    # don't have the parent Message-ID here). Only pass threadId when thread_id
    # is a real Gmail thread id (hex) — a synthetic id (e.g. a demo
    # "thr_…"/"goal-…") would make the API 404, so omit it and let Gmail open a
    # new conversation.
    send_body: dict[str, str] = {"raw": raw}
    if _GMAIL_THREAD_ID_RE.fullmatch(payload.thread_id):
        send_body["threadId"] = payload.thread_id
    resp = httpx.post(
        _GMAIL_SEND_URL,
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        json=send_body,
        timeout=_HTTP_TIMEOUT,
    )
    if resp.status_code != 200:
        raise RuntimeError(
            f"gmail_send_reply live mode: Gmail API send failed "
            f"({resp.status_code}): {resp.text[:200]}"
        )
    gmail_id = resp.json().get("id") or msg_id

    sent_at = datetime.now(tz=UTC)
    logger.info(
        "gmail_send_reply_live",
        extra={
            "thread_id": payload.thread_id,
            "recipient": payload.recipient_email,
            "sender": sender,
            "message_id": gmail_id,
            "dry_run_applied": False,
        },
    )
    return GmailSendReplyOutput(
        message_id=gmail_id,
        sent_at=sent_at,
        sent_to=payload.recipient_email,
        dry_run_applied=False,
    )


__all__ = [
    "GmailSendReplyInput",
    "GmailSendReplyOutput",
    "USD_COST",
    "gmail_send_reply",
]
