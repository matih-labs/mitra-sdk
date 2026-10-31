"""Matih Slack bot (Socket Mode, single workspace integration key).

Run:  python app.py   (see README.md for the Slack app manifest and environment variables)
"""

from __future__ import annotations

import json
import logging
import os
import threading
from typing import Any

from mitra import Mitra, MitraError

import formatting as fmt
from store import Store

log = logging.getLogger("matih-bot")

MAX_GEMS = 3


class MatihBot:
    """The bot's behaviour, separate from Slack wiring so it is easy to read and test."""

    def __init__(self, matih: Mitra, store: Store) -> None:
        self.matih = matih
        self.store = store
        self._locales: dict[str, str | None] = {}

    # ----------------------------------------------------------------- context

    def language_for(self, slack: Any, user_id: str) -> str | None:
        """The Slack user's locale (for example hi-IN), cached per user."""
        if user_id not in self._locales:
            try:
                info = slack.users_info(user=user_id, include_locale=True)
                self._locales[user_id] = fmt.slack_locale_to_language(info["user"].get("locale"))
            except Exception:  # noqa: BLE001 - locale is a nicety, never block on it
                self._locales[user_id] = None
        return self._locales[user_id]

    def opts(self, channel_id: str, language: str | None) -> dict[str, Any]:
        out: dict[str, Any] = {}
        workspace_id = self.store.get_workspace(channel_id)
        if workspace_id:
            out["workspace_id"] = workspace_id
        if language:
            out["language"] = language
        return out

    # ----------------------------------------------------------------- actions

    def ask(self, slack: Any, channel: str, user: str, question: str, thread_ts: str | None,
            conversation_id: str | None = None) -> None:
        key = f"{channel}:{thread_ts or user}"
        language = self.language_for(slack, user)
        conversation_id = conversation_id or self.store.get_conversation(key)
        try:
            answer = self.matih.ask(
                question, conversation_id=conversation_id, **self.opts(channel, language)
            )
        except MitraError as exc:
            slack.chat_postMessage(channel=channel, thread_ts=thread_ts, text=fmt.error_text(exc))
            return
        if answer.conversation_id:
            self.store.set_conversation(key, answer.conversation_id)
        slack.chat_postMessage(
            channel=channel, thread_ts=thread_ts, text=answer.answer or "Matih answered",
            blocks=fmt.answer_blocks(answer),
        )
        if answer.image_url:
            self.upload_image(slack, channel, thread_ts, answer.image_url, "chart.png", "Chart")

    def gems(self, slack: Any, channel: str, user: str, thread_ts: str | None) -> None:
        language = self.language_for(slack, user)
        try:
            listing = self.matih.gems.list(**self.opts(channel, language))
        except MitraError as exc:
            slack.chat_postMessage(channel=channel, thread_ts=thread_ts, text=fmt.error_text(exc))
            return
        if not listing.gems:
            slack.chat_postMessage(
                channel=channel, thread_ts=thread_ts,
                text=f"No Gems yet (state: {listing.state or 'unknown'}).",
            )
            return
        for gem in listing.gems[:MAX_GEMS]:
            slack.chat_postMessage(channel=channel, thread_ts=thread_ts, text=fmt.gem_text(gem))
            if gem.image_url:
                self.upload_image(slack, channel, thread_ts, gem.image_url, "gem.png", gem.headline)

    def dashboard(self, slack: Any, channel: str, user: str, name: str, thread_ts: str | None) -> None:
        opts = self.opts(channel, self.language_for(slack, user))
        try:
            listing = self.matih.dashboards.list(**opts)
            if not name:
                titles = ", ".join(d.title or d.id for d in listing.dashboards) or "none"
                slack.chat_postMessage(channel=channel, thread_ts=thread_ts,
                                       text=f"Which dashboard? Available: {titles}")
                return
            found = fmt.match_name(listing.dashboards, name)
            if not found:
                slack.chat_postMessage(channel=channel, thread_ts=thread_ts,
                                       text=f"I could not find a dashboard like '{name}'.")
                return
            slack.chat_postMessage(channel=channel, thread_ts=thread_ts,
                                   text=f"Rendering {found.title}...")
            png = self.matih.dashboards.render(found.id, **opts)
        except MitraError as exc:
            slack.chat_postMessage(channel=channel, thread_ts=thread_ts, text=fmt.error_text(exc))
            return
        slack.files_upload_v2(channel=channel, thread_ts=thread_ts, file=png,
                              filename="dashboard.png", title=found.title)

    def forecast(self, slack: Any, channel: str, user: str, question: str, thread_ts: str | None) -> None:
        if not question:
            slack.chat_postMessage(channel=channel, thread_ts=thread_ts,
                                   text="Usage: `/matih forecast <question>`")
            return
        opts = self.opts(channel, self.language_for(slack, user))
        try:
            # background=True returns the queued Job at once; create() would otherwise wait for it.
            job = self.matih.predictions.create(question, background=True, **opts)
        except MitraError as exc:
            slack.chat_postMessage(channel=channel, thread_ts=thread_ts, text=fmt.error_text(exc))
            return
        posted = slack.chat_postMessage(
            channel=channel, thread_ts=thread_ts,
            text="Forecast started. This can take a few minutes; I will update this message.",
        )
        ts = posted["ts"]

        def finish() -> None:
            try:
                # A prediction usually takes one to five minutes; the server gives up after 30.
                done = self.matih.jobs.wait(
                    job,
                    timeout=31 * 60,
                    on_update=lambda j: log.info("job %s %s", j.id, j.state),
                    **{k: v for k, v in opts.items() if k == "workspace_id"},
                )
            except MitraError as exc:
                slack.chat_update(channel=channel, ts=ts, text=fmt.error_text(exc))
                return
            # A finished prediction's result is {conversation_id, answer}; answer is text.
            result = done.result or {}
            slack.chat_update(channel=channel, ts=ts, text=result.get("answer") or "Forecast ready.")

        threading.Thread(target=finish, daemon=True).start()

    def workspace(self, slack: Any, channel: str, thread_ts: str | None) -> None:
        try:
            listing = self.matih.workspaces.list()
        except MitraError as exc:
            slack.chat_postMessage(channel=channel, thread_ts=thread_ts, text=fmt.error_text(exc))
            return
        chosen = self.store.get_workspace(channel) or listing.current
        lines = [
            f"{'*' if w.id == chosen else '-'} {w.name} ({w.role or 'member'})"
            for w in listing.workspaces
        ]
        blocks: list[dict[str, Any]] = [
            {"type": "section", "text": {"type": "mrkdwn",
                                         "text": "*Workspaces for this channel*\n" + "\n".join(lines)}}
        ]
        others = [w for w in listing.workspaces if w.id != chosen]
        if others:
            blocks.append({"type": "actions", "elements": [
                {"type": "button", "text": {"type": "plain_text", "text": f"Use {w.name}"[:70]},
                 "action_id": f"matih_switch_{i}", "value": w.id}
                for i, w in enumerate(others[:5])
            ]})
        else:
            blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text":
                "Only one workspace is reachable with this credential (API keys are pinned to one)."}]})
        slack.chat_postMessage(channel=channel, thread_ts=thread_ts, text="Workspaces", blocks=blocks)

    def upload_image(self, slack: Any, channel: str, thread_ts: str | None, url: str,
                     filename: str, title: str | None) -> None:
        try:
            slack.files_upload_v2(channel=channel, thread_ts=thread_ts,
                                  file=self.matih.download_image(url), filename=filename,
                                  title=title or filename)
        except Exception:  # the text answer already went out
            log.exception("could not upload image")


