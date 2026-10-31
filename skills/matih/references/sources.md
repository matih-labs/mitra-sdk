# Sources and files

A source is a connected database, warehouse or the workspace's uploaded files that questions run against. Reading is safe; connecting, activating and deleting need an explicit user request.

## Scopes

- `sources:read`: list connectors and sources (with readiness).
- `sources:write`: test, create, activate and delete sources. Testing, creating and deleting also need the admin role; activating needs only the viewer role, as in the app.
- `files:read`: `GET /files` and `GET /files/{id}`.
- `files:write`: `POST /files` (upload), `POST /files/{id}/duplicate` and `DELETE /files/{id}`. Uploading, deciding and deleting need the user role; listing needs viewer.

## Read

| Action | MCP tool | REST |
| --- | --- | --- |
| List sources | `list_sources` | `GET /sources` |
| Source detail and readiness | `source_status` | `GET /sources/{id}` |
| Connector types and fields | (REST only) | `GET /connectors` |
| List files | `list_files` | `GET /files` |
| File detail | (REST only) | `GET /files/{id}` |

`GET /sources` returns `{sources: [...], active_source_id}`; each source has `id`, `name`, `connector_type`, `settings` (non-secret only), `secret_fields_set` (names, never values), `state`, `is_active`, `is_sample` and `managed_by`. `GET /sources/{id}` adds `readiness`: `{state, phase, can_ask, message, catalog}`. `phase` is `building` while Matih reads the tables for the first time, `ready` when Ask can use the source, or `not_connected` when the connection itself needs attention. Check `can_ask` before asking questions of a just-connected source; if it is false, say so and check again in a little while rather than asking and getting weak answers.

## Connect a database (REST only)

Only when the user asks for it, and with credentials the user supplies.

1. `GET /connectors` to find the connector `type` and the exact field names it needs (`fields[].name`; secret ones are flagged `secret: true` and carry no values).
2. `POST /sources/test` with `{"config": {"connector_type": "...", ...}}`. Fix problems until `ok` is true.
3. `POST /sources` with `{"config": {...}, "activate": true}`. Success is 201 with `{source, test, applied, catalog_job_id}`. The catalog is built in the background. If the connection test fails, you get 422 (category `connection`) with the `test` result and nothing is saved. See `errors.md`.
4. `GET /sources/{id}` until `readiness.can_ask` is true, or send `Prefer: wait=60` (up to 120) on step 3 to get the answer back with `phase: ready` when the catalog finishes in time.

`activate` defaults to true. Send `"activate": false` to create the source without making it active, and activate later with `POST /sources/{id}/activate`.

```bash
curl -s -H "Authorization: Bearer $MATIH_API_KEY" -H 'Content-Type: application/json' \
  -d '{"config": {"connector_type": "...", "...": "..."}, "activate": true}' \
  https://workspace.matih.ai/api/v1/sources
```

Never repeat passwords or connection strings back to the user, and never write them to logs or files.

## Delete a source

`DELETE /sources/{id}` (`sources:write`, admin; returns `{deleted: true}`). Destructive: gems, conversations or dashboards that depended on it may stop working. Name the source and get a yes first.

## Upload a file (REST only)

`POST /files` is multipart with a `file` part and an optional `on_duplicate` field: `ask` (the default; an identical file waits for a decision) or `keep_both`. The type comes from the file name (csv, tsv, txt, parquet, json, jsonl, xlsx and the other formats the app takes). Returns 201 with a File: `id`, `name`, `status`, `ready`, `decision_required`, `decision_options`, `tables`. With `Prefer: wait=N` (up to 120) it waits for processing; if that is still running after N seconds the answer is 202 with the file `processing`. A file over the size limit is 413, an unsupported type 415, and a request with no `file` part 400.

```bash
curl -s -H "Authorization: Bearer $MATIH_API_KEY" \
  -F file=@sales.xlsx \
  https://workspace.matih.ai/api/v1/files
```

Then poll `GET /files/{id}` every 3 to 5 seconds until `ready` is true. It reports:

- `status`: `uploading`, `validating`, `processing`, `ready`, `needs_attention`, `failed`, `deleting` or `deleted`, and `stage` in plain words.
- `analysis_state`: how far Matih got in reading the data.
- `decision_required`: `"duplicate"` when the file is identical to an earlier one and waits for the user to choose, with `decision_options` and `duplicate_of`.
- `error_message` and `retryable` when it failed.

### Duplicates

When `decision_required` is `"duplicate"`, show the user what was found and ask what to do. Then send their choice:

```bash
curl -s -H "Authorization: Bearer $MATIH_API_KEY" -H 'Content-Type: application/json' \
  -d '{"decision": "..."}' \
  https://workspace.matih.ai/api/v1/files/FILE_ID/duplicate
```

`decision` is `use_existing` (drop this upload and use the earlier file), `keep_both` or `cancel` (drop this upload). The open choices are in the file's `decision_options`. A file that is not waiting for a decision answers 409. Do not pick for the user.

### Delete a file

`DELETE /files/{id}` (`files:write`, user role). Confirm first; the file's data is removed.

## After connecting

Once readiness is fine, `list_sources`, then `ask` with the `source_id`. Gems can be generated for the new source if the user wants them (see `gems.md`).
