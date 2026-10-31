# Build a Slack bot

The repository ships a complete reference Slack bot in [`examples/slack-bot`](https://github.com/matih-labs/mitra-sdk/tree/main/examples/slack-bot). It is a few hundred lines of Python on top of `mitra-sdk` and Slack Bolt, runs in Socket Mode (no public URL needed) and covers the whole product: questions with chart images, Gems, dashboard images, forecasts and workspace switching.

This page gets it running, then walks through the parts you will copy into your own bot.

!!! info "You need"
    - Products on the key: **Ask** (`ask`), **Gems** (`gems:read`), **Dashboards** (`dashboards:read`), **Predictive analytics** (`predict`) and **Workspaces** (`workspaces:read`). None needs **Allow changes**: the bot only reads and asks.
    - A Slack workspace where you may install apps.
    - Python 3.10 or newer.

    The key is created by a workspace owner or admin under **Settings › API & MCP**. See [Credentials and products](../concepts/credentials.md).

| In Slack | What happens |
|---|---|
| `/matih ask <question>` or `@Matih <question>` | Answer text, a table preview, follow-up suggestions and the chart image in the thread. Replies in a thread keep the same conversation |
| `/matih gems` | The latest Gems with their chart images |
| `/matih dashboard <name>` | The dashboard rendered as an image (fuzzy name match) |
| `/matih forecast <question>` | Starts a prediction job; the "started" message is updated with the result when it finishes |
| `/matih workspace` | Lists reachable workspaces, with buttons to choose one for this channel |

## 1. Create the Slack app from the manifest

In Slack go to **Your Apps, Create New App, From a manifest** and paste this. It turns on Socket Mode, the `/matih` slash command, the `app_mention` event and interactivity (for buttons).

```yaml
--8<-- "examples/slack-bot/manifest.yml"
```

Install the app to your workspace and copy the **Bot token** (`xoxb-...`). Then create an **App-level token** (`xapp-...`) with the `connections:write` scope.

## 2. Create the Matih key

In Matih, as a workspace owner or admin, open **Settings › API & MCP** and create an **API key** with the products above. Copy it now; it is shown once and stored only as a hash.

## 3. Run it

```bash
git clone https://github.com/matih-labs/mitra-sdk.git
cd mitra-sdk/examples/slack-bot
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env     # fill in the three tokens; never commit .env
python app.py
```

`.env` holds:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
MATIH_API_KEY=mtk_...
# optional
# MATIH_ACCESS_TOKEN=mto_...      # instead of the key, to allow switching workspaces
# MATIH_BASE_URL=https://workspace.matih.ai   # host only
# MATIH_BOT_DB=matih_bot.sqlite3
```

Invite the bot to a channel (`/invite @Matih`) and try `/matih ask how many orders today`.

!!! warning "Who can ask"
    A shared key acts as the member who created it, and anyone in a channel where the bot is installed can ask questions of that workspace's data. Add the bot only to channels whose members may see that data, or use per-user OAuth (below).

## How it works

### One client, built from the environment

```python
from mitra import Mitra

def build_matih_client() -> Mitra:
    token = os.environ.get("MATIH_ACCESS_TOKEN")
    if token:
        return Mitra(access_token=token)       # OAuth token: may reach several workspaces
    return Mitra(os.environ["MATIH_API_KEY"])  # API key: pinned to one workspace
```

An API key is pinned to one workspace, so `/matih workspace` shows that single workspace. An OAuth access token can reach several, and the bot then lets each channel pick. See [Switch workspaces](switch-workspaces.md).

### Questions, conversations and threads

The bot keeps a map from "channel plus thread" (or "channel plus user" for a slash command) to Matih's `conversation_id`, so replies in a thread are follow-ups:

```python
def ask(self, slack, channel, user, question, thread_ts, conversation_id=None):
    key = f"{channel}:{thread_ts or user}"
    conversation_id = conversation_id or self.store.get_conversation(key)
    answer = self.matih.ask(question, conversation_id=conversation_id,
                            language=self.language_for(slack, user))
    if answer.conversation_id:
        self.store.set_conversation(key, answer.conversation_id)
    slack.chat_postMessage(channel=channel, thread_ts=thread_ts,
                           text=answer.answer, blocks=fmt.answer_blocks(answer))
    if answer.image_url:
        png = self.matih.download_image(answer.image_url)
        slack.files_upload_v2(channel=channel, thread_ts=thread_ts, file=png,
                              filename="chart.png", title="Chart")
```

The mapping lives in a tiny sqlite file (`store.py`, table `conversation`) and expires after six hours. For several bot replicas use a shared database.

The chart is an `image_url`, a signed link valid for 15 minutes. Slack cannot unfurl it reliably, so the bot downloads the PNG straight away and uploads it as a file. See [Images](../concepts/images.md).

### Language follows the Slack user

Every Slack user has a locale. The bot reads it once with `users.info` and passes it as `language`, so a person whose Slack is set to `hi-IN` gets Hindi sentences around the same numbers. Questions typed in any of the 22 supported languages work as written; no translation happens on the bot's side. See [Multilingual bots](multilingual.md).

```python
info = slack.users_info(user=user_id, include_locale=True)
language = info["user"].get("locale")        # "hi-IN", "en-US", ...
```

### Clarifications become buttons

When Matih needs more information it returns `status: "clarification"` with options. `fmt.answer_blocks` turns each option into a button carrying a small JSON payload (the option text and the conversation id). Clicking one sends the option as the next question in the same conversation:

```python
@app.action({"action_id": r"matih_clarify_\d+"})
def on_clarify(ack, body, action, client):
    ack()
    payload = json.loads(action["value"])     # {"o": option text, "c": conversation id}
    message = body.get("message", {})
    thread_ts = message.get("thread_ts") or message.get("ts")
    bot.ask(client, body["channel"]["id"], body["user"]["id"], payload["o"], thread_ts,
            conversation_id=payload.get("c"))
```

### Forecasts run in the background

A prediction can take up to 30 minutes, longer than Slack will hold a command open. The bot starts the job, posts a placeholder, then waits in a thread and updates the placeholder:

```python
job = self.matih.predictions.create(question, background=True)   # the queued Job, at once
posted = slack.chat_postMessage(channel=channel, text="Forecast started. I will update this message.")

def finish():
    done = self.matih.jobs.wait(job)                       # polls with backoff
    result = done.result or {}                             # {conversation_id, answer}
    slack.chat_update(channel=channel, ts=posted["ts"], text=result.get("answer") or "Forecast ready.")

threading.Thread(target=finish, daemon=True).start()
```

For a bot with many users, replace the polling thread with a `prediction.completed` [webhook](webhooks.md) so no thread waits at all. See [Predictive questions](predictive.md).

### Dashboards and Gems

```python
png = self.matih.dashboards.render(found.id)              # starts the job, waits, downloads bytes
slack.files_upload_v2(channel=channel, file=png, filename="dashboard.png", title=found.title)

listing = self.matih.gems.list()
for gem in listing.gems[:3]:
    slack.chat_postMessage(channel=channel, text=f"*{gem.headline}*\n{gem.explanation}")
```

More in [Dashboard image previews](dashboard-previews.md) and [Gems feed](gems-feed.md).

### Errors are one friendly line

Every Matih call sits in `try/except MitraError` and the message goes to the channel through `fmt.error_text`. The SDK's typed errors let you say something useful: `CreditsError` (402, tell an admin), `PermissionDeniedError` (403, a product is switched off for the key), `RateLimitError` (429, the SDK already waited and retried), `BusyError` (409, for example a prediction is still running in that conversation). See [Errors](../concepts/errors.md).

## Per-user mode with OAuth

A shared key means every Slack user sees the same data. For a bot where each person sees only their own, use [OAuth 2.1](oauth.md) instead of one key:

1. Register the bot as an OAuth client with dynamic client registration. Discovery documents are at `https://workspace.matih.ai/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`.
2. The first time someone runs `/matih`, reply with an authorization link (authorization code with PKCE; store the `code_verifier` against their Slack user id). Your redirect URL receives the code and exchanges it for an access token (`mto_...`) and a rotating refresh token (`mtr_...`).
3. Keep one token pair per Slack user, encrypted at rest, refresh before expiry, and build `Mitra(access_token=user_token, workspace_id=...)` per request instead of the shared client.

The example implements the shared-key mode end to end; the OAuth mode is described, not coded.

## Tests

```bash
pip install -r requirements.txt
pytest -q
```

The tests cover command parsing, Slack block building, fuzzy dashboard matching and the sqlite store. They need neither Slack nor network access.

## Where to go next

- A bot for a platform other than Slack: [Build a WhatsApp or Teams style bot](chat-bot.md).
- Scheduled digests: [Gems feed](gems-feed.md).
- The Python client in full: [Python SDK](../sdk/python.md).
