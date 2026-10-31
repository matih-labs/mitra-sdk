# mitra-sdk

Client-side tools for the Matih public API: the OpenAPI spec, Python and TypeScript SDKs, an
MCP setup guide, an agent skill, and examples such as a Slack bot.

> **Status: pre-release.** The versioned API (`/api/v1`) is being rolled out. Until v1 is live
> the SDKs here are not published to PyPI or npm and the examples will not work against
> production. Watch releases for the first published spec and package versions.

## What the API lets you do

- List the workspaces you belong to and choose which one a request runs in
- List, test and connect data sources, or upload a CSV/Excel file
- Read Gems (evidence-backed findings), each with a chart image
- Ask questions in plain language, in any of 22 Indian languages (text or a voice note), and get
  an answer, the data and a chart image
- Get a dashboard as an image
- Ask predictive questions (forecasts, what-ifs) as background jobs
- Receive signed webhooks when long work finishes
- Admin work with the right scopes: list and invite members, change roles, connect or remove
  sources, upload and manage files, manage webhooks

## Quickstart

Create an API key as a workspace admin under **Settings, Integrations**, then:

```bash
export MATIH_API_KEY=mtk_...   # never commit this
curl -s https://workspace.matih.ai/api/v1/ask \
  -H "Authorization: Bearer $MATIH_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept-Language: en-IN" \
  -d '{"question": "What were last month'"'"'s sales by region?"}'
```

Python:

```python
from mitra import Mitra

client = Mitra(api_key="mtk_...")
answer = client.ask("What were last month's sales by region?")
print(answer.answer)
```

TypeScript:

```ts
import { Mitra } from "@matihlabs/mitra";

const client = new Mitra({ apiKey: process.env.MATIH_API_KEY });
const answer = await client.ask("What were last month's sales by region?");
console.log(answer.answer);
```

## Layout

| Path | Contents |
|---|---|
| `openapi/` | The OpenAPI 3.1 spec for `/api/v1`, copied here from the server on each release |
| `sdks/python/` | `mitra-sdk` (import `mitra`): sync and async clients on httpx, pydantic models |
| `sdks/typescript/` | `@matihlabs/mitra`: typed client on openapi-fetch, SSE streaming |
| `skills/matih/` | Agent skill (`SKILL.md` and references) for using Matih from an AI agent |
| `mcp/` | Connect Claude, Cursor, VS Code, ChatGPT and others to the hosted MCP endpoint |
| `examples/curl/` | Copy-paste curl recipes for every endpoint |
| `examples/slack-bot/` | Reference Slack bot (Socket Mode) built on the Python SDK |

## Authentication in one paragraph

Send `Authorization: Bearer <credential>`. A credential is either an API key (`mtk_...`,
pinned to one workspace, acts as the member who created it and never exceeds their role) or an
OAuth 2.1 access token (`mto_...`, authorization code with PKCE and dynamic client
registration; discovery at `/.well-known/oauth-authorization-server`). OAuth tokens choose a
workspace with the `X-Matih-Workspace` header or `PUT /me/workspace`.

## Scopes

`workspaces:read`, `members:read`, `members:manage`, `sources:read`, `sources:write`,
`gems:read`, `gems:generate`, `ask`, `dashboards:read`, `predict`, `webhooks:manage`.
A key or token never exceeds the role of the member it acts as, whatever scopes it has.

## Links

- Live spec: `https://workspace.matih.ai/api/v1/openapi.json`, docs: `https://workspace.matih.ai/api/v1/docs`
- [MCP guide](mcp/README.md) - [Agent skill](skills/matih/SKILL.md) - [curl recipes](examples/curl/README.md)
- [Contributing](CONTRIBUTING.md) - [Changelog](CHANGELOG.md) - [Security](SECURITY.md)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Security

This repository contains no credentials and no server code. Access is controlled entirely by
the Matih API: scoped API keys or OAuth tokens tied to a user and a workspace. Never commit a
Matih API key. See [SECURITY.md](SECURITY.md) to report a vulnerability.
