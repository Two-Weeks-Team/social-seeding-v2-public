# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Social Seeding Inc.
"""A2A v0.3 Agent Card JWS signing + verification (D44, D48).

Implements the **AgentCard `signatures[]`** mechanism from the A2A v0.3
specification §"Signing and Verifying the AgentCard"
(https://a2a-protocol.org/v0.3.0/specification/), which layers an
RFC 7515 JSON Web Signature (JWS) over the agent card so any client can
cryptographically verify *who published the card*.

This complements — it does not replace — the SPIFFE/workload-identity story in
``AGENT-IDENTITY.md``:

    * ``identity`` block     — *names* the agent (SPIFFE ID), non-secret.
    * ``securitySchemes``    — declares caller (OIDC/OAuth) + agent (mTLS) auth.
    * ``signatures[]`` (here) — *proves* the card's authorship via a JWS the
                                holder of the agent's signing key produced.

Normative recipe (A2A v0.3, confirmed against the spec):

    1. Take the agent card JSON with any existing ``signatures`` key REMOVED
       (avoids a circular dependency — the signature can't cover itself).
    2. **Canonicalize** that object with the JSON Canonicalization Scheme
       (JCS, RFC 8785): lexicographic key ordering + deterministic primitive
       encoding, so signer and verifier compute identical bytes.
    3. Build a JWS **protected header** ``{"alg", "kid", "jku"}`` and base64url
       (no padding) encode it.
    4. The JWS **Signing Input** is the standard RFC 7515 compact form:
       ``ASCII(BASE64URL(protected) + "." + BASE64URL(JCS(card)))``.
       (Non-detached payload — the payload is the canonical card itself.)
    5. Sign with the private key; base64url-encode the signature bytes.
    6. Append ``{"protected": <b64url>, "signature": <b64url>}`` to
       ``signatures[]`` on the card.

Verification reverses this: re-canonicalize the served card (signatures
stripped), rebuild the Signing Input from the entry's ``protected`` header,
and check the signature against the public key resolved from the JWKS.

Key strategy (honest scope per RULES.md):
    * **Dev / self-managed key** (this module's default): an ES256 (ECDSA
      P-256) keypair is generated on first use and written under
      ``deployment/keys/`` (git-ignored via ``*.pem``/``*.key``). Used for the
      open Track-3 demo (``REQUIRE_AUTH=false``), the smoke tests, and CI.
    * **Production key**: operator/Secret-Manager-provisioned and never on
      disk in the container (consistent with ``cloud-run-service.yaml``'s
      "secrets via Secret Manager only" stance). The signer reads it from the
      ``AGENT_CARD_SIGNING_KEY_PEM`` env var when present; otherwise it falls
      back to the dev key. No production private key lives in this repo.

Algorithm choice: **ES256** (ECDSA over P-256, SHA-256). EC keys match the
SPIFFE/X.509 workload-identity anchor described in ``AGENT-IDENTITY.md`` and
keep the public JWK compact. Only the public half is ever published (JWKS).
"""

from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric import utils as asym_utils

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

JWS_ALG = "ES256"  # ECDSA P-256 + SHA-256 (RFC 7518 §3.4)
DEFAULT_KID = "ss-agent-card-dev-2026-05"
# Default JWKS publication URL — overridable via env for the live deploy.
DEFAULT_JKU = "https://mcp.socialseed.ing/.well-known/jwks.json"

_KEY_DIR = Path(__file__).parent.parent.parent.parent / "deployment" / "keys"
_DEV_PRIVATE_KEY_PATH = _KEY_DIR / "agent-card-signing-dev.key"


# ---------------------------------------------------------------------------
# base64url helpers (RFC 7515 §2 — no padding)
# ---------------------------------------------------------------------------


