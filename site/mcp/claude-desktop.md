# Claude Desktop

!!! info "You need"
    A Matih MCP connector key (Settings › API & MCP) for the config-file route, or a Matih account for the connector route. See [MCP overview](index.md).

## Easiest: a custom connector (OAuth)

1. Open Settings, then Connectors, then **Add custom connector**.
2. Name: `Matih`. URL: `https://workspace.matih.ai/api/v1/mcp`.
3. Save, then **Connect**. Sign in to Matih when the browser opens and approve access.
4. Enable the connector in a chat from the tools menu.

Availability of custom connectors depends on your Claude plan and, on team plans, on an owner enabling them. The same steps work on claude.ai.

## With a connector key, through `mcp-remote`

The config file route needs Node.js, because Claude Desktop talks to remote servers through the `mcp-remote` bridge. Edit `claude_desktop_config.json` (Settings, Developer, Edit Config):

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
        "Authorization:${MATIH_AUTH}"
      ],
      "env": { "MATIH_AUTH": "Bearer mtk_REPLACE_ME" }
    }
  }
}
```

The `Authorization:${MATIH_AUTH}` form (no space after the colon) avoids a known quoting problem with spaces in arguments on some systems; the value with `Bearer ` lives in `env`.

Restart Claude Desktop after saving. The Matih tools appear under the tools icon in a new chat.

!!! warning
    `claude_desktop_config.json` is a plain file. Anyone who can read your user account can read the key. Use a connector key with only the products you need and **Allow changes** off, and rotate it from Settings › API & MCP if a laptop is lost.

## Try it

> List my Matih data sources, then show me last month's revenue by region as a chart.

Claude calls `list_sources` and `ask`. The chart comes back as an image in the chat.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Server fails to start | Node.js is not installed or not on `PATH` for the app. |
| `401` | Wrong or revoked key, or `Bearer ` missing in the env value. |
| No tools | The key's products are all off, or the config JSON has a syntax error. |

## Related

[Tools](tools.md), [Claude Code](claude-code.md), [Cursor](cursor.md), [VS Code](vscode.md)
