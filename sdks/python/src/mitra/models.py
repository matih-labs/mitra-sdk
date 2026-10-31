"""Pydantic models for the main response shapes.

Models accept unknown fields (``extra="allow"``) so a server that adds a field never breaks an
older client; the extra values are still available as attributes.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class _Model(BaseModel):
    model_config = ConfigDict(extra="allow")


class Column(_Model):
    name: str
    type: str | None = None


class ResultTable(_Model):
    columns: list[Column] = Field(default_factory=list)
    rows: list[list[Any]] = Field(default_factory=list)
    row_count: int = 0
    truncated: bool = False


class Clarification(_Model):
    question: str
    options: list[str] = Field(default_factory=list)


class Heard(_Model):
    """What speech recognition heard in a voice note (``ask_audio``)."""

    transcript: str | None = None
    language: str | None = None


class Answer(_Model):
    """Result of ``ask``. ``status`` is ``answered``, ``empty``, ``clarification``, ``error`` or ``cancelled``."""

    status: str
    answer: str | None = None
    clarification: Clarification | None = None
    result: ResultTable | None = None
    sql: str | None = None
    image_url: str | None = None
    follow_ups: list[str] = Field(default_factory=list)
    conversation_id: str | None = None
    request_id: str | None = None
    language: str | None = None
    heard: Heard | None = None


class JobError(_Model):
    category: str | None = None
    message: str | None = None


JobKind = Literal["ask", "gems", "prediction", "dashboard_image"]
JobState = Literal["queued", "running", "succeeded", "failed", "cancelled"]
Role = Literal["owner", "admin", "user", "viewer"]
GivableRole = Literal["admin", "user", "viewer"]
DuplicateChoice = Literal["use_existing", "keep_both", "cancel"]
OnDuplicate = Literal["ask", "keep_both"]
WebhookEvent = Literal["gems.ready", "prediction.completed", "job.completed", "dashboard_image.ready"]

TERMINAL_STATES = frozenset({"succeeded", "failed", "cancelled"})


class Job(_Model):
    """Work that outlasts a request. ``state`` is queued, running, succeeded, failed or cancelled.

    ``result`` is set when it succeeded: for ``ask`` the Answer, for ``gems``
    ``{source_id, state, gem_count}``, for ``prediction`` ``{conversation_id, answer}`` and for
    ``dashboard_image`` ``{image_url, width, height}``. ``error`` is set when it failed.
    """

    id: str
    kind: str
    state: str
    result: dict[str, Any] | None = None
    error: JobError | None = None
    created_at: str | None = None
    updated_at: str | None = None

    @property
    def is_terminal(self) -> bool:
        return self.state in TERMINAL_STATES

    def as_answer(self) -> Answer:
        """For a job of kind ``ask``: the finished :class:`Answer` held in ``result``."""
        if not self.result:
            raise ValueError(f"job {self.id} has no result yet (state={self.state})")
        return Answer.model_validate(self.result)


class ConversationMessage(_Model):
    id: str
    role: str
    text: str
    sql: str | None = None
    created_at: str | None = None


class Conversation(_Model):
    id: str
    title: str | None = None
    source_id: str | None = None
    channel: str | None = None
    message_count: int = 0
    created_at: str | None = None
    updated_at: str | None = None
    messages: list[ConversationMessage] | None = None


class ConversationList(_Model):
    conversations: list[Conversation] = Field(default_factory=list)


class Figure(_Model):
    label: str
    value: str


class Gem(_Model):
    id: str
    kind: str | None = None
    headline: str | None = None
    explanation: str | None = None
    figures: list[Figure] = Field(default_factory=list)
    question: str | None = None
    source_id: str | None = None
    image_url: str | None = None
    created_at: str | None = None


class GemList(_Model):
    """``state`` is none, running, ready, partial, empty, insufficient, failed, not_ready or no_source."""

    state: str | None = None
    gems: list[Gem] = Field(default_factory=list)
    generated_at: str | None = None


class DashboardWidget(_Model):
    id: str
    title: str | None = None
    visual: str | None = None
    question: str | None = None


class Dashboard(_Model):
    id: str
    title: str | None = None
    source_id: str | None = None
    status: str | None = None
    revision: int | None = None
    widget_count: int | None = None
    created_at: str | None = None
    updated_at: str | None = None
    description: str | None = None
    widgets: list[DashboardWidget] | None = None


class DashboardList(_Model):
    dashboards: list[Dashboard] = Field(default_factory=list)


class Workspace(_Model):
    id: str
    name: str
    role: str | None = None
    kind: str | None = None
    own: bool = False


class WorkspaceInvitation(_Model):
    """An open invitation addressed to the caller (in :class:`WorkspaceList`)."""

    id: str
    workspace_id: str | None = None
    workspace_name: str | None = None
    role: str | None = None
    invited_by: str | None = None
    expires_at: str | None = None


class WorkspaceList(_Model):
    current: str | None = None
    workspaces: list[Workspace] = Field(default_factory=list)
    invitations: list[WorkspaceInvitation] | None = None


class WorkspaceChosen(_Model):
    current: str
    name: str | None = None


class Member(_Model):
    id: str
    name: str | None = None
    email: str | None = None
    phone: str | None = None
    role: str | None = None
    whatsapp_only: bool = False
    joined_at: str | None = None
    last_seen_at: str | None = None
    monthly_cap_credits: float | None = None
    you: bool = False
    can_change_role: bool = False
    can_remove: bool = False


class MemberList(_Model):
    members: list[Member] = Field(default_factory=list)


class MemberRemoved(_Model):
    removed: str


class Invitation(_Model):
    id: str
    channel: str | None = None
    target: str | None = None
    role: str | None = None
    whatsapp_only: bool = False
    created_at: str | None = None
    expires_at: str | None = None
    expired: bool = False
    sent_at: str | None = None
    delivered: str | None = None
    join_code: str | None = None
    join_message: str | None = None
    join_url: str | None = None


class InvitationList(_Model):
    invitations: list[Invitation] = Field(default_factory=list)


class InvitationRevoked(_Model):
    revoked: str


class ConnectorField(_Model):
    name: str
    label: str | None = None
    type: str | None = None
    required: bool = False
    secret: bool = False
    default: Any = None
    help: str | None = None
    options: list[dict[str, str]] | None = None
    visible_when: dict[str, list[str]] | None = None
    group: str | None = None
    advanced: bool = False


class Connector(_Model):
    type: str
    label: str | None = None
    description: str | None = None
    docs_url: str | None = None
    notes: list[str] = Field(default_factory=list)
    driver_installed: bool = True
    fields: list[ConnectorField] = Field(default_factory=list)


class ConnectorList(_Model):
    connectors: list[Connector] = Field(default_factory=list)


class Catalog(_Model):
    readiness: str | None = None
    notes: list[str] = Field(default_factory=list)
    tables: int = 0
    included_tables: int = 0
    last_refresh_at: str | None = None
    published_version: int | None = None
    reading_now: bool = False


class SourceReadiness(_Model):
    """``can_ask`` is true once Ask can use the source; ``phase`` is ready, building or not_connected."""

    source_id: str
    state: str | None = None
    phase: str = "ready"
    can_ask: bool = False
    message: str | None = None
    catalog: Catalog | None = None


class Source(_Model):
    id: str
    name: str
    connector_type: str | None = None
    settings: dict[str, Any] = Field(default_factory=dict)
    secret_fields_set: list[str] = Field(default_factory=list)
    state: str | None = None
    is_active: bool = False
    is_sample: bool = False
    managed_by: str | None = None
    last_test_ok: bool | None = None
    last_test_message: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    readiness: SourceReadiness | None = None


class SourceList(_Model):
    sources: list[Source] = Field(default_factory=list)
    active_source_id: str | None = None


class SourceTest(_Model):
    ok: bool
    connector_type: str | None = None
    duration_ms: int | None = None
    message: str | None = None
    error_category: str | None = None
    server_version: str | None = None
    warnings: list[str] = Field(default_factory=list)
    field: str | None = None


class SourceCreated(_Model):
    """Answer of ``sources.create``. ``source.readiness.can_ask`` says whether Ask can use it yet."""

    source: Source | None = None
    test: SourceTest | None = None
    applied: bool = True
    catalog_job_id: str | None = None


class SourceDeleted(_Model):
    deleted: bool


class FileTableRef(_Model):
    model_name: str
    label: str | None = None
    rows: int | None = None
    column_count: int | None = None


class File(_Model):
    """An uploaded file. ``status`` is uploading, validating, processing, ready, needs_attention,
    failed, deleting or deleted; ``ready`` is true once its tables can be asked about.
    ``decision_required == "duplicate"`` means it waits for ``files.duplicate``."""

    id: str
    name: str | None = None
    format: str | None = None
    size_bytes: int | None = None
    status: str | None = None
    stage: str | None = None
    ready: bool = False
    analysis_state: str | None = None
    warnings: list[str] = Field(default_factory=list)
    error_category: str | None = None
    error_message: str | None = None
    retryable: bool = False
    duplicate_of: str | None = None
    decision_required: str | None = None
    decision_options: list[str] = Field(default_factory=list)
    tables: list[FileTableRef] = Field(default_factory=list)
    uploaded_at: str | None = None
    processed_at: str | None = None
    created_at: str | None = None
    updated_at: str | None = None

    @property
    def is_settled(self) -> bool:
        """True when polling can stop: ready, failed, deleted or waiting for a decision."""
        return (
            self.ready
            or bool(self.decision_required)
            or self.status in ("needs_attention", "failed", "deleting", "deleted")
        )


class FileList(_Model):
    files: list[File] = Field(default_factory=list)
    total: int = 0


class Webhook(_Model):
    """A webhook. ``secret`` (``whsec_...``) is present only in the create response."""

    id: str
    url: str | None = None
    events: list[str] = Field(default_factory=list)
    created_at: str | None = None
    disabled_at: str | None = None
    disabled_reason: str | None = None
    failure_count: int = 0
    last_success_at: str | None = None
    secret: str | None = None


class WebhookList(_Model):
    webhooks: list[Webhook] = Field(default_factory=list)


class WebhookDelivery(_Model):
    id: str
    event_id: str | None = None
    event: str | None = None
    attempt: int = 0
    state: str | None = None
    next_attempt_at: str | None = None
    last_status: int | None = None
    last_error: str | None = None
    created_at: str | None = None
    delivered_at: str | None = None


class WebhookDeliveryList(_Model):
    deliveries: list[WebhookDelivery] = Field(default_factory=list)


class WebhookTestResult(_Model):
    delivery_id: str | None = None
    delivered: bool = False
    status: int | None = None
    error: str | None = None


class StreamEvent(_Model):
    """One server-sent event from ``ask_stream``: ``started``, ``progress``, ``answer``, ``error``."""

    event: str
    data: Any = None

    def as_answer(self) -> Answer:
        """Parse an ``answer`` event's data as an :class:`Answer`."""
        return Answer.model_validate(self.data)