def b64url_encode(data: bytes) -> str:
    """Base64url-encode without padding (RFC 7515 / RFC 4648 §5)."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(data: str) -> bytes:
    """Base64url-decode, restoring the stripped ``=`` padding."""
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


# ---------------------------------------------------------------------------
# JCS — JSON Canonicalization Scheme (RFC 8785)
# ---------------------------------------------------------------------------


def jcs_canonicalize(value: Any) -> bytes:
    """Serialize ``value`` to canonical JSON bytes per RFC 8785 (JCS).

    Rules applied:
        * object keys sorted lexicographically by their UTF-16 code units
          (Python ``sorted`` on ``str`` matches this for the BMP characters in
          an agent card);
        * no insignificant whitespace (compact ``","``/``":"`` separators);
        * ``ensure_ascii=False`` so non-ASCII stays as UTF-8 (JCS escapes only
          the RFC 8259 mandatory set, which ``json.dumps`` already honors);
        * integral floats normalized to integers (``2.0`` → ``2``) to match
          ECMAScript ``Number`` rendering that JCS mandates.

    The agent card is plain JSON (strings, numbers, bools, null, arrays,
    objects) so this covers every shape it contains.
    """
    return json.dumps(
        _jcs_normalize(value),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
        allow_nan=False,
    ).encode("utf-8")


def _jcs_normalize(value: Any) -> Any:
    """Recursively normalize numbers so JCS number rules hold."""
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        # RFC 8785 number serialization follows ECMAScript: an integral float
        # is emitted with no fractional part. json.dumps would print "2.0", so
        # collapse to int when it is exactly integral.
        if value.is_integer():
            return int(value)
        return value
    if isinstance(value, dict):
        return {k: _jcs_normalize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_jcs_normalize(v) for v in value]
    return value


# ---------------------------------------------------------------------------
# ES256 raw-signature <-> DER conversion
# ---------------------------------------------------------------------------
#
# ``cryptography`` produces/consumes ASN.1 DER ECDSA signatures, but JWS ES256
# (RFC 7518 §3.4) uses the fixed-length raw R||S concatenation (64 bytes for
# P-256). We convert at the boundary.

_P256_COORD_BYTES = 32


def _der_to_jose(der_sig: bytes) -> bytes:
    r, s = asym_utils.decode_dss_signature(der_sig)
    return r.to_bytes(_P256_COORD_BYTES, "big") + s.to_bytes(_P256_COORD_BYTES, "big")


def _jose_to_der(jose_sig: bytes) -> bytes:
    if len(jose_sig) != 2 * _P256_COORD_BYTES:
        raise ValueError(
            f"ES256 signature must be {2 * _P256_COORD_BYTES} bytes, got {len(jose_sig)}"
        )
    r = int.from_bytes(jose_sig[:_P256_COORD_BYTES], "big")
    s = int.from_bytes(jose_sig[_P256_COORD_BYTES:], "big")
    return asym_utils.encode_dss_signature(r, s)


# ---------------------------------------------------------------------------
# Key management
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SigningKey:
    """A loaded ECDSA P-256 signing key plus its publication metadata."""

    private_key: ec.EllipticCurvePrivateKey
    kid: str
    jku: str

    @property
    def public_key(self) -> ec.EllipticCurvePublicKey:
        return self.private_key.public_key()


def _load_private_key_from_pem(pem: bytes) -> ec.EllipticCurvePrivateKey:
    key = serialization.load_pem_private_key(pem, password=None)
    if not isinstance(key, ec.EllipticCurvePrivateKey):
        raise TypeError("agent-card signing key must be an EC (P-256) private key")
    if not isinstance(key.curve, ec.SECP256R1):
        raise TypeError(f"ES256 requires curve P-256/SECP256R1, got {key.curve.name}")
    return key


def generate_dev_key() -> ec.EllipticCurvePrivateKey:
    """Generate a fresh ECDSA P-256 keypair (dev / test use)."""
    return ec.generate_private_key(ec.SECP256R1())


def load_signing_key(
    *,
    kid: str | None = None,
    jku: str | None = None,
    create_dev_key_if_missing: bool = True,
) -> SigningKey:
    """Resolve the signing key, preferring the operator-provisioned prod key.

    Resolution order (honest dev-vs-prod split):

        1. ``AGENT_CARD_SIGNING_KEY_PEM``  — raw PEM (production, e.g. mounted
           from Secret Manager). Never written to disk by us.
        2. ``AGENT_CARD_SIGNING_KEY_FILE`` — path to a PEM on disk.
        3. The git-ignored dev key under ``deployment/keys/``. Generated on
           first use when ``create_dev_key_if_missing`` is set.
    """
    resolved_kid = kid or os.environ.get("AGENT_CARD_SIGNING_KID", DEFAULT_KID)
    resolved_jku = jku or os.environ.get("AGENT_CARD_JWKS_URL", DEFAULT_JKU)

    pem_env = os.environ.get("AGENT_CARD_SIGNING_KEY_PEM")
    if pem_env:
        key = _load_private_key_from_pem(pem_env.encode("utf-8"))
        # A production key is expected to carry a distinct kid; default to a
        # prod-flavored kid only when the caller/env didn't pin one.
        prod_kid = kid or os.environ.get("AGENT_CARD_SIGNING_KID", "ss-agent-card-prod")
        return SigningKey(private_key=key, kid=prod_kid, jku=resolved_jku)

    pem_file = os.environ.get("AGENT_CARD_SIGNING_KEY_FILE")
    if pem_file:
        key = _load_private_key_from_pem(Path(pem_file).read_bytes())
        return SigningKey(private_key=key, kid=resolved_kid, jku=resolved_jku)

    # Dev fallback.
    if _DEV_PRIVATE_KEY_PATH.exists():
        key = _load_private_key_from_pem(_DEV_PRIVATE_KEY_PATH.read_bytes())
        return SigningKey(private_key=key, kid=resolved_kid, jku=resolved_jku)

    if not create_dev_key_if_missing:
        raise FileNotFoundError(
            f"No signing key available (env unset and {_DEV_PRIVATE_KEY_PATH} missing)"
        )

    key = generate_dev_key()
    _KEY_DIR.mkdir(parents=True, exist_ok=True)
    _DEV_PRIVATE_KEY_PATH.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    # Owner-only — the dev key is throwaway but still a private key.
    os.chmod(_DEV_PRIVATE_KEY_PATH, 0o600)
    return SigningKey(private_key=key, kid=resolved_kid, jku=resolved_jku)


# ---------------------------------------------------------------------------
# JWK / JWKS (RFC 7517 / RFC 7518 §6.2)
# ---------------------------------------------------------------------------


def public_jwk(public_key: ec.EllipticCurvePublicKey, kid: str) -> dict[str, str]:
    """Render an EC P-256 public key as a JWK (RFC 7518 §6.2.1)."""
    numbers = public_key.public_numbers()
    x = numbers.x.to_bytes(_P256_COORD_BYTES, "big")
    y = numbers.y.to_bytes(_P256_COORD_BYTES, "big")
    return {
        "kty": "EC",
        "crv": "P-256",
        "x": b64url_encode(x),
        "y": b64url_encode(y),
        "kid": kid,
        "alg": JWS_ALG,
        "use": "sig",
    }


def build_jwks(keys: list[SigningKey]) -> dict[str, list[dict[str, str]]]:
    """Build a JWKS document publishing the public half of each key."""
    return {"keys": [public_jwk(k.public_key, k.kid) for k in keys]}


def public_key_from_jwk(jwk: dict[str, Any]) -> ec.EllipticCurvePublicKey:
    """Reconstruct an EC P-256 public key from a JWK (verification side)."""
    if jwk.get("kty") != "EC" or jwk.get("crv") != "P-256":
        raise ValueError("only EC/P-256 JWKs are supported for ES256")
    x = int.from_bytes(b64url_decode(jwk["x"]), "big")
    y = int.from_bytes(b64url_decode(jwk["y"]), "big")
    return ec.EllipticCurvePublicKey.from_encoded_point(
        ec.SECP256R1(),
        b"\x04" + x.to_bytes(_P256_COORD_BYTES, "big") + y.to_bytes(_P256_COORD_BYTES, "big"),
    )


# ---------------------------------------------------------------------------
# Sign / verify
# ---------------------------------------------------------------------------


def _card_without_signatures(card: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of the card with the ``signatures`` key removed."""
    return {k: v for k, v in card.items() if k != "signatures"}


