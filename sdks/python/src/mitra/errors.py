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
        extra: Every other field of the error (``detail`` or top-level body), for example the
            ``pending_id``, ``choices``, ``rows`` and ``credits`` of a ``409 HEAVY_CONFIRM``, or the
            ``conversation_id`` of a refused change call. Empty when there are none.
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
        extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.category = category
        self.code = code
        self.request_id = request_id
        self.body = body
        self.extra: dict[str, Any] = extra or {}

    @property
    def pending_id(self) -> str | None:
        """The held change a refused change call names (``409 HEAVY_CONFIRM``): confirm or cancel it with this."""
        value = self.extra.get("pending_id")
        return value if isinstance(value, str) else None

    @property
    def choices(self) -> list[Any]:
        """The numbered ``choices`` a refused change call lists, if any."""
        value = self.extra.get("choices")
        return value if isinstance(value, list) else []

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
    """Build the right exception for an error response body.

    One reader for both shapes the API answers with: the FastAPI envelope ``{"detail": {category, message,
    code?}}`` (``detail`` may also be a string or a validation list), and the top-level
    ``{code, message, ...}`` body the ``/changes`` routes answer with (``409 HEAVY_CONFIRM`` with its
    ``pending_id``, ``410 ALREADY_UNDONE``, ...). Where both are present the envelope wins. Whatever else
    the body carries is kept in ``extra``."""
    detail = body.get("detail") if isinstance(body, dict) else None
    # The fields are the top-level body (a /changes reply) with the envelope's own laid over it, so a code
    # beside a string ``detail`` is read too.
    top = {k: v for k, v in body.items() if k != "detail"} if isinstance(body, dict) else {}
    fields = {**top, **(detail if isinstance(detail, dict) else {})}
    if isinstance(detail, str):
        message = detail
    elif isinstance(fields.get("message"), str) and fields["message"]:
        message = fields["message"]
    else:
        message = f"HTTP {status}"
    category = fields.get("category")
    code = fields.get("code")
    kwargs: dict[str, Any] = {
        "status": status,
        "category": category if isinstance(category, str) else None,
        "code": code if isinstance(code, str) else None,
        "request_id": request_id,
        "body": body,
        "extra": {k: v for k, v in fields.items() if k not in ("message", "category", "code")},
    }
    if (
        status == 422
        and isinstance(detail, dict)
        and method == "POST"
        and path
        and path.rstrip("/").endswith("/sources")
    ):
        return SourceTestFailedError(message, test_result=detail.get("test"), **kwargs)
    if _is_embeds_path(path):
        if status == 422:
            if kwargs["category"] is None:
                kwargs["category"] = "validation"
            flat = _validation_message(detail)
            return EmbedRefusedError(flat or message, **kwargs)
        if status == 404:
            return EmbedNotFoundError(message, **kwargs)
    if status == 429:
        return RateLimitError(message, retry_after=retry_after, **kwargs)
    return _STATUS_CLASSES.get(status, MitraError)(message, **kwargs)
