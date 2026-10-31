# Cursor

!!! info "You need"
    A Matih MCP connector key (Settings › API & MCP), or a Matih account for OAuth. See [MCP overview](index.md).

Open Settings, MCP, **Add new server**, or edit the config file directly: `~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` inside one project.

## With a connector key

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

`${env:MATIH_API_KEY}` reads the key from the environment Cursor was started in, so nothing secret sits in the file. If you launch Cursor from the dock, make sure the variable is set for GUI apps, or start Cursor from a terminal.

## With OAuth sign-in

```json
{
  "mcpServers": {
    "matih": { "url": "https://workspace.matih.ai/api/v1/mcp" }
  }
}
```

Cursor shows a **Connect** or **Needs login** state for the server; click it, sign in to Matih in the browser and approve.

## Use it

In Agent mode:

> Ask Matih which products grew fastest last quarter and show the chart.

Cursor lists the Matih tools it may call; approve `ask` the first time.

## Project rule for teams

If the config is committed as `.cursor/mcp.json`, keep the header on `${env:...}` as above so each person uses their own key.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Red status dot | `401` (key wrong or unset in Cursor's environment) or no network. |
| Fewer tools than expected | Products are switched off for the key. Edit it in Settings › API & MCP. |

## Related

[Tools](tools.md), [Claude Code](claude-code.md), [VS Code](vscode.md)
