"""Sync and async clients for the Matih public API."""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import AsyncIterator, Callable, Iterator
from typing import Any, BinaryIO
from urllib.parse import urljoin

import httpx

from . import _core
from .errors import JobFailedError, JobTimeoutError, MitraError
from .models import (
    Answer,
    ConnectorList,
    Conversation,
    ConversationList,
    Dashboard,
    DashboardList,
    DuplicateChoice,
    File,
    FileList,
    GemList,
    GivableRole,
    Invitation,
    InvitationList,
    InvitationRevoked,
    Job,
    Member,
    MemberList,
    MemberRemoved,
    OnDuplicate,
    Source,
    SourceCreated,
    SourceDeleted,
    SourceList,
    SourceTest,
    StreamEvent,
    Webhook,
    WebhookDeliveryList,
    WebhookEvent,
    WebhookList,
    WebhookTestResult,
    WorkspaceChosen,
    WorkspaceList,
)
from .models import Gem as GemModel

# Per-call options accepted by every method as keyword arguments:
#   workspace_id=..., language=..., idempotency_key=...
_Opts = Any

DEFAULT_JOB_TIMEOUT = 1860.0  # a little over the 30 minute maximum for predictions


def _as_job(payload: Any) -> Job:
    return Job.model_validate(payload)


def _file_part(
    file: str | os.PathLike[str] | bytes | BinaryIO,
    filename: str | None,
    content_type: str | None,
) -> tuple[str, Any, str | None]:
    """Return an httpx multipart tuple. Paths are read fully so retries can resend them."""
    if isinstance(file, (str, os.PathLike)):
        with open(file, "rb") as handle:
            content = handle.read()
        name = filename or os.path.basename(os.fspath(file))
    elif isinstance(file, bytes):
        content, name = file, filename or "upload"
    else:
        content, name = file.read(), filename or getattr(file, "name", "upload")
        name = os.path.basename(str(name))
    return name, content, content_type


def _audio_fields(
    conversation_id: str | None, source_id: str | None, language: str | None
) -> dict[str, str]:
    fields = {"conversation_id": conversation_id, "source_id": source_id, "language": language}
    return {k: v for k, v in fields.items() if v}


# kind -> (cap on the Prefer wait value the server honours, default total wait in seconds).
# Jobs (gems, dashboard, prediction) honour wait up to 60; sources and files up to 120.
_WAIT_LIMITS = {
    "gems": (60, 600.0),
    "dashboard": (60, 300.0),
    "prediction": (60, DEFAULT_JOB_TIMEOUT),
    "source": (120, 300.0),
    "file": (120, 300.0),
}


def _long_plan(kind: str, wait: float | None, background: bool) -> tuple[str | None, float]:
    """Return the ``Prefer`` header value and the total seconds the SDK may block."""
    cap, default = _WAIT_LIMITS[kind]
    timeout = float(default if wait is None else wait)
    prefer = None if background else f"wait={max(0, min(int(timeout), cap))}"
    return prefer, timeout


def timeout_for(prefer: str | None) -> float:
    """Seconds an HTTP attempt must be allowed so a server-side ``wait=N`` can finish first."""
    if prefer and prefer.startswith("wait="):
        return int(prefer[5:]) + 15.0
    return 0.0


# (first, longest) seconds between polls of a source or file that is still being read
_RESOURCE_POLL = (2.0, 10.0)


def _job_opts(opts: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in opts.items() if k in ("workspace_id", "language")}


def _ask_result(status: int, payload: Any) -> Answer | Job:
    """``ask`` returns an Answer (200), or a Job (202) when ``Prefer: respond-async`` was honoured."""
    if status == 202:
        return Job.model_validate(payload)
    return Answer.model_validate(payload)


def _poll_delays(interval: float, max_interval: float) -> Iterator[float]:
    delay = interval
    while True:
        yield delay
        delay = min(delay * 1.5, max_interval)


def _check_terminal(job: Job) -> Job:
    if job.state == "succeeded":
        return job
    message = (job.error.message if job.error else None) or f"job {job.id} {job.state}"
    raise JobFailedError(
        message,
        job=job,
        category=(job.error.category if job.error else None) or job.state,
    )


class _Resources:
    """Endpoint methods, written once. Each returns ``core.request(...)``: a value on the
    sync client and an awaitable on the async client."""

    def __init__(self, core: Any) -> None:
        self._c = core


class _Workspaces(_Resources):
    def list(self, **opts: _Opts) -> Any:
        """The workspaces you belong to, which one is ``current``, and open invitations for you."""
        return self._c.request("GET", "/workspaces", parse=WorkspaceList.model_validate, **opts)

    def use(self, workspace_id: str, **opts: _Opts) -> Any:
        """Set the default workspace for the credential (``PUT /me/workspace``).

        OAuth tokens only: an API key is pinned to one workspace. Per call you can also pass
        ``workspace_id=`` (sent as ``X-Matih-Workspace``)."""
        return self._c.request(
            "PUT", "/me/workspace", json_body={"workspace_id": workspace_id},
            parse=WorkspaceChosen.model_validate, **opts,
        )


