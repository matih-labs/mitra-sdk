"""Python client for the Matih public API."""

from ._version import __version__
from .client import AsyncMitra, Mitra
from .errors import (
    AuthError,
    BusyError,
    CreditsError,
    JobFailedError,
    JobTimeoutError,
    MitraError,
    PermissionDeniedError,
    RateLimitError,
    WebhookVerificationError,
)
from .models import (
    Answer,
    Clarification,
    Dashboard,
    File,
    Gem,
    GemList,
    Job,
    ResultTable,
    Source,
    StreamEvent,
    Webhook,
    Workspace,
    WorkspaceList,
)
from .webhooks import verify_webhook

__all__ = [
    "Answer",
    "AsyncMitra",
    "AuthError",
    "BusyError",
    "Clarification",
    "CreditsError",
    "Dashboard",
    "File",
    "Gem",
    "GemList",
    "Job",
    "JobFailedError",
    "JobTimeoutError",
    "Mitra",
    "MitraError",
    "PermissionDeniedError",
    "RateLimitError",
    "ResultTable",
    "Source",
    "StreamEvent",
    "Webhook",
    "WebhookVerificationError",
    "Workspace",
    "WorkspaceList",
    "__version__",
    "verify_webhook",
]
