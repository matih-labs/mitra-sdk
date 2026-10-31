<p align="center"><img src="https://raw.githubusercontent.com/matih-labs/mitra-sdk/main/assets/matih-logo.png" alt="Matih" width="160"></p>

# Matih MCP server

Matih hosts a Model Context Protocol server so AI assistants can ask questions of your data, read Gems, render dashboards and run forecasts.

- Endpoint: `https://workspace.matih.ai/api/v1/mcp`
- Transport: streamable HTTP, stateless. Every `POST` is a complete exchange with no session to keep; `GET` and `DELETE` answer `405`.
- Auth: OAuth 2.1 (auto-discovered by most clients) or `Authorization: Bearer mtk_...` (an API key or an MCP connector key)
- Images come back as MCP image content

OAuth discovery documents, if your client asks for them:

- `https://workspace.matih.ai/.well-known/oauth-authorization-server`
- `https://workspace.matih.ai/.well-known/oauth-protected-resource`
- `https://workspace.matih.ai/.well-known/oauth-protected-resource/api/v1/mcp`

Clients that support MCP authorization find the sign-in from the `WWW-Authenticate` header of the `401` and register themselves (dynamic client registration), so you rarely need these by hand.

## Which auth to use

- OAuth: best for interactive clients. You sign in once in the browser and the client handles tokens. It acts as you (an `mto_` access token), and you pick the workspace with `use_workspace` (or the `X-Matih-Workspace` header).
- MCP connector key: best for MCP clients that take a header or token, and for headless agents and CI. An admin creates it in Matih under `Settings › API & MCP`. A connector key works only on `/api/v1/mcp` and returns 403 elsewhere. It is pinned to one workspace and acts as its creator, never exceeding that member's role.
- API key: also works on the MCP endpoint, and additionally on all of `/api/v1`. Prefer a connector key when the key is only for an MCP client.

Admins choose the products a key may use (Ask, Data sources, Files, Predictive, Dashboards, Gems, Workspaces, Users & members, Webhooks; all on by default). A product that is switched off takes its scopes away, and its tools disappear from `tools/list` for that key. Keys never expire by default; revoke them in the same screen.

A Support View or Assisted Support session is refused on this endpoint (`403 support_view`).

Keep keys in environment variables. Never commit them.

## Claude (claude.ai custom connector)

1. Open Settings, then Connectors, then Add custom connector.
2. Name: `Matih`. URL: `https://workspace.matih.ai/api/v1/mcp`.
3. Save, then Connect. Sign in to Matih when the browser opens and approve access.
4. Enable the connector in a chat from the tools menu.

Availability of custom connectors depends on your Claude plan and, for team plans, on an owner enabling them.

## Claude Code

OAuth (a browser sign-in is started from `/mcp`):

```bash
claude mcp add --transport http matih https://workspace.matih.ai/api/v1/mcp
```

Then run `/mcp` inside Claude Code and choose Authenticate for `matih`.

API key header:

```bash
export MATIH_API_KEY=mtk_...
claude mcp add --transport http matih https://workspace.matih.ai/api/v1/mcp \
  --header "Authorization: Bearer $MATIH_API_KEY"
```

Add `--scope user` to make it available in every project, or `--scope project` to write it to a shared `.mcp.json`. Do not put a literal key in a committed `.mcp.json`; use environment variable expansion (`${MATIH_API_KEY}`).

## Claude Desktop

Easiest: add Matih as a custom connector in Settings, Connectors, exactly as for claude.ai.

Using the config file with an API key, through the `mcp-remote` bridge (needs Node.js). Edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "matih": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://workspace.matih.ai/api/v1/mcp",
        "--header",
        "Authorization: Bearer ${MATIH_API_KEY}"
      ],
      "env": { "MATIH_API_KEY": "mtk_..." }
    }
  }
}
```

Restart Claude Desktop after saving.

## Cursor

Settings, MCP, Add new server, or edit `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project).

OAuth:

```json
{
  "mcpServers": {
    "matih": { "url": "https://workspace.matih.ai/api/v1/mcp" }
  }
}
```

API key:

```json
{
  "mcpServers": {
    "matih": {
      "url": "https://workspace.matih.ai/api/v1/mcp",
      "headers": { "Authorization": "Bearer ${env:MATIH_API_KEY}" }
    }
  }
}
```

## VS Code

Create `.vscode/mcp.json` (or run "MCP: Add Server" from the command palette):

```json
{
  "inputs": [
    { "type": "promptString", "id": "matih-key", "description": "Matih API key", "password": true }
  ],
  "servers": {
    "matih": {
      "type": "http",
      "url": "https://workspace.matih.ai/api/v1/mcp",
      "headers": { "Authorization": "Bearer ${input:matih-key}" }
    }
  }
}
```

Omit `headers` and `inputs` to use OAuth. The prompt keeps the key out of the file.

## ChatGPT and the OpenAI Agents SDK

ChatGPT developer mode lets you add a remote MCP server by URL (`https://workspace.matih.ai/api/v1/mcp`) with OAuth. Availability depends on your plan.

OpenAI Agents SDK (Python), using an API key:

```python
import asyncio
import os

from agents import Agent, Runner
from agents.mcp import MCPServerStreamableHttp


async def main():
    async with MCPServerStreamableHttp(
        name="matih",
        params={
            "url": "https://workspace.matih.ai/api/v1/mcp",
            "headers": {"Authorization": f"Bearer {os.environ['MATIH_API_KEY']}"},
        },
        cache_tools_list=True,
    ) as matih:
        agent = Agent(
            name="Analyst",
            instructions=(
                "Answer data questions with the Matih tools. "
                "Call list_sources first, reuse conversation_id for follow-ups, "
                "and report clarification, empty and error results honestly."
            ),
            mcp_servers=[matih],
        )
        result = await Runner.run(agent, "What were our top 5 products by revenue last month?")
        print(result.final_output)


asyncio.run(main())
```

## Generic client config (API key)

For any client that takes an `mcpServers` JSON with a remote URL and headers:

```json
{
  "mcpServers": {
    "matih": {
      "type": "http",
      "url": "https://workspace.matih.ai/api/v1/mcp",
      "headers": { "Authorization": "Bearer mtk_REPLACE_ME" }
    }
  }
}
```

Replace the placeholder with your key from an environment variable or secret store where the client supports it.

## Tools

| Tool | Arguments | Scope | What it does |
| --- | --- | --- | --- |
| `list_workspaces` | none | `workspaces:read` | Lists the workspaces you belong to, your role in each, and which is current. |
| `use_workspace` | `workspace_id` | `workspaces:read` | Makes a workspace the one later calls work in. OAuth sessions only: an API key is pinned to its workspace. |
| `list_members` | none | `members:read` | Lists the people in the current workspace with their roles. |
| `invite_member` | `email` or `phone` (exactly one); optional `role` (`viewer`, `user`, `admin`; default `user`) | `members:manage` | Invites someone. Needs an admin or owner, and the role cannot be higher than your own. Messages a third party: use only when explicitly asked. |
| `list_sources` | none | `sources:read` | Lists the data sources you may use, with id, name, kind and whether each is active. |
| `source_status` | `source_id` | `sources:read` | Says whether Matih has finished reading a source so `ask` can use it: its state, what is still being prepared, any error. |
| `list_files` | none | `files:read` | Lists uploaded files and whether Matih has finished reading them. |
| `ask` | `question`; optional `conversation_id`, `source_id`, `language` | `ask` | Asks a question. Returns the answer in words, the first 50 rows as a markdown table, and the chart as an image when there is one. Costs credits, 5 to 30 seconds. Pass the returned `conversation_id` for a follow-up. If Matih needs to know which of several things you mean, it answers with a clarifying question: relay it and ask again. |
| `list_gems` | optional `source_id` | `gems:read` | Lists the Gems (the numbers and trends Matih found on its own). Does not generate new ones. |
| `get_gem` | `gem_id` | `gems:read` | Returns one Gem in full, with its picture as image content. |
| `generate_gems` | optional `source_id` | `gems:generate` | Asks Matih to write new Gems. Returns a job; poll `get_job`, then `list_gems`. Costs credits, takes a minute to several. |
| `list_dashboards` | none | `dashboards:read` | Lists your dashboards. |
| `dashboard_image` | `dashboard_id` | `dashboards:read` | Renders a dashboard as a PNG. Waits up to 20 seconds and returns the image plus a link valid for about 15 minutes; if it is not ready, returns a job id to poll with `get_job`. Free. |
| `predict` | `question`; optional `source_id`, `language` | `predict` | Starts a forecast, anomaly check, segmentation or what-if. Returns a job id at once; it takes one to five minutes and costs credits. Do not start the same prediction twice. |
| `get_job` | `job_id` | any one of `ask`, `predict`, `gems:generate`, `dashboards:read` | Returns a job's state (`queued`, `running`, `succeeded`, `failed`, `cancelled`) and, when finished, its result and any picture. |