class _Members(_Resources):
    """Needs ``members:read`` (list) or ``members:manage`` (change role, remove)."""

    def list(self, **opts: _Opts) -> Any:
        return self._c.request("GET", "/members", parse=MemberList.model_validate, **opts)

    def update(self, member_id: str, role: GivableRole, **opts: _Opts) -> Any:
        """Make a member ``admin``, ``user`` or ``viewer``. Nobody can be made ``owner`` here."""
        return self._c.request(
            "PATCH", f"/members/{member_id}", json_body={"role": role},
            parse=Member.model_validate, **opts,
        )

    def remove(self, member_id: str, **opts: _Opts) -> Any:
        return self._c.request(
            "DELETE", f"/members/{member_id}", parse=MemberRemoved.model_validate, **opts
        )


class _Invitations(_Resources):
    def create(
        self,
        role: GivableRole = "user",
        *,
        email: str | None = None,
        phone: str | None = None,
        whatsapp_only: bool = False,
        **opts: _Opts,
    ) -> Any:
        """Invite by ``email`` or ``phone`` (exactly one; ``members:manage``).

        ``role`` is ``admin``, ``user`` (default) or ``viewer``, never ``owner``. A phone
        invitation goes out on WhatsApp; if it cannot be delivered the result carries a
        ``join_code`` (shown once). ``whatsapp_only=True`` lets the person use the workspace on
        WhatsApp only."""
        if bool(email) == bool(phone):
            raise ValueError("pass exactly one of email= or phone=")
        body: dict[str, Any] = {"role": role, **({"email": email} if email else {"phone": phone})}
        if whatsapp_only:
            body["whatsapp_only"] = True
        return self._c.request(
            "POST", "/invitations", json_body=body, parse=Invitation.model_validate, **opts
        )

    def list(self, **opts: _Opts) -> Any:
        return self._c.request("GET", "/invitations", parse=InvitationList.model_validate, **opts)

    def revoke(self, invitation_id: str, **opts: _Opts) -> Any:
        """Withdraw an open invitation. One already accepted, declined or revoked answers 409."""
        return self._c.request(
            "DELETE", f"/invitations/{invitation_id}",
            parse=InvitationRevoked.model_validate, **opts,
        )


class _Connectors(_Resources):
    def list(self, **opts: _Opts) -> Any:
        """The connector types you can use in ``sources.create`` and the fields each takes."""
        return self._c.request("GET", "/connectors", parse=ConnectorList.model_validate, **opts)


def _source_ready(created: SourceCreated) -> bool:
    readiness = created.source.readiness if created.source else None
    return readiness is None or readiness.can_ask or readiness.phase == "not_connected"


class _Sources(_Resources):
    def list(self, **opts: _Opts) -> Any:
        return self._c.request("GET", "/sources", parse=SourceList.model_validate, **opts)

    def get(self, source_id: str, **opts: _Opts) -> Any:
        """One source, including its ``readiness`` (``can_ask`` is true once Ask can use it)."""
        return self._c.request(
            "GET", f"/sources/{source_id}", parse=Source.model_validate, **opts
        )

    def test(self, config: dict[str, Any], **opts: _Opts) -> Any:
        """Try a connection without saving anything."""
        return self._c.request(
            "POST", "/sources/test", json_body={"config": config},
            parse=SourceTest.model_validate, **opts,
        )

    def create(
        self,
        config: dict[str, Any],
        *,
        activate: bool = True,
        wait: float | None = None,
        background: bool = False,
        **opts: _Opts,
    ) -> Any:
        """Connect a source (admin, ``sources:write``). Returns :class:`SourceCreated`.

        The server tests the connection, saves the source (201) and then reads its tables in the
        background. By default this call waits (up to ``wait`` seconds, default 300) until
        ``source.readiness.can_ask`` is true: the first request carries ``Prefer: wait=N`` (N at
        most 120) and the rest is polling ``sources.get``. If it is not ready by then the source
        comes back as it stands (``phase: building``); nothing is raised, check
        ``created.source.readiness.can_ask``. ``background=True`` returns right after the save.

        A failed connection test raises :class:`SourceTestFailedError` (HTTP 422, ``.test_result``)
        and saves nothing."""
        return self._c.settle(
            "POST", "/sources", kind="source", wait=wait, background=background,
            parse=SourceCreated.model_validate, is_done=_source_ready,
            poll=lambda created: (
                f"/sources/{created.source.id}" if created.source else None,
                Source.model_validate,
                lambda current, source: current.model_copy(update={"source": source}),
            ),
            json_body={"config": config, "activate": activate}, **opts,
        )

    def activate(self, source_id: str, **opts: _Opts) -> Any:
        """Make a source the one Ask and Gems use when a request names none."""
        return self._c.request(
            "POST", f"/sources/{source_id}/activate", parse=Source.model_validate, **opts
        )

    def delete(self, source_id: str, **opts: _Opts) -> Any:
        return self._c.request(
            "DELETE", f"/sources/{source_id}", parse=SourceDeleted.model_validate, **opts
        )

    def connectors(self, **opts: _Opts) -> Any:
        """Same as ``client.connectors.list()``."""
        return self._c.request("GET", "/connectors", parse=ConnectorList.model_validate, **opts)


