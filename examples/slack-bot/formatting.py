"""Pure helpers: command parsing, Slack block building, error text. No Slack imports."""

from __future__ import annotations

import difflib
import json
import re
from typing import Any

VERBS = ("ask", "gems", "dashboard", "forecast", "workspace", "help")

HELP_TEXT = (
    "*Matih commands*\n"
    "- `/matih ask <question>` ask your data a question (any Indian language works)\n"
    "- `/matih gems` the latest Gems (automatic findings)\n"
    "- `/matih dashboard <name>` a dashboard as an image\n"
    "- `/matih forecast <question>` a forecast or what-if (takes a few minutes)\n"
    "- `/matih workspace` see and switch the workspace for this channel\n"
    "You can also mention me with a question."
)


def parse_command(text: str) -> tuple[str, str]:
    """Split `ask how many orders` into (`ask`, `how many orders`). Bare text means ask."""
    text = (text or "").strip()
    if not text:
        return "help", ""
    head, _, rest = text.partition(" ")
    if head.lower() in VERBS:
        return head.lower(), rest.strip()
    return "ask", text


def strip_mention(text: str) -> str:
    return re.sub(r"<@[A-Z0-9]+>", "", text or "").strip()


def match_name(items: list[Any], query: str, key: str = "title") -> Any | None:
    """Find the item whose name best matches the query: exact, substring, then close match."""
    names = {str(getattr(i, key, "") or "").lower(): i for i in items}
    q = query.strip().lower()
    if not q or not names:
        return None
    if q in names:
        return names[q]
    contains = [n for n in names if q in n]
    if len(contains) == 1:
        return names[contains[0]]
    close = difflib.get_close_matches(q, list(names), n=1, cutoff=0.5)
    return names[close[0]] if close else None


def format_table(result: Any, max_rows: int = 10, max_width: int = 18) -> str:
    """A fixed-width text table for a Slack code block, or '' when there is nothing to show."""
    if result is None or not result.columns or not result.rows:
        return ""
    names = [c.name for c in result.columns]
    rows = [[_cell(v, max_width) for v in row] for row in result.rows[:max_rows]]
    widths = [max(len(n), *(len(r[i]) for r in rows)) for i, n in enumerate(names)]
    lines = ["  ".join(n.ljust(w) for n, w in zip(names, widths, strict=False))]
    lines.append("  ".join("-" * w for w in widths))
    for r in rows:
        lines.append("  ".join(v.ljust(w) for v, w in zip(r, widths, strict=False)))
    extra = result.row_count - len(rows)
    if extra > 0 or result.truncated:
        lines.append(f"... {max(extra, 0)} more rows" + (" (result truncated)" if result.truncated else ""))
    return "\n".join(lines)


def _cell(value: Any, max_width: int) -> str:
    text = "" if value is None else str(value)
    return text if len(text) <= max_width else text[: max_width - 1] + "…"


def answer_blocks(answer: Any) -> list[dict[str, Any]]:
    """Slack blocks for an Answer. Clarifications become buttons that continue the conversation."""
    status = answer.status
    if status == "clarification" and answer.clarification:
        buttons = [
            {
                "type": "button",
                "text": {"type": "plain_text", "text": option[:70]},
                "action_id": f"matih_clarify_{i}",
                "value": json.dumps({"c": answer.conversation_id, "o": option})[:1900],
            }
            for i, option in enumerate(answer.clarification.options[:5])
        ]
        blocks: list[dict[str, Any]] = [
            {"type": "section", "text": {"type": "mrkdwn", "text": answer.clarification.question}}
        ]
        if buttons:
            blocks.append({"type": "actions", "elements": buttons})
        return blocks
    if status == "empty":
        text = answer.answer or "No rows matched. Try a wider date range or fewer filters."
    elif status == "cancelled":
        text = answer.answer or "That question was cancelled."
    elif status == "error":
        text = answer.answer or "I could not answer that. Try rephrasing the question."
    else:
        text = answer.answer or "Done."
    blocks = [{"type": "section", "text": {"type": "mrkdwn", "text": text[:2900]}}]
    table = format_table(answer.result)
    if table:
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": f"```{table}```"[:2900]}})
    if answer.follow_ups:
        hint = "\n".join(f"- {q}" for q in answer.follow_ups[:3])
        blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": f"Try next:\n{hint}"}]})
    return blocks


def gem_text(gem: Any) -> str:
    headline = gem.headline or "Gem"
    body = f"\n{gem.explanation}" if gem.explanation else ""
    return f"*{headline}*{body}"


def error_text(exc: Exception) -> str:
    """Friendly one-liner for a MitraError (matched by class name to stay import-light)."""
    name = type(exc).__name__
    message = getattr(exc, "message", None) or str(exc)
    request_id = getattr(exc, "request_id", None)
    suffix = f" (ref {request_id})" if request_id else ""
    if name == "PermissionDeniedError":
        return f"Matih says this key is not allowed to do that: {message}{suffix}"
    if name == "CreditsError":
        if getattr(exc, "category", None) == "member_cap":
            return f"You have reached your monthly credit cap in this workspace: {message}{suffix}"
        return f"The workspace is out of credits: {message}{suffix}"
    if name == "BusyError":
        return f"Matih could not do that right now (conflict): {message}{suffix}"
    if name == "RateLimitError":
        wait = getattr(exc, "retry_after", None)
        return f"Slow down a little, try again in {int(wait)}s." if wait else "Slow down a little."
    if name == "AuthError":
        return "The Matih credential was rejected. Ask an admin to check the bot's key."
    if name == "JobTimeoutError":
        return "That is taking longer than expected. It will keep running; ask again shortly."
    if name == "JobFailedError":
        return f"That did not finish: {message}{suffix}"
    return f"Something went wrong talking to Matih: {message}{suffix}"


def slack_locale_to_language(locale: str | None) -> str | None:
    """Slack gives `hi-IN` or `en-US`; the API takes BCP-47 as is."""
    if not locale:
        return None
    return locale.replace("_", "-")
