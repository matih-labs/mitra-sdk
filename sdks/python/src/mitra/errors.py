"""Typed errors raised by the Matih client."""

from __future__ import annotations

from typing import Any


class MitraError(Exception):
    """An error response from the Matih API (or a client-side failure).

    Attributes:
        message: Human-readable message from the API.
        status: HTTP status code, when the error came from a response.
        category: API error category, for example ``scope``, ``not_ready`` or ``rate_limited``.
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
    """403: category ``scope``, ``workspace_role``, ``workspace`` or ``source_access``."""


class CreditsError(MitraError):
    """402: category ``not_ready`` (the workspace has no credits left) or ``member_cap``."""


class BusyError(MitraError):
    """409: a conflict with the current state: revoking an invitation that is no longer open,
    answering a file that is not waiting for a decision, or a workspace already at its 20
    webhooks. Read ``category``, ``code`` and ``message``."""


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


class SourceTestFailedError(MitraError):
    """422 from ``sources.create``: the connection test failed and nothing was saved.
    ``test_result`` is the server's ``detail.test`` (``ok``, ``message``, ``error_category``,
    ``field``, ...), or None."""

    def __init__(self, message: str, *, test_result: Any = None, **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        self.test_result = test_result


EMBED_REFUSAL_CODES = (
    "missing_parameter",
    "unknown_parameter",
    "invalid_value",
    "invalid_origin",
    "filters_not_supported",
    "no_embed_parameters",
)


class EmbedRefusedError(MitraError):
    """422 from ``embeds.create``: the server refused the request and nothing was minted.

    ``code`` says why (``EMBED_REFUSAL_CODES``):

    - ``missing_parameter``: ``filters`` lacks a parameter the dashboard declares
    - ``unknown_parameter``: ``filters`` has a name the dashboard does not declare
    - ``invalid_value``: a filter value is not a valid value for its declared type
    - ``invalid_origin``: an origin is not an exact ``scheme://host[:port]`` (https only,
      except ``http://localhost`` and ``http://127.0.0.1``; no paths, wildcards or ``null``)
    - ``filters_not_supported``: filters sent for a Gems embed (Gems cannot be filtered)
    - ``no_embed_parameters``: filters sent for a dashboard that declares no embed parameters

    Other 422 codes the server may add are passed through in ``code`` unchanged.
    """


class EmbedNotFoundError(MitraError):
    """404 from ``embeds.create`` or ``embeds.revoke``: the dashboard or source does not exist
    or the key's member cannot read it, or (revoke) the token id is not one of this key's."""


class WebhookVerificationError(ValueError):
    """The ``Matih-Signature`` header is missing, malformed, stale or does not match."""


_STATUS_CLASSES: dict[int, type[MitraError]] = {
    401: AuthError,
    402: CreditsError,
    403: PermissionDeniedError,
    409: BusyError,
}


def _is_embeds_path(path: str | None) -> bool:
    """True for ``.../embeds`` and ``.../embeds/{id}``."""
    if not path:
        return False
    # ``path`` is the decoded request path, so an id holding a "/" adds segments: look for the
    # resource segment anywhere rather than at a fixed offset.
    return "embeds" in path.strip("/").split("/")


def _validation_message(detail: Any) -> str | None:
    """Flatten a FastAPI validation list (``detail`` is a list of ``{loc, msg}``)."""
    if not isinstance(detail, list) or not detail:
        return None
    parts = []
    for item in detail:
        if not isinstance(item, dict):
            parts.append(str(item))
            continue
        loc = ".".join(str(p) for p in item.get("loc", []) if p != "body")
        msg = str(item.get("msg") or "invalid")
        parts.append(f"{loc}: {msg}" if loc else msg)
    return "; ".join(parts)


def error_from_response(
    status: int,
    body: Any,
    *,
    request_id: str | None = None,
    retry_after: float | None = None,
    method: str | None = None,
    path: str | None = None,
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
    if (
        status == 422
        and isinstance(detail, dict)
        and method == "POST"
        and path
        and path.rstrip("/").endswith("/sources")
    ):
        test_result = detail.get("test") if isinstance(detail, dict) else None
        return SourceTestFailedError(message, test_result=test_result, **kwargs)
    if _is_embeds_path(path):
        if status == 422:
            # The code lives in the envelope's ``detail.code``; a top-level ``code`` is accepted too.
            if kwargs["code"] is None and isinstance(body, dict) and isinstance(body.get("code"), str):
                kwargs["code"] = body["code"]
            if kwargs["category"] is None:
                kwargs["category"] = "validation"
            flat = _validation_message(detail)
            return EmbedRefusedError(flat or message, **kwargs)
        if status == 404:
            return EmbedNotFoundError(message, **kwargs)
    if status == 429:
        return RateLimitError(message, retry_after=retry_after, **kwargs)
    return _STATUS_CLASSES.get(status, MitraError)(message, **kwargs)