class _Files(_Resources):
    def upload(
        self,
        file: str | os.PathLike[str] | bytes | BinaryIO,
        *,
        filename: str | None = None,
        content_type: str | None = None,
        on_duplicate: OnDuplicate | None = None,
        wait: float | None = None,
        background: bool = False,
        **opts: _Opts,
    ) -> Any:
        """Upload a CSV, Parquet, JSON or Excel file (``files:write``). Returns a :class:`File`.

        The server stores the file (201, ``status: processing``) and reads it in the background.
        By default this call waits (up to ``wait`` seconds, default 300) until the file is
        settled: ``ready``, ``failed``, ``needs_attention`` or waiting for a decision. The first
        request carries ``Prefer: wait=N`` (N at most 120) and the rest is polling ``files.get``.
        On timeout the file comes back as it stands; nothing is raised. ``background=True``
        returns right after the upload.

        ``on_duplicate`` is ``"ask"`` (default: an identical file waits for ``files.duplicate``,
        see ``file.decision_required``) or ``"keep_both"``."""
        part = _file_part(file, filename, content_type)
        return self._c.settle(
            "POST", "/files", kind="file", wait=wait, background=background,
            parse=File.model_validate, is_done=lambda f: f.is_settled,
            poll=lambda f: (f"/files/{f.id}", File.model_validate, lambda _current, polled: polled),
            files={"file": part},
            data={"on_duplicate": on_duplicate} if on_duplicate else None, **opts,
        )

    def list(self, **opts: _Opts) -> Any:
        return self._c.request("GET", "/files", parse=FileList.model_validate, **opts)

    def get(self, file_id: str, **opts: _Opts) -> Any:
        """Status, analysis state and ``decision_required`` for one file."""
        return self._c.request("GET", f"/files/{file_id}", parse=File.model_validate, **opts)

    def duplicate(self, file_id: str, decision: DuplicateChoice, **opts: _Opts) -> Any:
        """Answer ``decision_required: duplicate``: ``use_existing``, ``keep_both`` or ``cancel``."""
        return self._c.request(
            "POST", f"/files/{file_id}/duplicate", json_body={"decision": decision},
            parse=File.model_validate, **opts,
        )

    def delete(self, file_id: str, **opts: _Opts) -> Any:
        """Delete a file; returns it with ``status: deleting``."""
        return self._c.request("DELETE", f"/files/{file_id}", parse=File.model_validate, **opts)


class _Gems(_Resources):
    def list(self, source_id: str | None = None, **opts: _Opts) -> Any:
        """The Gems prepared for a source (default: the active one). ``state`` is ``none`` until
        you call ``generate``. Text follows ``language=`` / ``Accept-Language``."""
        return self._c.request(
            "GET", "/gems", params={"source_id": source_id}, parse=GemList.model_validate, **opts
        )

    def generate(
        self,
        source_id: str | None = None,
        *,
        wait: float | None = None,
        background: bool = False,
        **opts: _Opts,
    ) -> Any:
        """Prepare Gems (metered). Returns the finished :class:`Job`.

        The server answers 202 and a Job; this call sends ``Prefer: wait=N`` (N at most 60) and
        polls the job until it ends or ``wait`` seconds (default 600) pass, then raises
        :class:`JobTimeoutError` (the job keeps running). ``background=True`` returns the queued
        Job at once; use ``jobs.wait`` or the ``gems.ready`` webhook. ``source_id`` defaults to
        the active source."""
        return self._c.long(
            "POST", "/gems/generate", kind="gems", wait=wait, background=background,
            json_body={"source_id": source_id} if source_id else None, **opts,
        )

    def get(self, gem_id: str, source_id: str | None = None, **opts: _Opts) -> Any:
        return self._c.request(
            "GET", f"/gems/{gem_id}", params={"source_id": source_id},
            parse=GemModel.model_validate, **opts,
        )

    def image(self, gem_id: str, source_id: str | None = None, **opts: _Opts) -> Any:
        """PNG bytes of a Gem's chart (404 when a Gem has nothing worth drawing)."""
        return self._c.request(
            "GET", f"/gems/{gem_id}/image.png", params={"source_id": source_id}, raw=True,
            accept="image/png", **opts,
        )


class _Dashboards(_Resources):
    def list(self, **opts: _Opts) -> Any:
        return self._c.request("GET", "/dashboards", parse=DashboardList.model_validate, **opts)

    def get(self, dashboard_id: str, **opts: _Opts) -> Any:
        return self._c.request(
            "GET", f"/dashboards/{dashboard_id}", parse=Dashboard.model_validate, **opts
        )

    def image(
        self,
        dashboard_id: str,
        *,
        width: int | None = None,
        wait: float | None = None,
        background: bool = False,
        **opts: _Opts,
    ) -> Any:
        """Draw a dashboard as an image. Returns the finished :class:`Job`; its ``result`` is
        ``{image_url, width, height}`` (``width`` 400 to 3200, default 1600).

        The server answers 202 and a Job; this call sends ``Prefer: wait=N`` (N at most 60) and
        polls until the job ends or ``wait`` seconds (default 300) pass. ``background=True``
        returns the Job at once. See ``image_bytes`` and ``render`` for PNG bytes."""
        return self._c.long(
            "POST", f"/dashboards/{dashboard_id}/image", kind="dashboard", wait=wait,
            background=background, json_body={"width": width} if width else None, **opts,
        )


