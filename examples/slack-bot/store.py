"""Tiny sqlite store: which Matih workspace a Slack channel uses, and conversation threads."""

from __future__ import annotations

import sqlite3
import threading
import time


class Store:
    def __init__(self, path: str = "matih_bot.sqlite3") -> None:
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        with self._lock, self._db:
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS channel_workspace ("
                "channel_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, updated_at REAL NOT NULL)"
            )
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS conversation ("
                "key TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, updated_at REAL NOT NULL)"
            )

    def get_workspace(self, channel_id: str) -> str | None:
        with self._lock:
            row = self._db.execute(
                "SELECT workspace_id FROM channel_workspace WHERE channel_id = ?", (channel_id,)
            ).fetchone()
        return row[0] if row else None

    def set_workspace(self, channel_id: str, workspace_id: str) -> None:
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO channel_workspace (channel_id, workspace_id, updated_at) "
                "VALUES (?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET "
                "workspace_id = excluded.workspace_id, updated_at = excluded.updated_at",
                (channel_id, workspace_id, time.time()),
            )

    def get_conversation(self, key: str, max_age_sec: float = 6 * 3600) -> str | None:
        """Conversation id for a (channel, thread or user) key, if recent enough."""
        with self._lock:
            row = self._db.execute(
                "SELECT conversation_id, updated_at FROM conversation WHERE key = ?", (key,)
            ).fetchone()
        if not row or time.time() - row[1] > max_age_sec:
            return None
        return row[0]

    def set_conversation(self, key: str, conversation_id: str) -> None:
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO conversation (key, conversation_id, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET conversation_id = excluded.conversation_id, "
                "updated_at = excluded.updated_at",
                (key, conversation_id, time.time()),
            )

    def close(self) -> None:
        with self._lock:
            self._db.close()
