from __future__ import annotations

import hashlib
import hmac

import pytest

from mitra import WebhookVerificationError, verify_webhook

SECRET = "whsec_test"
BODY = b'{"event":"job.completed","job_id":"j1"}'


def sign(body: bytes, t: int, secret: str = SECRET) -> str:
    digest = hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    return f"t={t},v1={digest}"


def test_valid_signature():
    assert verify_webhook(SECRET, sign(BODY, 1_000), BODY, now=1_100) is True


def test_str_body_accepted():
    assert verify_webhook(SECRET, sign(BODY, 1_000), BODY.decode(), now=1_000)


def test_wrong_secret():
    with pytest.raises(WebhookVerificationError):
        verify_webhook("other", sign(BODY, 1_000), BODY, now=1_000)


def test_tampered_body():
    with pytest.raises(WebhookVerificationError):
        verify_webhook(SECRET, sign(BODY, 1_000), BODY + b" ", now=1_000)


def test_stale_timestamp():
    with pytest.raises(WebhookVerificationError):
        verify_webhook(SECRET, sign(BODY, 1_000), BODY, tolerance_sec=300, now=1_400)


def test_missing_or_malformed_header():
    for header in (None, "", "garbage", "t=abc,v1=00", "v1=00"):
        with pytest.raises(WebhookVerificationError):
            verify_webhook(SECRET, header, BODY, now=1_000)


def test_multiple_v1_signatures_any_match():
    good = sign(BODY, 1_000)
    header = good + ",v1=" + "0" * 64
    assert verify_webhook(SECRET, header, BODY, now=1_000)