class _Predictions(_Resources):
    def create(
        self,
        question: str,
        *,
        source_id: str | None = None,
        conversation_id: str | None = None,
        language: str | None = None,
        wait: float | None = None,
        background: bool = False,
        **opts: _Opts,
    ) -> Any:
        """Run a forecast or what-if (can take up to 30 minutes). Returns the finished :class:`Job`;
        its ``result`` is ``{conversation_id, answer}``.

        The server answers 202 and a Job; this call sends ``Prefer: wait=N`` (N at most 60) and
        polls until the job ends or ``wait`` seconds (default 1860) pass. ``background=True``
        returns the queued Job at once so you can poll with ``jobs.wait`` or wait for the
        ``prediction.completed`` webhook."""
        body = {
            "question": question, "source_id": source_id,
            "conversation_id": conversation_id, "language": language,
        }
        return self._c.long(
            "POST", "/predictions", kind="prediction", wait=wait, background=background,
            json_body={k: v for k, v in body.items() if v is not None},
            idempotent=True, **opts,
        )


class _Webhooks(_Resources):
    def list(self, **opts: _Opts) -> Any:
        return self._c.request("GET", "/webhooks", parse=WebhookList.model_validate, **opts)

    def create(self, url: str, events: list[WebhookEvent] | list[str], **opts: _Opts) -> Any:
        """Register a webhook (``webhooks:manage``). The returned ``secret`` (``whsec_...``) is
        shown once; store it. ``events`` are ``gems.ready``, ``prediction.completed``,
        ``job.completed`` and ``dashboard_image.ready``."""
        return self._c.request(
            "POST", "/webhooks", json_body={"url": url, "events": list(events)},
            parse=Webhook.model_validate, **opts,
        )

    def delete(self, webhook_id: str, **opts: _Opts) -> Any:
        """Delete a webhook. Returns None (HTTP 204)."""
        return self._c.request("DELETE", f"/webhooks/{webhook_id}", **opts)

    def test(self, webhook_id: str, **opts: _Opts) -> Any:
        """Send a test event to the webhook URL."""
        return self._c.request(
            "POST", f"/webhooks/{webhook_id}/test", parse=WebhookTestResult.model_validate, **opts
        )

    def deliveries(self, webhook_id: str, **opts: _Opts) -> Any:
        """The 50 most recent deliveries."""
        return self._c.request(
            "GET", f"/webhooks/{webhook_id}/deliveries",
            parse=WebhookDeliveryList.model_validate, **opts,
        )


class _Conversations(_Resources):
    def list(self, **opts: _Opts) -> Any:
        return self._c.request(
            "GET", "/conversations", parse=ConversationList.model_validate, **opts
        )

    def get(self, conversation_id: str, **opts: _Opts) -> Any:
        """One conversation with its messages, oldest first."""
        return self._c.request(
            "GET", f"/conversations/{conversation_id}", parse=Conversation.model_validate, **opts
        )


class _JobsBase(_Resources):
    def get(self, job_id: str, **opts: _Opts) -> Any:
        return self._c.request("GET", f"/jobs/{job_id}", parse=_as_job, **opts)

    def cancel(self, job_id: str, **opts: _Opts) -> Any:
        return self._c.request("POST", f"/jobs/{job_id}/cancel", parse=_as_job, **opts)


def _ask_body(
    question: str,
    conversation_id: str | None,
    source_id: str | None,
    language: str | None,
    stream: bool,
) -> dict[str, Any]:
    body: dict[str, Any] = {"question": question}
    if conversation_id:
        body["conversation_id"] = conversation_id
    if source_id:
        body["source_id"] = source_id
    if language:
        body["language"] = language
    if stream:
        body["stream"] = True
    return body


# --------------------------------------------------------------------------- sync


