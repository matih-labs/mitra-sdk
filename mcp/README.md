# Matih MCP server

Matih hosts a Model Context Protocol server so AI assistants can ask questions of your data, read Gems, render dashboards and run forecasts.

- Endpoint: `https://workspace.matih.ai/api/v1/mcp`
- Transport: streamable HTTP
- Auth: OAuth 2.1 (auto-discovered by most clients) or `Authorization: Bearer mtk_...` (an API key)
- Images come back as MCP image content

OAuth discovery documents, if your client asks for them:

- `https://workspace.matih.ai/.well-known/oauth-authorization-server`
- `https://workspace.matih.ai/.well-known/oauth-protected-resource`

## Which auth to use

- OAuth: best for interactive clients. You sign in once in the browser and the client handles tokens. It uses your own Matih account and you pick the workspace with `use_workspace`.
- API key: best for headless agents and CI. An admin creates the key in Matih under Settings, Integrations. The key is pinned to one workspace and acts as its creator, never exceeding that member's role.

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

| Tool | Arguments | What it does |
| --- | --- | --- |
| `list_workspaces` | none | Lists workspaces you belong to and which is current. |
| `use_workspace` | `workspace_id` | Sets your default workspace (OAuth sessions; API keys are pinned). |
| `list_sources` | none | Lists data sources with `id`, `name`, `type`, `status`, `active`. |
| `ask` | `question`; optional `conversation_id`, `source_id`, `language` | Asks a question. Returns an answer with `status` (`answered`, `clarification`, `empty`, `error`), a result table, `sql`, `follow_ups`, `conversation_id`. |
| `list_gems` | optional `source_id` | Lists insight cards for a source. |
| `get_gem` | `gem_id` | Returns one gem, with its image. |
| `generate_gems` | `source_id` | Starts gem generation. Returns a job. Costs credits. |
| `list_dashboards` | none | Lists saved dashboards. |
| `dashboard_image` | `dashboard_id` | Renders a dashboard as an image. Returns the image, or a job to poll. |
| `predict` | `question`; optional `source_id`, `conversation_id` | Starts a forecast, model or what-if. Returns a job, up to 30 minutes. |
| `get_job` | `job_id` | Returns a job's `state`, `result` and `error`. |

Argument names follow the REST API. Check the tool schema your client shows if a name differs. Required scopes: `workspaces:read`, `sources:read`, `ask`, `gems:read`, `gems:generate`, `dashboards:read`, `predict`.

Job cancellation, file upload, adding sources and webhooks are available over REST only. See `../examples/curl/README.md`.

## Troubleshooting

401 Unauthorized
: The key is wrong, revoked or expired, or the OAuth token expired. For an API key, create a new one and update your config. For OAuth, re-authenticate (in Claude Code run `/mcp` then Authenticate; in other clients remove and re-add the connector). Check there are no stray spaces or quotes in the header value, and that the header reads `Authorization: Bearer mtk_...`.

Wrong workspace or "source not found"
: OAuth sessions use your default workspace. Call `list_workspaces`, then `use_workspace`, then `list_sources` again; source ids differ per workspace. An API key is pinned to the workspace it was created in. To use another workspace, create a key there. A 403 with category `source_access` usually means a source id from a different workspace.

403 scope
: The credential lacks a scope for that tool (for example `predict` or `gems:generate`). Re-issue the key with the needed scope, or reconnect OAuth and approve the requested scopes.

403 workspace_role
: Your role in that workspace is too low for the action. Ask a workspace admin.

402
: `credits` means the workspace is out of credits, `member_cap` means it is at its member limit. An admin must fix it.

Images not shown
: Some clients do not render MCP image content. The image is also available as a signed `image_url` valid for 15 minutes with no auth required; open it in a browser or download it promptly. If it has expired, request the image again.

409 busy
: Another request is already running in the same conversation or the same task. Wait a few seconds and retry. Do not send overlapping questions in one `conversation_id`.

429 Too Many Requests
: Rate limited. Wait for the `Retry-After` seconds, then retry. Use an `Idempotency-Key` on retries of credit-costing calls so you are not charged twice.

Job never finishes
: Predictions can take up to 30 minutes; poll `get_job` sparingly (every 15 to 60 seconds after the first minute). Dashboard images and gems normally finish in minutes.

Tools do not appear
: Confirm the URL is exactly `https://workspace.matih.ai/api/v1/mcp` with transport `http` (streamable HTTP, not SSE or stdio), then restart the client.