def _signing_input(protected_b64: str, payload_b64: str) -> bytes:
    """RFC 7515 §5.1 JWS Signing Input: ASCII(protected '.' payload)."""
    return f"{protected_b64}.{payload_b64}".encode("ascii")


def make_signature_entry(card: dict[str, Any], key: SigningKey) -> dict[str, str]:
    """Produce one A2A ``AgentCardSignature`` entry over ``card``.

    The card is signed *without* its ``signatures`` key (RFC-7515-style,
    JCS-canonicalized payload). Returns ``{"protected", "signature"}``.
    """
    protected = {"alg": JWS_ALG, "kid": key.kid, "jku": key.jku}
    protected_b64 = b64url_encode(jcs_canonicalize(protected))
    payload_b64 = b64url_encode(jcs_canonicalize(_card_without_signatures(card)))

    signing_input = _signing_input(protected_b64, payload_b64)
    der_sig = key.private_key.sign(signing_input, ec.ECDSA(hashes.SHA256()))
    jose_sig = _der_to_jose(der_sig)

    return {"protected": protected_b64, "signature": b64url_encode(jose_sig)}


def sign_card(card: dict[str, Any], key: SigningKey) -> dict[str, Any]:
    """Return a copy of ``card`` with a fresh ``signatures[]`` entry appended.

    Existing signatures (e.g. from a previous signer) are discarded so the
    output carries exactly the signature we just produced — re-running the
    signer is idempotent in shape.
    """
    signed = _card_without_signatures(card)
    signed["signatures"] = [make_signature_entry(card, key)]
    return signed