class _SyncCore:
    def __init__(self, settings: _core.Settings, http: httpx.Client) -> None:
        self.settings = settings
        self.http = http

    def request(
        self,
        method: str,
        path: str,
        *,
        parse: Callable[[Any], Any] | None = None,
        raw: bool = False,
        with_status: bool = False,
        full: bool = False,
        request_timeout: float | None = None,
        **prep: Any,
    ) -> Any:
        kwargs = _core.prepare(self.settings, method, path, **prep)
        timeout = request_timeout or self.settings.timeout
        attempt = 0
        while True:
            response: httpx.Response | None = None
            try:
                response = self.http.request(**kwargs, timeout=timeout)
            except httpx.TransportError as exc:
                if not _core.should_retry(kwargs, None, attempt, self.settings.max_retries):
                    raise MitraError(f"network error: {exc}") from exc
            if response is not None:
                if response.status_code < 400:
                    if full:
                        return response
                    decoded = _core.decode(response, parse, raw)
                    return (response.status_code, decoded) if with_status else decoded
                if response.status_code not in _core.RETRY_STATUSES or not _core.should_retry(
                    kwargs, response.status_code, attempt, self.settings.max_retries
                ):
                    _core.raise_for_response(response)
            time.sleep(_core.retry_delay(response, attempt))
            attempt += 1

    def long(
        self,
        method: str,
        path: str,
        *,
        kind: str,
        wait: float | None,
        background: bool,
        **prep: Any,
    ) -> Job:
        """A job-based call: send ``Prefer: wait=N``, then poll ``GET /jobs/{id}`` until it ends."""
        prefer, timeout = _long_plan(kind, wait, background)
        started = time.monotonic()
        job = self.request(
            method, path, prefer=prefer, parse=_as_job,
            request_timeout=max(self.settings.timeout, timeout_for(prefer)), **prep,
        )
        if background:
            return job
        if job.is_terminal:
            return _check_terminal(job)
        left = max(timeout - (time.monotonic() - started), 0.0)
        return self.jobs.wait(job, left, **_job_opts(prep))

    def settle(
        self,
        method: str,
        path: str,
        *,
        kind: str,
        wait: float | None,
        background: bool,
        parse: Callable[[Any], Any],
        is_done: Callable[[Any], bool],
        poll: Callable[[Any], tuple[str | None, Callable[[Any], Any], Callable[[Any, Any], Any]]],
        **prep: Any,
    ) -> Any:
        """A resource call (source, file): send ``Prefer: wait=N``, then poll the resource itself
        until ``is_done``. On timeout the resource is returned as it stands (nothing is raised)."""
        prefer, timeout = _long_plan(kind, wait, background)
        started = time.monotonic()
        result = self.request(
            method, path, prefer=prefer, parse=parse,
            request_timeout=max(self.settings.timeout, timeout_for(prefer)), **prep,
        )
        if background or is_done(result):
            return result
        poll_path, poll_parse, merge = poll(result)
        if poll_path is None:
            return result
        opts = _job_opts(prep)
        delays = _poll_delays(*_RESOURCE_POLL)
        while True:
            delay = next(delays)
            if time.monotonic() + delay > started + timeout:
                return result
            time.sleep(delay)
            result = merge(result, self.request("GET", poll_path, parse=poll_parse, **opts))
            if is_done(result):
                return result

    def stream(self, **prep: Any) -> Iterator[StreamEvent]:
        kwargs = _core.prepare(self.settings, "POST", "/ask", accept="text/event-stream", **prep)
        with self.http.stream("POST", **{k: v for k, v in kwargs.items() if k != "method"},
                              timeout=httpx.Timeout(self.settings.timeout, read=None)) as response:
            if response.status_code >= 400:
                response.read()
                _core.raise_for_response(response)
            frame: list[str] = []
            for line in response.iter_lines():
                if line == "":
                    parsed = _core.parse_sse(frame)
                    frame = []
                    if parsed:
                        yield StreamEvent(event=parsed[0], data=parsed[1])
                else:
                    frame.append(line)
            parsed = _core.parse_sse(frame)
            if parsed:
                yield StreamEvent(event=parsed[0], data=parsed[1])


class _SyncJobs(_JobsBase):
    def wait(
        self,
        job: Job | str,
        timeout: float = DEFAULT_JOB_TIMEOUT,
        *,
        poll_interval: float = 1.0,
        max_poll_interval: float = 15.0,
        on_update: Callable[[Job], None] | None = None,
        raise_on_failure: bool = True,
        **opts: _Opts,
    ) -> Job:
        """Poll until the job is terminal, with growing delays (1s up to 15s by default).

        Raises :class:`JobTimeoutError` after ``timeout`` seconds (the job keeps running) and,
        unless ``raise_on_failure=False``, :class:`JobFailedError` for failed or cancelled jobs.
        """
        job_id = job if isinstance(job, str) else job.id
        deadline = time.monotonic() + timeout
        current = self.get(job_id, **opts)
        delays = _poll_delays(poll_interval, max_poll_interval)
        while not current.is_terminal:
            if on_update:
                on_update(current)
            if time.monotonic() + (delay := next(delays)) > deadline:
                raise JobTimeoutError(f"job {job_id} still {current.state} after {timeout}s", job=current)
            time.sleep(delay)
            current = self.get(job_id, **opts)
        if on_update:
            on_update(current)
        return _check_terminal(current) if raise_on_failure else current


def _redirect_target(response: httpx.Response) -> str | None:
    if 300 <= response.status_code < 400:
        return response.headers.get("location")
    return None


class _SyncDashboards(_Dashboards):
    def image_bytes(
        self, dashboard_id: str, *, width: int | None = None, timeout: float = 300.0,
        **opts: _Opts,
    ) -> bytes:
        """PNG bytes of a dashboard: ``GET /dashboards/{id}/image.png``.

        The server redirects (303) to an image drawn in the last ten minutes, or answers 202 and a
        Job; this method follows either and waits up to ``timeout`` seconds for the Job."""
        response = self._c.request(
            "GET", f"/dashboards/{dashboard_id}/image.png", params={"width": width},
            full=True, accept="image/png", **opts,
        )
        target = _redirect_target(response)
        if target:
            return self._c.download(target)
        if response.headers.get("content-type", "").startswith("image/"):
            return response.content
        job = self._c.jobs.wait(Job.model_validate(response.json()), timeout, **_job_opts(opts))
        return self._c.download((job.result or {})["image_url"])

    def render(
        self, dashboard_id: str, *, width: int | None = None, timeout: float = 300.0,
        **opts: _Opts,
    ) -> bytes:
        """Draw a dashboard (``POST .../image``), wait for the Job and return the PNG bytes."""
        job = self.image(dashboard_id, width=width, wait=timeout, **opts)
        return self._c.download((job.result or {})["image_url"])


