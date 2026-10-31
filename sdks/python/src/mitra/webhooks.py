"""Webhook signature verification."""

from __future__ import annotations

import hashlib
import hmac
import time

from .errors import WebhookVerificationError


def assert_webhook(
    secret: str,
    header: str | None,
    body: bytes | str,
    tolerance_sec: int = 300,
    *,
    now: float | None = None,
) -> bool:
    """Raise :class:`WebhookVerificationError` unless the signature is valid; returns ``True`` if it is.

    Verify a ``Matih-Signature`` header against the raw request body.

    The header looks like ``t=<unix>,v1=<hex>`` where ``v1`` is the HMAC-SHA256 of
    ``"<t>.<body>"`` keyed with the webhook secret. Pass the **raw** body bytes exactly as
    received, not re-serialised JSON.

    Raises when the header is missing, malformed, outside ``tolerance_sec`` of now, or does not
    match. The comparison is constant-time.
    """
    if not header:
        raise WebhookVerificationError("missing Matih-Signature header")
    timestamp: str | None = None
    signatures: list[str] = []
    for part in header.split(","):
        key, _, value = part.strip().partition("=")
        if key == "t":
            timestamp = value
        elif key == "v1":
            signatures.append(value)
    if timestamp is None or not signatures:
        raise WebhookVerificationError("malformed Matih-Signature header")
    try:
        sent_at = int(timestamp)
    except ValueError as exc:
        raise WebhookVerificationError("malformed timestamp in Matih-Signature") from exc
    current = time.time() if now is None else now
    if tolerance_sec and abs(current - sent_at) > tolerance_sec:
        raise WebhookVerificationError("signature timestamp outside the tolerance window")
    raw = body.encode() if isinstance(body, str) else body
    expected = hmac.new(
        secret.encode(), timestamp.encode() + b"." + raw, hashlib.sha256
    ).hexdigest()
    if not any(hmac.compare_digest(expected, sig) for sig in signatures):
        raise WebhookVerificationError("signature does not match")
    return True


def verify_webhook(
    secret: str,
    header: str | None,
    body: bytes | str,
    tolerance_sec: int = 300,
    *,
    now: float | None = None,
) -> bool:
    """Like :func:`assert_webhook` but returns ``False`` instead of raising (matches the
    TypeScript ``verifyWebhook``)."""
    try:
        return assert_webhook(secret, header, body, tolerance_sec, now=now)
    except WebhookVerificationError:
        return False
