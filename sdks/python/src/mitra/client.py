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
    Dashboard,
    DashboardList,
    File,
    GemList,
    Job,
    SourceList,
    StreamEvent,
    Webhook,
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


# (cap on the Prefer wait value the server honours, default total wait in seconds)
_WAIT_LIMITS = {
    "gems": (60, 600.0),
    "dashboard": (60, 300.0),
    "prediction": (60, DEFAULT_JOB_TIMEOUT),
    "source": (120, 300.0),
    "file": (60, 300.0),
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


def _job_opts(opts: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in opts.items() if k in ("workspace_id", "language")}


def _ask_result(status: int, payload: Any) -> Answer | Job:
    """``ask`` returns an Answer, or a Job when ``Prefer: respond-async`` was honoured."""
    if status == 202 or (isinstance(payload, dict) and "state" in payload and "kind" in payload):
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
        return self._c.request("GET", "/workspaces", parse=WorkspaceList.model_validate, **opts)

    def use(self, workspace_id: str, **opts: _Opts) -> Any:
        """Set the default workspace (``PUT /me/workspace``). OAuth tokens only."""
        return self._c.request("PUT", "/me/workspace", json_body={"workspace_id": workspace_id}, **opts)


class _Sources(_Resources):
    def list(self, **opts: _Opts) -> Any:
        return self._c.request("GET", "/sources", parse=SourceList.model_validate, **opts)

    def test(self, config: dict[str, Any], **opts: _Opts) -> Any:
        return self._c.request("POST", "/sources/test", json_body={"config": config}, **opts)

    def get(self, source_id: str, **opts: _Opts) -> Any:
        """One source, including its readiness."""
        return self._c.request("GET", f"/sources/{source_id}", **opts)

    def create(
        self,
        config: dict[str, Any],
        *,
        activate: bool = True,
        wait: float | None = None,
        background: bool = False,
        **opts: _Opts,
    ) -> Any:
        """Connect a source (admin, ``sources:write``).

        By default waits (``wait`` seconds, default 300) until the catalog is ready and returns
        the created source, or the finished :class:`Job` if the server answered 202.
        ``background=True`` returns right away with whatever the server answered (the source,
        or a Job to poll with ``jobs.wait``). Raises :class:`SourceTestFailedError` (HTTP 422,
        ``.test_result``) when the connection test fails."""
        return self._c.long(
            "POST", "/sources", kind="source", wait=wait, background=background,
            final=lambda payload: payload,
            json_body={"config": config, "activate": activate}, **opts,
        )

    def activate(self, source_id: str, **opts: _Opts) -> Any:
        return self._c.request("POST", f"/sources/{source_id}/activate", **opts)

    def delete(self, source_id: str, **opts: _Opts) -> Any:
        return self._c.request("DELETE", f"/sources/{source_id}", **opts)

    def connectors(self, **opts: _Opts) -> Any:
        return self._c.request("GET", "/connectors", **opts)


class _Files(_Resources):
    def upload(
        self,
        file: str | os.PathLike[str] | bytes | BinaryIO,
        *,
        filename: str | None = None,
        content_type: str | None = None,
        on_duplicate: str | None = None,
        wait: float | None = None,
        background: bool = False,
        **opts: _Opts,
    ) -> Any:
        """Upload a CSV or Excel file (``files:write``).

        By default waits (``wait`` seconds, default 300) for processing and returns the
        :class:`File`, or the finished :class:`Job` if the server answered 202. ``background=True``
        returns right away (a File to poll with ``files.get``, or a Job). ``on_duplicate`` says
        what to do if the file already exists; without it a ``decision_required`` file waits for
        ``files.duplicate``."""
        part = _file_part(file, filename, content_type)
        return self._c.long(
            "POST", "/files", kind="file", wait=wait, background=background,
            final=File.model_validate,
            files={"file": part},
            data={"on_duplicate": on_duplicate} if on_duplicate else None, **opts,
        )

    def list(self, **opts: _Opts) -> Any:
        return self._c.request("GET", "/files", **opts)

    def get(self, file_id: str, **opts: _Opts) -> Any:
        """Status, analysis state and ``decision_required`` for one file."""
        return self._c.request("GET", f"/files/{file_id}", parse=File.model_validate, **opts)

    def duplicate(self, file_id: str, decision: str, **opts: _Opts) -> Any:
        """Answer a ``decision_required`` duplicate prompt."""
        return self._c.request(
            "POST", f"/files/{file_id}/duplicate", json_body={"decision": decision}, **opts
        )

    def delete(self, file_id: str, **opts: _Opts) -> Any:
        return self._c.request("DELETE", f"/files/{file_id}", **opts)


class _Gems(_Resources):
    def list(self, source_id: str | None = None, **opts: _Opts) -> Any:
        return self._c.request(
            "GET", "/gems", params={"source_id": source_id}, parse=GemList.model_validate, **opts
        )

    def generate(
        self, source_id: str, *, wait: float | None = None, background: bool = False, **opts: _Opts
    ) -> Any:
        """Generate Gems. Blocks until done (up to ``wait`` seconds, default 600) and returns the
        finished :class:`Job`; ``background=True`` returns the queued Job immediately."""
        return self._c.long(
            "POST", "/gems/generate", kind="gems", wait=wait, background=background,
            final=_as_job, json_body={"source_id": source_id}, idempotent=True, **opts,
        )

    def get(self, gem_id: str, **opts: _Opts) -> Any:
        return self._c.request("GET", f"/gems/{gem_id}", parse=GemModel.model_validate, **opts)

    def image(self, gem_id: str, **opts: _Opts) -> Any:
        """PNG bytes of a Gem's chart."""
        return self._c.request("GET", f"/gems/{gem_id}/image.png", raw=True, accept="image/png", **opts)


class _Dashboards(_Resources):
    def list(self, **opts: _Opts) -> Any:
        return self._c.request("GET", "/dashboards", parse=DashboardList.model_validate, **opts)

    def get(self, dashboard_id: str, **opts: _Opts) -> Any:
        return self._c.request(
            "GET", f"/dashboards/{dashboard_id}", parse=Dashboard.model_validate, **opts
        )

    def image(
        self, dashboard_id: str, *, wait: float | None = None, background: bool = False,
        **opts: _Opts,
    ) -> Any:
        """Render a dashboard image. Blocks until done (up to ``wait`` seconds, default 300) and
        returns the finished :class:`Job` whose result is ``{image_url, width, height}``;
        ``background=True`` returns the Job immediately. See ``render`` for PNG bytes."""
        return self._c.long(
            "POST", f"/dashboards/{dashboard_id}/image", kind="dashboard", wait=wait,
            background=background, final=_as_job, idempotent=True, **opts,
        )


class _Predictions(_Resources):
    def create(
        self,
        question: str,
        *,
        source_id: str | None = None,
        conversation_id: str | None = None,
        wait: float | None = None,
        background: bool = False,
        **opts: _Opts,
    ) -> Any:
        """Run a forecast or what-if (can take up to 30 minutes).

        Blocks until done (up to ``wait`` seconds, default 1860) and returns the finished
        :class:`Job`; ``background=True`` returns the queued Job immediately so you can poll
        with ``jobs.wait`` or wait for a webhook."""
        body = {"question": question, "source_id": source_id, "conversation_id": conversation_id}
        return self._c.long(
            "POST", "/predictions", kind="prediction", wait=wait, background=background,
            final=_as_job, json_body={k: v for k, v in body.items() if v is not None},
            idempotent=True, **opts,
        )


class _Webhooks(_Resources):
    def list(self, **opts: _Opts) -> Any:
        return self._c.request("GET", "/webhooks", **opts)

    def create(self, url: str, events: list[str], **opts: _Opts) -> Any:
        """Register a webhook. The returned ``secret`` is shown once; store it."""
        return self._c.request(
            "POST", "/webhooks", json_body={"url": url, "events": events},
            parse=Webhook.model_validate, **opts,
        )

    def delete(self, webhook_id: str, **opts: _Opts) -> Any:
        return self._c.request("DELETE", f"/webhooks/{webhook_id}", **opts)

    def test(self, webhook_id: str, **opts: _Opts) -> Any:
        """Send a test delivery to the webhook URL."""
        return self._c.request("POST", f"/webhooks/{webhook_id}/test", **opts)

    def deliveries(self, webhook_id: str, **opts: _Opts) -> Any:
        return self._c.request("GET", f"/webhooks/{webhook_id}/deliveries", **opts)


class _Members(_Resources):
    """Needs ``members:read`` (list) or ``members:manage`` (change role, remove)."""

    def list(self, **opts: _Opts) -> Any:
        return self._c.request("GET", "/members", **opts)

    def update(self, member_id: str, role: str, **opts: _Opts) -> Any:
        return self._c.request("PATCH", f"/members/{member_id}", json_body={"role": role}, **opts)

    def remove(self, member_id: str, **opts: _Opts) -> Any:
        return self._c.request("DELETE", f"/members/{member_id}", **opts)


class _Invitations(_Resources):
    def create(
        self, role: str, *, email: str | None = None, phone: str | None = None, **opts: _Opts
    ) -> Any:
        """Invite by ``email`` or ``phone`` (``members:manage``)."""
        if bool(email) == bool(phone):
            raise ValueError("pass exactly one of email= or phone=")
        body = {"role": role, **({"email": email} if email else {"phone": phone})}
        return self._c.request("POST", "/invitations", json_body=body, **opts)

    def list(self, **opts: _Opts) -> Any:
        return self._c.request("GET", "/invitations", **opts)

    def revoke(self, invitation_id: str, **opts: _Opts) -> Any:
        return self._c.request("DELETE", f"/invitations/{invitation_id}", **opts)


class _Conversations(_Resources):
    def list(self, **opts: _Opts) -> Any:
        return self._c.request("GET", "/conversations", **opts)

    def get(self, conversation_id: str, **opts: _Opts) -> Any:
        return self._c.request("GET", f"/conversations/{conversation_id}", **opts)


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
        final: Callable[[Any], Any],
        **prep: Any,
    ) -> Any:
        """A call that may outlive one request: send ``Prefer: wait=N``, and on 202 poll the job."""
        prefer, timeout = _long_plan(kind, wait, background)
        started = time.monotonic()
        status, payload = self.request(
            method, path, prefer=prefer, with_status=True,
            request_timeout=max(self.settings.timeout, timeout_for(prefer)), **prep,
        )
        if status == 202:
            job = _as_job(payload)
            if background:
                return job
            left = max(timeout - (time.monotonic() - started), 0.0)
            return self.jobs.wait(job, left, **_job_opts(prep))
        result = final(payload)
        if isinstance(result, Job) and not background:
            if result.is_terminal:
                return _check_terminal(result)
            left = max(timeout - (time.monotonic() - started), 0.0)
            return self.jobs.wait(result, left, **_job_opts(prep))
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


