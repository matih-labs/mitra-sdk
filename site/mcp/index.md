# Matih as an MCP server

Matih hosts a [Model Context Protocol](https://modelcontextprotocol.io) server so AI assistants (Claude, Cursor, VS Code, ChatGPT and any other MCP client) can ask questions of your data, read Gems, render dashboards and run forecasts, as tools. It is the same set of operations as the REST API, with the same scopes, the same workspace role checks, the same credits and the same metering.

!!! info "You need"
    - A Matih workspace, and either an **MCP connector key** (an owner or admin makes one under Settings › API & MCP) or a Matih account to sign in with (OAuth).

| | |
|---|---|
| URL | `https://workspace.matih.ai/api/v1/mcp` |
| Transport | MCP streamable HTTP (spec 2025-06-18 and later) |
| Auth | `Authorization: Bearer <credential>` on every request |
| Images | returned as MCP image content |

## Pick a way to authenticate

| Credential | Good for | Workspace |
|---|---|---|
| **MCP connector key** (`mtk_...`, kind "MCP connector") | Headless agents, CI, shared team setups. Accepted **only** on `/api/v1/mcp`, never on the REST routes, so a leaked connector key cannot call the rest of the API. | Pinned to the workspace it was made in. |
| **API key** (`mtk_...`, kind "API key") | Works on MCP as well as all of `/api/v1`. Prefer a connector key if the key is only for an assistant. | Pinned. |
| **OAuth** (`mto_...`) | Interactive clients. You sign in once in the browser; the client discovers the sign-in from the `401`'s `WWW-Authenticate` header and the well-known metadata, and registers itself. Acts as you. | Your current workspace; the `use_workspace` tool changes it, and `X-Matih-Workspace` picks one per request. |

!!! tip "Let the app write the config for you"
    Settings › API & MCP shows ready-to-copy configs for Claude Code, Claude Desktop, Cursor and VS Code, with your workspace's address and the new key filled in, and only the products you enabled. The pages in this section give the same configs by hand.

## Create a connector key

1. In Matih open **Settings › API & MCP** (owners and admins).
2. Choose **MCP connector**.
3. Pick the products the assistant may use. All are on by default: Ask, Data sources, Files, Predictive analytics, Dashboards, Gems, Workspaces, Users & members, Webhooks. Each product with writes has an **Allow changes** switch. Keep it off for a read-only assistant.
4. Optionally set an expiry (none by default).
5. Copy the secret now. It is shown once and stored only as a hash.

Keep the key in an environment variable or secret store, never in a committed file. See [Security](../security.md).

## Set up your client

- [Claude Code](claude-code.md)
- [Claude Desktop](claude-desktop.md)
- [Cursor](cursor.md)
- [VS Code](vscode.md)
- Any other client: use the generic JSON below.

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

## What the assistant can do

One tool per operation: ask, forecast, read Gems, render a dashboard, list sources and files, list workspaces, and (with the right scopes and an admin acting) list and invite members. The [tools table](tools.md) has each tool's scope and cost.

`tools/list` offers only the tools the credential may call. Switch a product off for a key and its tools disappear from the list for that key.

## How it behaves

- **Stateless.** Every `POST` is a complete exchange with a plain JSON response. There are no sessions to keep or end, so any replica answers any call. `GET` and `DELETE` answer `405` with `Allow: POST`.
- **Metered.** Requests count as channel `mcp` on every metric, audit row and credit entry. `ask`, `predict` and `generate_gems` spend credits from the workspace pool, as in the app.
- **Role-checked every call.** The workspace role of the person the credential acts as is checked on each call. A key never outlives the membership or exceeds the role of its member.
- **Support sessions are refused.** Staff viewing as a customer cannot use MCP tools as that customer.
- **Errors are tool errors** (`isError: true`) in Matih's own words: a missing scope, a role refusal, an empty credit pool or a member's monthly cap, a source the member may not use. A missing or bad credential is an HTTP `401` with `WWW-Authenticate: Bearer`.

## Smoke test with curl

```bash
curl -s https://workspace.matih.ai/api/v1/mcp \
  -H "Authorization: Bearer $MATIH_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

List the tools your key sees:

```bash
curl -s https://workspace.matih.ai/api/v1/mcp \
  -H "Authorization: Bearer $MATIH_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

## Using MCP from your own agent

=== "Python (OpenAI Agents SDK)"

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

=== "ChatGPT"

    ChatGPT developer mode lets you add a remote MCP server by URL (`https://workspace.matih.ai/api/v1/mcp`) with OAuth. Availability depends on your plan.

=== "claude.ai"

    1. Open Settings, then Connectors, then Add custom connector.
    2. Name: `Matih`. URL: `https://workspace.matih.ai/api/v1/mcp`.
    3. Save, then Connect. Sign in to Matih when the browser opens and approve access.
    4. Enable the connector in a chat from the tools menu.

    Availability of custom connectors depends on your Claude plan and, on team plans, on an owner enabling them.

## Related

- [Tools](tools.md)
- [Agent skill](../skill.md): teach an agent how to use the REST API and MCP well.
- [Credentials and products](../concepts/credentials.md), [Scopes](../concepts/scopes.md)
- [OAuth for multi-user apps](../guides/oauth.md)
