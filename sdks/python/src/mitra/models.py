"""Pydantic models for the main response shapes.

Models accept unknown fields (``extra="allow"``) so a server that adds a field never breaks an
older client; the extra values are still available as attributes.
"""

from __future__ import annotations

from typing import Any

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
    """Result of ``ask``. ``status`` is ``answered``, ``clarification``, ``empty`` or ``error``."""

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


class Job(_Model):
    """A background job. ``state`` is queued, running, succeeded, failed or cancelled."""

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


TERMINAL_STATES = frozenset({"succeeded", "failed", "cancelled"})


class Gem(_Model):
    id: str
    kind: str | None = None
    headline: str | None = None
    explanation: str | None = None
    figures: Any = None
    question: str | None = None
    image_url: str | None = None
    created_at: str | None = None


class GemList(_Model):
    state: str | None = None
    gems: list[Gem] = Field(default_factory=list)
    generated_at: str | None = None


class Workspace(_Model):
    id: str
    name: str
    role: str | None = None
    kind: str | None = None


class WorkspaceList(_Model):
    current: str | None = None
    workspaces: list[Workspace] = Field(default_factory=list)


class Source(_Model):
    id: str
    name: str
    type: str | None = None
    status: str | None = None
    active: bool | None = None


class SourceList(_Model):
    sources: list[Source] = Field(default_factory=list)


class Dashboard(_Model):
    id: str
    title: str | None = None
    updated_at: str | None = None


class DashboardList(_Model):
    dashboards: list[Dashboard] = Field(default_factory=list)


class File(_Model):
    id: str
    status: str | None = None


class Webhook(_Model):
    """A webhook subscription. ``secret`` is present only in the create response."""

    id: str | None = None
    url: str | None = None
    events: list[str] = Field(default_factory=list)
    secret: str | None = None


class StreamEvent(_Model):
    """One server-sent event from ``ask_stream``: ``started``, ``progress``, ``answer``, ``error``."""

    event: str
    data: Any = None

    def as_answer(self) -> Answer:
        """Parse an ``answer`` event's data as an :class:`Answer`."""
        return Answer.model_validate(self.data)
