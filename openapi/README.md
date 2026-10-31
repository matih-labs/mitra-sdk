<p align="center"><img src="https://raw.githubusercontent.com/matih-labs/mitra-sdk/main/assets/matih-logo.png" alt="Matih" width="160"></p>

# OpenAPI spec

`openapi.json` in this directory is the OpenAPI 3.1 description of the Matih public API
(`https://workspace.matih.ai/api/v1`). **Do not edit it by hand.** It is copied from the server
on each API release by automation:

1. The API release pipeline sends a `repository_dispatch` event of type `spec-updated` with the
   payload `{"version": "...", "spec_url": "..."}` to this repository.
2. The [`sync-spec`](../.github/workflows/sync-spec.yml) workflow downloads the spec into
   `openapi/openapi.json`, regenerates the TypeScript types, and opens a pull request.
3. A maintainer reviews the diff and merges.

You can also run it by hand from the Actions tab (`workflow_dispatch`); the `spec_url` input
defaults to `https://workspace.matih.ai/api/v1/openapi.json`.

Until the first spec is published, this directory contains only this file and the generators
skip silently.

The live spec and interactive docs are always at `/api/v1/openapi.json` and `/api/v1/docs` on
the API host.

## What the spec covers

Endpoints are grouped by the OAuth scope they need: `workspaces:read`, `members:read`,
`members:manage`, `sources:read`, `sources:write`, `files:read`, `files:write`, `gems:read`,
`gems:generate`, `ask`, `dashboards:read`, `predict`, `webhooks:manage`. File endpoints use
`files:*`: `GET /files` and `GET /files/{id}` need `files:read`; `POST /files`,
`POST /files/{id}/duplicate` and `DELETE /files/{id}` need `files:write`. Admin endpoints (members, invitations, sources,
files, webhooks) additionally require the matching workspace role. Errors use
`{"detail": {"category", "message", "code?"}}`.

## Generating clients locally

```bash
curl -fsSL https://workspace.matih.ai/api/v1/openapi.json -o openapi/openapi.json

# TypeScript types
cd sdks/typescript && npm install && npm run generate

# Python models (optional; the shipped models are hand-written)
pip install datamodel-code-generator
datamodel-codegen --input openapi/openapi.json --input-file-type openapi \
  --output-model-type pydantic_v2.BaseModel --output /tmp/mitra_models.py
```
