# VS Code

!!! info "You need"
    A Matih MCP connector key (Settings › API & MCP), or a Matih account for OAuth. See [MCP overview](index.md). Requires a VS Code version with MCP support (GitHub Copilot agent mode).

Create `.vscode/mcp.json` in the workspace (or run **MCP: Add Server** from the command palette).

## With a connector key, prompted so it is never stored

```json
{
  "inputs": [
    { "type": "promptString", "id": "matih-key", "description": "Matih MCP key", "password": true }
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

VS Code asks for the key the first time the server starts and keeps it out of the file, so the file is safe to commit.

## With OAuth sign-in

Omit `headers` and `inputs`:

```json
{
  "servers": {
    "matih": {
      "type": "http",
      "url": "https://workspace.matih.ai/api/v1/mcp"
    }
  }
}
```

VS Code starts the sign-in in the browser when the server first needs it.

## Use it

Open Chat, switch to **Agent** mode, open the tools picker and check that Matih's tools are enabled. Then:

> Using Matih, what is the total sales this month, by region?

## Note on the config shape

VS Code uses a top-level `servers` key. Cursor and Claude use `mcpServers`. Do not paste one client's file into another.

## Troubleshooting

Use **MCP: List Servers**, then **Show Output** for the server to see the `401` or network error. A `401` means the key is wrong, revoked or expired; delete the saved input (**MCP: Reset Cached Inputs**) and start the server again.

## Related

[Tools](tools.md), [Claude Code](claude-code.md), [Cursor](cursor.md)