class _SyncPredictions(_Predictions):
    def run(self, question: str, *, timeout: float = DEFAULT_JOB_TIMEOUT, **kw: Any) -> Job:
        """Create a prediction and wait for it. Returns the finished :class:`Job`."""
        return self.create(question, wait=timeout, **kw)


class Mitra:
    """Synchronous client.

    Args:
        api_key: Workspace API key (``mtk_...``). Falls back to ``MATIH_API_KEY``.
        access_token: OAuth access token (``mto_...``). Use instead of ``api_key``
            (falls back to ``MATIH_ACCESS_TOKEN``).
        base_url: The host only, default ``https://workspace.matih.ai`` (or ``MATIH_BASE_URL``).
            ``/api/v1`` is appended for you.
        workspace_id: Sent as ``X-Matih-Workspace`` (OAuth tokens; API keys are pinned).
        language: Default BCP-47 language such as ``hi-IN``, sent as ``Accept-Language``.
        timeout: Per-request timeout in seconds.
        max_retries: Retries for 429, and for 5xx or network errors on safe calls.
        http_client: Bring your own ``httpx.Client`` (proxies, tests).

    Every endpoint method also accepts ``workspace_id=`` and ``language=``. ``ask`` and
    ``predictions.create`` also accept ``idempotency_key=`` (generated for you when omitted).
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        access_token: str | None = None,
        base_url: str | None = None,
        workspace_id: str | None = None,
        language: str | None = None,
        timeout: float = 60.0,
        max_retries: int = 2,
        http_client: httpx.Client | None = None,
    ) -> None:
        settings = _core.Settings(
            api_key=api_key,
            access_token=access_token,
            base_url=base_url,
            workspace_id=workspace_id,
            language=language,
            timeout=timeout,
            max_retries=max_retries,
        )
        self._owns_http = http_client is None
        self._http = http_client or httpx.Client()
        core = _SyncCore(settings, self._http)
        core.download = self._download  # type: ignore[attr-defined]
        self._core = core
        self.workspaces = _Workspaces(core)
        self.sources = _Sources(core)
        self.connectors = _Connectors(core)
        self.files = _Files(core)
        self.gems = _Gems(core)
        self.dashboards = _SyncDashboards(core)
        self.predictions = _SyncPredictions(core)
        self.jobs = _SyncJobs(core)
        self.webhooks = _Webhooks(core)
        self.conversations = _Conversations(core)
        self.members = _Members(core)
        self.invitations = _Invitations(core)
        core.jobs = self.jobs  # type: ignore[attr-defined]
        self.settings = settings

    def __enter__(self) -> Mitra:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        if self._owns_http:
            self._http.close()

    def ask(
        self,
        question: str,
        *,
        conversation_id: str | None = None,
        source_id: str | None = None,
        language: str | None = None,
        background: bool = False,
        **opts: _Opts,
    ) -> Answer | Job:
        """Ask a question. Reuse ``answer.conversation_id`` for follow-ups.

        With ``background=True`` the server is asked to respond asynchronously
        (``Prefer: respond-async``) and a :class:`Job` of kind ``ask`` comes back at once; use
        ``jobs.wait(job)`` and then ``job.as_answer()``."""
        status, payload = self._core.request(
            "POST",
            "/ask",
            json_body=_ask_body(question, conversation_id, source_id, language, False),
            idempotent=True,
            language=language,
            prefer="respond-async" if background else None,
            with_status=True,
            **opts,
        )
        return _ask_result(status, payload)

    def ask_stream(
        self,
        question: str,
        *,
        conversation_id: str | None = None,
        source_id: str | None = None,
        language: str | None = None,
        **opts: _Opts,
    ) -> Iterator[StreamEvent]:
        """Ask and iterate server-sent events: ``started``, ``progress``, ``answer``, ``error``."""
        return self._core.stream(
            json_body=_ask_body(question, conversation_id, source_id, language, True),
            idempotent=True,
            language=language,
            **opts,
        )

    def ask_audio(
        self,
        file: str | os.PathLike[str] | bytes | BinaryIO,
        *,
        filename: str | None = None,
        content_type: str | None = None,
        conversation_id: str | None = None,
        source_id: str | None = None,
        language: str | None = None,
        **opts: _Opts,
    ) -> Answer:
        """Ask by voice note (``POST /ask/audio``). ``answer.heard`` has the transcript and the
        detected language; pass ``language`` to force the response language."""
        data = _audio_fields(conversation_id, source_id, language)
        return self._core.request(
            "POST",
            "/ask/audio",
            files={"file": _file_part(file, filename, content_type)},
            data=data,
            parse=Answer.model_validate,
            **opts,
        )

    def _download(self, url: str) -> bytes:
        """Fetch a signed ``image_url``. No credential is sent."""
        response = self._http.get(
            urljoin(self._core.settings.base_url + "/", url), timeout=self._core.settings.timeout,
            follow_redirects=True,
        )
        _core.raise_for_response(response)
        return response.content

    def download_image(self, image_url: str) -> bytes:
        """Download PNG bytes from a short-lived signed ``image_url`` (valid ~15 minutes)."""
        return self._download(image_url)


# -------------------------------------------------------------------------- async


class _AsyncCore:
    def __init__(self, settings: _core.Settings, http: httpx.AsyncClient) -> None:
        self.settings = settings
        self.http = http

    async def request(
        self,
        method: str,
        path: str,
        *,
        parse: Callable[[Any], Any] | None = None,
        raw: bool = False,
        with_status: bool = False,
        full: bool = False,
        request_timeout: float | None = None,
        **prep: Any,
    ) -> Any:
        kwargs = _core.prepare(self.settings, method, path, **prep)
        timeout = request_timeout or self.settings.timeout
        attempt = 0
        while True:
            response: httpx.Response | None = None
            try:
                response = await self.http.request(**kwargs, timeout=timeout)
            except httpx.TransportError as exc:
                if not _core.should_retry(kwargs, None, attempt, self.settings.max_retries):
                    raise MitraError(f"network error: {exc}") from exc
            if response is not None:
                if response.status_code < 400:
                    if full:
                        return response
                    decoded = _core.decode(response, parse, raw)
                    return (response.status_code, decoded) if with_status else decoded
                if response.status_code not in _core.RETRY_STATUSES or not _core.should_retry(
                    kwargs, response.status_code, attempt, self.settings.max_retries
                ):
                    _core.raise_for_response(response)
            await asyncio.sleep(_core.retry_delay(response, attempt))
            attempt += 1

    async def long(
        self,
        method: str,
        path: str,
        *,
        kind: str,
        wait: float | None,
        background: bool,
        **prep: Any,
    ) -> Job:
        """A job-based call: send ``Prefer: wait=N``, then poll ``GET /jobs/{id}`` until it ends."""
        prefer, timeout = _long_plan(kind, wait, background)
        started = time.monotonic()
        job = await self.request(
            method, path, prefer=prefer, parse=_as_job,
            request_timeout=max(self.settings.timeout, timeout_for(prefer)), **prep,
        )
        if background:
            return job
        if job.is_terminal:
            return _check_terminal(job)
        left = max(timeout - (time.monotonic() - started), 0.0)
        return await self.jobs.wait(job, left, **_job_opts(prep))

    async def settle(
        self,
        method: str,
        path: str,
        *,
        kind: str,
        wait: float | None,
        background: bool,
        parse: Callable[[Any], Any],
        is_done: Callable[[Any], bool],
        poll: Callable[[Any], tuple[str | None, Callable[[Any], Any], Callable[[Any, Any], Any]]],
        **prep: Any,
    ) -> Any:
        """Async version of the sync ``settle``: poll the resource itself until ``is_done``."""
        prefer, timeout = _long_plan(kind, wait, background)
        started = time.monotonic()
        result = await self.request(
            method, path, prefer=prefer, parse=parse,
            request_timeout=max(self.settings.timeout, timeout_for(prefer)), **prep,
        )
        if background or is_done(result):
            return result
        poll_path, poll_parse, merge = poll(result)
        if poll_path is None:
            return result
        opts = _job_opts(prep)
        delays = _poll_delays(*_RESOURCE_POLL)
        while True:
            delay = next(delays)
            if time.monotonic() + delay > started + timeout:
                return result
            await asyncio.sleep(delay)
            result = merge(result, await self.request("GET", poll_path, parse=poll_parse, **opts))
            if is_done(result):
                return result

    async def stream(self, **prep: Any) -> AsyncIterator[StreamEvent]:
        kwargs = _core.prepare(self.settings, "POST", "/ask", accept="text/event-stream", **prep)
        async with self.http.stream(
            "POST",
            **{k: v for k, v in kwargs.items() if k != "method"},
            timeout=httpx.Timeout(self.settings.timeout, read=None),
        ) as response:
            if response.status_code >= 400:
                await response.aread()
                _core.raise_for_response(response)
            frame: list[str] = []
            async for line in response.aiter_lines():
                if line == "":
                    parsed = _core.parse_sse(frame)
                    frame = []
                    if parsed:
                        yield StreamEvent(event=parsed[0], data=parsed[1])
                else:
                    frame.append(line)
            parsed = _core.parse_sse(frame)
            if parsed:
                yield StreamEvent(event=parsed[0], data=parsed[1])


class _AsyncJobs(_JobsBase):
    async def wait(
        self,
        job: Job | str,
        timeout: float = DEFAULT_JOB_TIMEOUT,
        *,
        poll_interval: float = 1.0,
        max_poll_interval: float = 15.0,
        on_update: Callable[[Job], Any] | None = None,
        raise_on_failure: bool = True,
        **opts: _Opts,
    ) -> Job:
        """Async version of :meth:`Mitra.jobs.wait`. ``on_update`` may be a plain function."""
        job_id = job if isinstance(job, str) else job.id
        deadline = time.monotonic() + timeout
        current = await self.get(job_id, **opts)
        delays = _poll_delays(poll_interval, max_poll_interval)
        while not current.is_terminal:
            if on_update:
                result = on_update(current)
                if asyncio.iscoroutine(result):
                    await result
            if time.monotonic() + (delay := next(delays)) > deadline:
                raise JobTimeoutError(f"job {job_id} still {current.state} after {timeout}s", job=current)
            await asyncio.sleep(delay)
            current = await self.get(job_id, **opts)
        if on_update:
            result = on_update(current)
            if asyncio.iscoroutine(result):
                await result
        return _check_terminal(current) if raise_on_failure else current


class _AsyncDashboards(_Dashboards):
    async def image_bytes(
        self, dashboard_id: str, *, width: int | None = None, timeout: float = 300.0,
        **opts: _Opts,
    ) -> bytes:
        """PNG bytes of a dashboard: follows the 303 redirect, or waits for the Job on a 202."""
        response = await self._c.request(
            "GET", f"/dashboards/{dashboard_id}/image.png", params={"width": width},
            full=True, accept="image/png", **opts,
        )
        target = _redirect_target(response)
        if target:
            return await self._c.download(target)
        if response.headers.get("content-type", "").startswith("image/"):
            return response.content
        job = await self._c.jobs.wait(
            Job.model_validate(response.json()), timeout, **_job_opts(opts)
        )
        return await self._c.download((job.result or {})["image_url"])

    async def render(
        self, dashboard_id: str, *, width: int | None = None, timeout: float = 300.0,
        **opts: _Opts,
    ) -> bytes:
        """Draw a dashboard (``POST .../image``), wait for the Job and return the PNG bytes."""
        job = await self.image(dashboard_id, width=width, wait=timeout, **opts)
        return await self._c.download((job.result or {})["image_url"])


class _AsyncPredictions(_Predictions):
    async def run(self, question: str, *, timeout: float = DEFAULT_JOB_TIMEOUT, **kw: Any) -> Job:
        """Create a prediction and wait for it. Returns the finished :class:`Job`."""
        return await self.create(question, wait=timeout, **kw)


class AsyncMitra:
    """Asynchronous client with the same surface as :class:`Mitra`; every call is awaitable.

    ``ask_stream`` is used with ``async for``.
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        access_token: str | None = None,
        base_url: str | None = None,
        workspace_id: str | None = None,
        language: str | None = None,
        timeout: float = 60.0,
        max_retries: int = 2,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        settings = _core.Settings(
            api_key=api_key,
            access_token=access_token,
            base_url=base_url,
            workspace_id=workspace_id,
            language=language,
            timeout=timeout,
            max_retries=max_retries,
        )
        self._owns_http = http_client is None
        self._http = http_client or httpx.AsyncClient()
        core = _AsyncCore(settings, self._http)
        core.download = self._download  # type: ignore[attr-defined]
        self._core = core
        self.workspaces = _Workspaces(core)
        self.sources = _Sources(core)
        self.connectors = _Connectors(core)
        self.files = _Files(core)
        self.gems = _Gems(core)
        self.dashboards = _AsyncDashboards(core)
        self.predictions = _AsyncPredictions(core)
        self.jobs = _AsyncJobs(core)
        self.webhooks = _Webhooks(core)
        self.conversations = _Conversations(core)
        self.members = _Members(core)
        self.invitations = _Invitations(core)
        core.jobs = self.jobs  # type: ignore[attr-defined]
        self.settings = settings

    async def __aenter__(self) -> AsyncMitra:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def ask(
        self,
        question: str,
        *,
        conversation_id: str | None = None,
        source_id: str | None = None,
        language: str | None = None,
        background: bool = False,
        **opts: _Opts,
    ) -> Answer | Job:
        """Async version of :meth:`Mitra.ask`; ``background=True`` returns a :class:`Job`."""
        status, payload = await self._core.request(
            "POST",
            "/ask",
            json_body=_ask_body(question, conversation_id, source_id, language, False),
            idempotent=True,
            language=language,
            prefer="respond-async" if background else None,
            with_status=True,
            **opts,
        )
        return _ask_result(status, payload)

    def ask_stream(
        self,
        question: str,
        *,
        conversation_id: str | None = None,
        source_id: str | None = None,
        language: str | None = None,
        **opts: _Opts,
    ) -> AsyncIterator[StreamEvent]:
        return self._core.stream(
            json_body=_ask_body(question, conversation_id, source_id, language, True),
            idempotent=True,
            language=language,
            **opts,
        )

    async def ask_audio(
        self,
        file: str | os.PathLike[str] | bytes | BinaryIO,
        *,
        filename: str | None = None,
        content_type: str | None = None,
        conversation_id: str | None = None,
        source_id: str | None = None,
        language: str | None = None,
        **opts: _Opts,
    ) -> Answer:
        data = _audio_fields(conversation_id, source_id, language)
        return await self._core.request(
            "POST",
            "/ask/audio",
            files={"file": _file_part(file, filename, content_type)},
            data=data,
            parse=Answer.model_validate,
            **opts,
        )

    async def _download(self, url: str) -> bytes:
        response = await self._http.get(
            urljoin(self._core.settings.base_url + "/", url), timeout=self._core.settings.timeout,
            follow_redirects=True,
        )
        _core.raise_for_response(response)
        return response.content

    async def download_image(self, image_url: str) -> bytes:
        """Download PNG bytes from a short-lived signed ``image_url`` (valid ~15 minutes)."""
        return await self._download(image_url)