Argument names follow the REST API. Check the tool schema your client shows if a name differs. A scope only narrows: the workspace role is checked first, so `invite_member` needs an admin whatever the key's scopes say. A call without the needed scope gets a tool error naming the scope, and nothing runs.

File upload is not a tool because it is binary: upload with `POST /api/v1/files` (multipart) on the REST API, then check it with `list_files` or `source_status`.

These are REST only: cancelling jobs, creating, testing, activating and deleting sources, uploading and deleting files, resolving duplicate files, changing roles, removing members, revoking invitations, voice questions (`/ask/audio`) and webhooks. See `../examples/curl/README.md`.

Admin tools such as `invite_member` change real access. Clients that auto-approve tool calls should keep them on manual approval.

## Troubleshooting

401 Unauthorized
: The key is wrong or revoked (keys do not expire by default), or the OAuth token expired. For an API key or connector key, create a new one and update your config. For OAuth, re-authenticate (in Claude Code run `/mcp` then Authenticate; in other clients remove and re-add the connector). Check there are no stray spaces or quotes in the header value, and that the header reads `Authorization: Bearer mtk_...`.

Wrong workspace or "source not found"
: OAuth sessions use your default workspace. Call `list_workspaces`, then `use_workspace`, then `list_sources` again; source ids differ per workspace. An API key is pinned to the workspace it was created in. To use another workspace, create a key there. A 404 usually means a source id from a different workspace; a 403 with category `source_access` means you may not use that source.

Tool missing or "needs the scope ..."
: The key's products leave that tool out (`tools/list` shows only what the credential may call), or the credential lacks the scope (for example `predict` or `gems:generate`). Ask an admin to switch the product on in `Settings › API & MCP`, or reconnect OAuth and approve the requested scopes. Failures from the tools come back as MCP tool errors (`isError: true`) in plain words.

403 on a non-MCP path
: A connector key works only on `/api/v1/mcp`. Use an API key for other `/api/v1` endpoints.

403 workspace_role
: Your role in that workspace is too low for the action. Ask a workspace admin.

402
: The workspace has no Matih Credits left (category `not_ready`), or the member reached the monthly credit cap an admin set (category `member_cap`). An admin must fix it.

Images not shown
: Some clients do not render MCP image content. The tool result also carries a link to the picture, valid for about 15 minutes; open it in a browser or download it promptly. If it has expired, request the image again.

429 Too Many Requests
: Rate limited. Wait for the `Retry-After` seconds, then retry. Do not start the same prediction twice while waiting.

Job never finishes
: Predictions take one to five minutes and Gems a minute to several; poll `get_job` every 10 to 15 seconds, not faster. A `failed` or `cancelled` job comes back as a tool error with the reason.

Tools do not appear
: Confirm the URL is exactly `https://workspace.matih.ai/api/v1/mcp` with transport `http` (streamable HTTP, not SSE or stdio), then restart the client.