def build_matih_client() -> Mitra:
    token = os.environ.get("MATIH_ACCESS_TOKEN")
    if token:
        return Mitra(access_token=token, base_url=os.environ.get("MATIH_BASE_URL"))
    return Mitra(os.environ["MATIH_API_KEY"], base_url=os.environ.get("MATIH_BASE_URL"))


def create_app(bot: MatihBot) -> Any:
    from slack_bolt import App

    app = App(token=os.environ["SLACK_BOT_TOKEN"])

    @app.command("/matih")
    def on_command(ack, command, client):
        ack()
        channel, user = command["channel_id"], command["user_id"]
        verb, rest = fmt.parse_command(command.get("text", ""))
        if verb == "help":
            client.chat_postEphemeral(channel=channel, user=user, text=fmt.HELP_TEXT)
        elif verb == "ask":
            if not rest:
                client.chat_postEphemeral(channel=channel, user=user, text="Usage: `/matih ask <question>`")
                return
            posted = client.chat_postMessage(channel=channel, text=f"<@{user}> asked: {rest}")
            bot.ask(client, channel, user, rest, posted["ts"])
        elif verb == "gems":
            bot.gems(client, channel, user, None)
        elif verb == "dashboard":
            bot.dashboard(client, channel, user, rest, None)
        elif verb == "forecast":
            bot.forecast(client, channel, user, rest, None)
        elif verb == "workspace":
            bot.workspace(client, channel, None)

    @app.event("app_mention")
    def on_mention(event, client):
        question = fmt.strip_mention(event.get("text", ""))
        thread_ts = event.get("thread_ts") or event["ts"]
        if not question:
            client.chat_postMessage(channel=event["channel"], thread_ts=thread_ts, text=fmt.HELP_TEXT)
            return
        bot.ask(client, event["channel"], event["user"], question, thread_ts)

    @app.action({"action_id": r"matih_clarify_\d+"})
    def on_clarify(ack, body, action, client):
        ack()
        payload = json.loads(action["value"])
        channel = body["channel"]["id"]
        message = body.get("message", {})
        thread_ts = message.get("thread_ts") or message.get("ts")
        bot.ask(client, channel, body["user"]["id"], payload["o"], thread_ts,
                conversation_id=payload.get("c"))

    @app.action({"action_id": r"matih_switch_\d+"})
    def on_switch(ack, body, action, client):
        ack()
        channel = body["channel"]["id"]
        bot.store.set_workspace(channel, action["value"])
        client.chat_postMessage(channel=channel, text="This channel now uses that workspace.")

    return app


def main() -> None:
    from dotenv import load_dotenv
    from slack_bolt.adapter.socket_mode import SocketModeHandler

    load_dotenv()
    logging.basicConfig(level=logging.INFO)
    bot = MatihBot(build_matih_client(), Store(os.environ.get("MATIH_BOT_DB", "matih_bot.sqlite3")))
    SocketModeHandler(create_app(bot), os.environ["SLACK_APP_TOKEN"]).start()


if __name__ == "__main__":
    main()
