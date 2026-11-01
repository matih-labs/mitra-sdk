<p align="center"><img src="https://raw.githubusercontent.com/matih-labs/mitra-sdk/main/assets/matih-logo.png" alt="Matih" width="160"></p>

# Matih skill

An agent skill that teaches an AI assistant to use Matih well: ask questions of a workspace's data, read Gems, render dashboards, run forecasts, and (only when asked) manage members, sources and files. It works through the hosted MCP tools (`https://workspace.matih.ai/api/v1/mcp`) or the REST API (`https://workspace.matih.ai/api/v1`).

- `SKILL.md`: the entry point (when to use it, the default flow, rules for agents).
- `references/`: auth and scopes, workspaces, asking, Gems, dashboards, predictions and jobs, members, sources and files, errors.

To use it with Claude Code, copy this folder to `~/.claude/skills/matih` (or `.claude/skills/matih` in a project). Give the assistant a Matih credential from `Settings › API & MCP` in `MATIH_API_KEY` for REST, or connect the MCP server as described in `../../mcp/README.md`.

The v1 API is live on workspace.matih.ai.