class _SyncDashboards(_Dashboards):
    def render(self, dashboard_id: str, *, timeout: float = 300.0, **opts: _Opts) -> bytes:
        """Render a dashboard and return PNG bytes (starts the job, waits, downloads)."""
        job = self.image(dashboard_id, wait=timeout, **opts)
        return self._c.download((job.result or {})["image_url"])


class _SyncPredictions(_Predictions):
    def run(self, question: str, *, timeout: float = DEFAULT_JOB_TIMEOUT, **kw: Any) -> Job:
        """Create a prediction and wait for it. Returns the finished :class:`Job`."""
        return self.create(question, wait=timeout, **kw)


class Mitra:
    """Synchronous client.

    Args:
        api_key: Workspace API key (``mtk_...``). Falls back to ``MATIH_API_KEY``.
        access_token: OAuth access token (``mto_...``). Use instead of ``api_key``.
        base_url: Defaults to ``https://workspace.matih.ai/api/v1`` (or ``MATIH_BASE_URL``).
        workspace_id: Sent as ``X-Matih-Workspace`` (OAuth tokens; API keys are pinned).
        language: Default BCP-47 language such as ``hi-IN``, sent as ``Accept-Language``.
        timeout: Per-request timeout in seconds.
        max_retries: Retries for 429, and for 5xx or network errors on safe calls.
        http_client: Bring your own ``httpx.Client`` (proxies, tests).

    Every endpoint method also accepts ``workspace_id=``, ``language=`` and, for calls that
    cost credits, ``idempotency_key=``.
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
            idempotent=True,
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
        final: Callable[[Any], Any],
        **prep: Any,
    ) -> Any:
        """A call that may outlive one request: send ``Prefer: wait=N``, and on 202 poll the job."""
        prefer, timeout = _long_plan(kind, wait, background)
        started = time.monotonic()
        status, payload = await self.request(
            method, path, prefer=prefer, with_status=True,
            request_timeout=max(self.settings.timeout, timeout_for(prefer)), **prep,
        )
        if status == 202:
            job = _as_job(payload)
            if background:
                return job
            left = max(timeout - (time.monotonic() - started), 0.0)
            return await self.jobs.wait(job, left, **_job_opts(prep))
        result = final(payload)
        if isinstance(result, Job) and not background:
            if result.is_terminal:
                return _check_terminal(result)
            left = max(timeout - (time.monotonic() - started), 0.0)
            return await self.jobs.wait(result, left, **_job_opts(prep))
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
    async def render(self, dashboard_id: str, *, timeout: float = 300.0, **opts: _Opts) -> bytes:
        """Render a dashboard and return PNG bytes (starts the job, waits, downloads)."""
        job = await self.image(dashboard_id, wait=timeout, **opts)
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
            idempotent=True,
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
