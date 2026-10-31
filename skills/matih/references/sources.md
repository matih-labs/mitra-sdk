# Sources and files

A source is a connected database, warehouse or uploaded file that questions run against. Reading is safe; connecting, activating and deleting need an explicit user request.

## Scopes

- `sources:read`: list connectors, sources (with readiness) and files.
- `sources:write`: test, create, activate and delete sources; upload files, resolve duplicates, delete files. Creating a source also needs the admin role.

## Read

| Action | MCP tool | REST |
| --- | --- | --- |
| List sources | `list_sources` | `GET /sources` |
| Source detail and readiness | `source_status` | `GET /sources/{id}` |
| Connector types and fields | (REST only) | `GET /connectors` |
| List files | `list_files` | `GET /files` |
| File detail | (REST only) | `GET /files/{id}` |

`GET /sources` returns `{id, name, type, status, active}`. `GET /sources/{id}` adds readiness. Check readiness before asking questions of a just-connected source; if it is not ready, say so and check again in a little while rather than asking and getting weak answers.

## Connect a database (REST only)

Only when the user asks for it, and with credentials the user supplies.

1. `GET /connectors` to find the `type` and the exact field names it needs.
2. `POST /sources/test` with `{"config": {...}}`. Fix problems until it passes.
3. `POST /sources` with `{"config": {...}, "activate": true}`. Success is 201 with the new source. If the connection test fails, you get 422 with the test result and nothing is created. See `errors.md`.
4. `GET /sources/{id}` until readiness shows it is ready.

`activate` defaults to true. Send `"activate": false` to create the source without making it active, and activate later with `POST /sources/{id}/activate`.

```bash
curl -s -H "Authorization: Bearer $MATIH_API_KEY" -H 'Content-Type: application/json' \
  -d '{"config": {"type": "...", "...": "..."}, "activate": true}' \
  https://workspace.matih.ai/api/v1/sources
```

Never repeat passwords or connection strings back to the user, and never write them to logs or files.

## Delete a source

`DELETE /sources/{id}` (`sources:write`). Destructive: gems, conversations or dashboards that depended on it may stop working. Name the source and get a yes first.

## Upload a file (REST only)

`POST /files` is multipart with `file` (CSV or Excel) and an optional `on_duplicate` field that says what to do if a similar file already exists. Returns a File with `id` and `status`.

```bash
curl -s -H "Authorization: Bearer $MATIH_API_KEY" \
  -F file=@sales.xlsx \
  https://workspace.matih.ai/api/v1/files
```

Take the allowed `on_duplicate` values from `GET /openapi.json`; do not guess them.

Then poll `GET /files/{id}` every 3 to 5 seconds. It reports:

- `status`: processing state.
- analysis state: whether Matih has finished profiling the data.
- `decision_required`: true when Matih found a likely duplicate and needs the user to choose.

### Duplicates

When `decision_required` is true, show the user what was found and ask what to do. Then send their choice:

```bash
curl -s -H "Authorization: Bearer $MATIH_API_KEY" -H 'Content-Type: application/json' \
  -d '{"decision": "..."}' \
  https://workspace.matih.ai/api/v1/files/FILE_ID/duplicate
```

The valid `decision` values are in the OpenAPI spec or in the file's `decision_required` details. Do not pick for the user.

### Delete a file

`DELETE /files/{id}` (`sources:write`). Confirm first; the file's data is removed.

## After connecting

Once readiness is fine, `list_sources`, then `ask` with the `source_id`. Gems can be generated for the new source if the user wants them (see `gems.md`).
