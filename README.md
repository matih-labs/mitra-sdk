# mitra-sdk

Client-side tools for the Matih public API: the OpenAPI spec, SDKs, an MCP setup guide,
agent skills, and examples such as a Slack bot.

> **Status: pre-release.** The versioned API (`/api/v1`) is being built. Nothing in this
> repository can be used against production yet. Watch releases for the first published spec.

## What the API will let you do

- List the workspaces you belong to and choose which one a request runs in
- List and connect data sources
- Read Gems (evidence-backed findings), with a chart image for each
- Ask questions in plain language and get an answer, the data, and a chart image
- Get a dashboard as an image preview
- Ask predictive questions (forecasts, what-ifs) as background jobs

## Layout

| Path | Contents |
|---|---|
| `openapi/` | The published OpenAPI 3.1 spec for `/api/v1`, copied here on each API release |
| `sdks/python/` | Python client generated from the spec |
| `sdks/typescript/` | TypeScript client generated from the spec |
| `mcp/` | How to connect an MCP client (Claude, Cursor, …) to Matih's hosted MCP endpoint |
| `skills/matih/` | Agent skill (`SKILL.md`) describing how an agent should use Matih |
| `examples/slack-bot/` | Reference Slack bot built on the SDK |

## Security

This repository contains no credentials and no server code. Access is controlled entirely by
the Matih API: scoped API keys or OAuth tokens tied to a user and a workspace. Never commit a
Matih API key. See [SECURITY.md](SECURITY.md) to report a vulnerability.
