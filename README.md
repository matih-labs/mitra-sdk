<p align="center"><img src="https://raw.githubusercontent.com/matih-labs/mitra-sdk/main/assets/matih-logo.png" alt="Matih" width="160"></p>

# mitra-sdk

Client-side tools for the Matih public API: the OpenAPI spec, Python and TypeScript SDKs, an
MCP setup guide, an agent skill, and examples such as a Slack bot.

> **Status: pre-release, version 0.1.0.** The versioned API (`/api/v1`) is rolling out to
> `workspace.matih.ai` now and is not live for every workspace yet. Until it is, the SDKs here
> are not published to PyPI or npm and the examples may be refused by your workspace. Watch
> releases for the first published spec and package versions.

## What the API lets you do

- List the workspaces you belong to and choose which one a request runs in
- List, test and connect data sources, or upload a CSV/Excel file
- Read Gems (evidence-backed findings), each with a chart image
- Ask questions in plain language, in any of 22 Indian languages (text or a voice note), and get
  an answer, the data and a chart image
- Get a dashboard as an image
- Ask predictive questions (forecasts, what-ifs) as background jobs
- Embed a dashboard (with per-viewer row filters), a Gems feed or an Ask box in your own product: mint a short-lived token on your backend, show it with the `<matih-embed>` element
- Receive signed webhooks when long work finishes
- Admin work with the right scopes: list and invite members, change roles, connect or remove
  sources, upload and manage files, manage webhooks

## Quickstart

Create an API key as a workspace admin under `Settings › API & MCP`, then:

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

## Sync vs async

Quick questions are one request. Work that takes longer (Gem generation, forecasts, dashboard
images, connecting a source, processing a file) can be waited for or run in the background, and
the API supports both with standard `Prefer` headers (RFC 7240):

| You want | Send | You get |
|---|---|---|
| Wait up to N seconds | `Prefer: wait=N` (or `?wait=N`), N up to 60, 120 for `POST /sources` | `200` or `201` if done in time, otherwise `202` with a Job to poll; `Preference-Applied` says what was honoured |
| Answer later | `Prefer: respond-async` on `POST /ask` | `202` with a Job of kind `ask`; its `result` is the Answer |
| Nothing special | no header | the behaviour documented per endpoint |

Both SDKs wrap this: every long call takes `wait` (seconds) and `background`, and `jobs.wait`
polls a job. Python has `Mitra` (sync) and `AsyncMitra` at full parity; TypeScript is
promise-based. See `sdks/python/README.md` and `sdks/typescript/README.md`, and
`examples/http/` for the raw HTTP version in six languages.

## Layout

| Path | Contents |
|---|---|
| `openapi/` | The OpenAPI 3.1 spec for `/api/v1`, copied here from the server on each release |
| `sdks/python/` | `mitra-sdk` (import `mitra`): sync and async clients on httpx, pydantic models |
| `sdks/typescript/` | `@matihlabs/mitra`: typed client on openapi-fetch, SSE streaming |
| `sdks/embed/` | `@matihlabs/embed`: the `<matih-embed>` web component (iframe, token in the URL fragment, renewal from your backend), no dependencies |
| `skills/matih/` | Agent skill (`SKILL.md` and references) for using Matih from an AI agent |
| `mcp/` | Connect Claude, Cursor, VS Code, ChatGPT and others to the hosted MCP endpoint |
| `examples/http/` | Plain-HTTP examples in Java, Go, JavaScript, C#, PHP and Ruby, with webhook verification |
| `examples/curl/` | Copy-paste curl recipes for every endpoint |
| `examples/slack-bot/` | Reference Slack bot (Socket Mode) built on the Python SDK |
| `examples/embed/` | Mint an embed token with the Node or Python SDK and show it with `<matih-embed>` |

## Authentication in one paragraph

Send `Authorization: Bearer <credential>`. A credential is either an API key (`mtk_...`,
pinned to one workspace, acts as the member who created it and never exceeds their role) or an
OAuth 2.1 access token (`mto_...`, authorization code with PKCE and dynamic client
registration; discovery at `/.well-known/oauth-authorization-server`). OAuth tokens choose a
workspace with the `X-Matih-Workspace` header or `PUT /me/workspace`.

Workspace admins create keys in the Matih app under `Settings › API & MCP`. They choose the
products the key may use (all on by default): Ask, Data sources, Files, Predictive, Dashboards,
Gems, Embeds, Workspaces, Users & members and Webhooks. Keys never expire by default; revoke them in the
same screen. There are two kinds: an API key works on all of `/api/v1`, and an MCP connector key
works only on `/api/v1/mcp` and is refused with 401 elsewhere. Use a connector key for MCP clients.

## Scopes

`workspaces:read`, `members:read`, `members:manage`, `sources:read`, `sources:write`,
`files:read`, `files:write`, `gems:read`, `gems:generate`, `ask`, `dashboards:read`, `predict`,
`embeds:create`, `embeds:read`, `webhooks:manage`. File endpoints use `files:*` (`GET /files` and `GET /files/{id}` need
`files:read`; upload, duplicate and delete need `files:write`).
A key or token never exceeds the role of the member it acts as, whatever scopes it has.

## Links

- **Documentation: [matih.ai/docs/api](https://matih.ai/docs/api/overview)**: quickstart, concepts, guides, MCP setup and SDK reference
- Live spec: `https://workspace.matih.ai/api/v1/openapi.json`, docs: `https://workspace.matih.ai/api/v1/docs`
- [MCP guide](mcp/README.md) - [Agent skill](skills/matih/SKILL.md) - [curl recipes](examples/curl/README.md)
- [Contributing](CONTRIBUTING.md) - [Changelog](CHANGELOG.md) - [Security](SECURITY.md)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Security

This repository contains no credentials and no server code. Access is controlled entirely by
the Matih API: scoped API keys or OAuth tokens tied to a user and a workspace. Never commit a
Matih API key. See [SECURITY.md](SECURITY.md) to report a vulnerability.
