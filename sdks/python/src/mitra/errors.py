"""Typed errors raised by the Matih client."""

from __future__ import annotations

from typing import Any


class MitraError(Exception):
    """An error response from the Matih API (or a client-side failure).

    Attributes:
        message: Human-readable message from the API.
        status: HTTP status code, when the error came from a response.
        category: API error category, for example ``scope`` or ``credits``.
        code: Optional machine-readable code.
        request_id: Value of the ``x-request-id`` response header, quote it in support requests.
        body: The decoded response body, if any.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        category: str | None = None,
        code: str | None = None,
        request_id: str | None = None,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.category = category
        self.code = code
        self.request_id = request_id
        self.body = body

    def __str__(self) -> str:
        parts = [self.message]
        extra = [
            f"status={self.status}" if self.status is not None else "",
            f"category={self.category}" if self.category else "",
            f"request_id={self.request_id}" if self.request_id else "",
        ]
        extra = [p for p in extra if p]
        if extra:
            parts.append("(" + ", ".join(extra) + ")")
        return " ".join(parts)


class AuthError(MitraError):
    """401: missing, invalid or expired credential."""


class PermissionDeniedError(MitraError):
    """403: category ``scope``, ``workspace_role`` or ``source_access``."""


class CreditsError(MitraError):
    """402: category ``credits`` or ``member_cap``."""


class BusyError(MitraError):
    """409: category ``busy``. Another request is running; retry shortly."""


class RateLimitError(MitraError):
    """429: slow down. ``retry_after`` is the number of seconds to wait, if the server said."""

    def __init__(self, message: str, *, retry_after: float | None = None, **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        self.retry_after = retry_after


class JobFailedError(MitraError):
    """A background job finished in state ``failed`` or ``cancelled``."""

    def __init__(self, message: str, *, job: Any = None, **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        self.job = job


class JobTimeoutError(MitraError):
    """``jobs.wait`` gave up before the job reached a terminal state. The job keeps running."""

    def __init__(self, message: str, *, job: Any = None, **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        self.job = job


class WebhookVerificationError(ValueError):
    """The ``Matih-Signature`` header is missing, malformed, stale or does not match."""


_STATUS_CLASSES: dict[int, type[MitraError]] = {
    401: AuthError,
    402: CreditsError,
    403: PermissionDeniedError,
    409: BusyError,
}


def error_from_response(
    status: int,
    body: Any,
    *,
    request_id: str | None = None,
    retry_after: float | None = None,
) -> MitraError:
    """Build the right exception for an error response body."""
    detail = body.get("detail") if isinstance(body, dict) else None
    category = code = None
    if isinstance(detail, dict):
        message = str(detail.get("message") or f"HTTP {status}")
        category = detail.get("category")
        code = detail.get("code")
    elif isinstance(detail, str):
        message = detail
    else:
        message = f"HTTP {status}"
    kwargs: dict[str, Any] = {
        "status": status,
        "category": category,
        "code": code,
        "request_id": request_id,
        "body": body,
    }
    if status == 429:
        return RateLimitError(message, retry_after=retry_after, **kwargs)
    return _STATUS_CLASSES.get(status, MitraError)(message, **kwargs)
