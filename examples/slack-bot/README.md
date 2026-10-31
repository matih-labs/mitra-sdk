<p align="center"><img src="https://raw.githubusercontent.com/matih-labs/mitra-sdk/main/assets/matih-logo.png" alt="Matih" width="160"></p>

# Matih Slack bot

A reference Slack bot built on the [Python SDK](../../sdks/python). It runs in Socket Mode, so it
needs no public URL.

| In Slack | What happens |
|---|---|
| `/matih ask <question>` or `@Matih <question>` | Answer text, a table preview, follow-up suggestions, and the chart image uploaded to the thread. Replies in a thread keep the same conversation. |
| `/matih gems` | The latest Gems with their chart images |
| `/matih dashboard <name>` | The dashboard rendered as an image (fuzzy name match) |
| `/matih forecast <question>` | Starts a prediction job; the "started" message is updated with the answer when it finishes (usually one to five minutes, at most 30) |
| `/matih workspace` | Lists reachable workspaces, with buttons to choose one for this channel |

If Matih asks a clarifying question the bot shows the options as buttons. The Slack user's locale
(for example `hi-IN`) is passed as the response language, and questions in any of 22 Indian
languages work as typed.

## Setup (API-key mode)

1. Create a Slack app from [`manifest.yml`](manifest.yml) (Slack, Your Apps, Create New App, From
   a manifest). Install it, then copy the **Bot token** (`xoxb-`) and create an **App-level token**
   (`xapp-`) with the `connections:write` scope.
2. In Matih, as a workspace admin, create an API key under **Settings › API & MCP** with the
   scopes `workspaces:read`, `gems:read`, `ask`, `dashboards:read` and `predict`.
3. Configure and run:

   ```bash
   cd examples/slack-bot
   python -m venv .venv && . .venv/bin/activate
   pip install -r requirements.txt
   cp .env.example .env     # fill in the three tokens; never commit .env
   python app.py
   ```

Invite the bot to a channel (`/invite @Matih`) and try `/matih ask how many orders today`.

All requests act as the member who created the key and never exceed their role. Anyone in the
Slack channels where you install the bot can ask questions of that workspace's data, so add it
only to channels whose members may see that data.

Workspace choice per channel is stored in a small sqlite file (`MATIH_BOT_DB`, default
`matih_bot.sqlite3`), along with Slack thread to `conversation_id` mappings. An API key is pinned
to one workspace, so with a key `/matih workspace` shows that single workspace; to let channels
switch between several workspaces use an OAuth token (below).

## Per-user mode with OAuth (optional)

For a bot where each Slack user sees only their own data, use OAuth 2.1 instead of one shared key:

1. Register the bot as an OAuth client with dynamic client registration
   (`POST /api/v1/oauth/register`). Discovery documents are at
   `https://workspace.matih.ai/.well-known/oauth-authorization-server` and
   `/.well-known/oauth-protected-resource`.
2. When a user first runs `/matih`, reply with an authorization link
   (`/api/v1/oauth/authorize`, authorization code with PKCE `S256`; store the `code_verifier`
   against their Slack user id). Ask for the scopes the bot uses in `scope`: the default is
   read and ask only, so add `predict` for `/matih forecast`. Your redirect URL receives the
   code and exchanges it at `/api/v1/oauth/token` for an access token (`mto_...`, valid one
   hour) and a rotating refresh token (`mtr_...`, valid 30 days from its last use).
3. Keep one token pair per Slack user (encrypted at rest). Each refresh returns a new refresh
   token and retires the old one, so save the answer before using it: presenting an old refresh
   token revokes the whole grant. Refresh before the hour is up, and construct
   `Mitra(access_token=user_token, workspace_id=...)` per request instead of the shared client.
   OAuth tokens may reach several workspaces, so `/matih workspace` then lets each channel or
   user switch.

The shared-key mode above is the one this example implements end to end.

## Tests

```bash
pip install -r requirements.txt
pytest -q
```

The tests cover command parsing, Slack block building, fuzzy dashboard matching and the sqlite
store; they do not need Slack or network access.