def verify_signature_entry(
    card: dict[str, Any],
    entry: dict[str, Any],
    public_key: ec.EllipticCurvePublicKey,
) -> bool:
    """Verify one ``signatures[]`` entry against ``public_key``.

    Re-canonicalizes the served card (signatures stripped), rebuilds the JWS
    Signing Input from the entry's ``protected`` header, and checks the
    signature. Returns ``True`` on success, ``False`` on any mismatch/tamper.
    """
    try:
        protected_b64 = entry["protected"]
        sig_b64 = entry["signature"]
        protected = json.loads(b64url_decode(protected_b64))
        if protected.get("alg") != JWS_ALG:
            return False

        payload_b64 = b64url_encode(jcs_canonicalize(_card_without_signatures(card)))
        signing_input = _signing_input(protected_b64, payload_b64)
        der_sig = _jose_to_der(b64url_decode(sig_b64))
        public_key.verify(der_sig, signing_input, ec.ECDSA(hashes.SHA256()))
        return True
    except (InvalidSignature, ValueError, KeyError, TypeError):
        return False


def verify_card_with_jwks(card: dict[str, Any], jwks: dict[str, Any]) -> bool:
    """Verify a signed card against a JWKS document.

    Returns ``True`` iff at least one ``signatures[]`` entry verifies against a
    JWKS key whose ``kid`` matches the entry's protected header (falling back
    to trying every key if the entry omits ``kid``).
    """
    signatures = card.get("signatures") or []
    if not signatures:
        return False
    jwks_by_kid = {jwk.get("kid"): jwk for jwk in jwks.get("keys", [])}
    for entry in signatures:
        try:
            protected = json.loads(b64url_decode(entry["protected"]))
        except (KeyError, ValueError, TypeError):
            continue
        kid = protected.get("kid")
        candidates = (
            [jwks_by_kid[kid]] if kid in jwks_by_kid else list(jwks.get("keys", []))
        )
        for jwk in candidates:
            try:
                pub = public_key_from_jwk(jwk)
            except (ValueError, KeyError):
                continue
            if verify_signature_entry(card, entry, pub):
                return True
    return False
