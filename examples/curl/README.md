<p align="center"><img src="https://raw.githubusercontent.com/matih-labs/mitra-sdk/main/assets/matih-logo.png" alt="Matih" width="160"></p>

# Matih API: curl recipes

Copy-paste recipes for every endpoint of the public API. Needs `curl`, and `jq` for a few of the loops.

```bash
export MATIH_API_KEY=mtk_...            # create under `Settings › API & MCP` in Matih
export BASE=https://workspace.matih.ai/api/v1
AUTH="Authorization: Bearer $MATIH_API_KEY"
```

Errors look like `{"detail": {"category": "...", "message": "..."}}`. Add `-i` to any command to see status and headers, or `-sS --fail-with-body` to make scripts fail on HTTP errors.

`POST /ask` and `POST /predictions` accept an `Idempotency-Key` header: a retry with the same key answers once and is charged once. No other call honours it.

Full machine-readable spec: `curl -s $BASE/openapi.json`. Interactive docs: `https://workspace.matih.ai/api/v1/docs`.

## Workspaces

```bash
# List workspaces and see which is current
curl -s -H "$AUTH" $BASE/workspaces

# Set the default workspace (OAuth tokens; API keys are pinned to one workspace)
curl -s -X PUT -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"workspace_id":"WORKSPACE_ID"}' $BASE/me/workspace

# Use a workspace for a single request (OAuth tokens)
curl -s -H "$AUTH" -H "X-Matih-Workspace: WORKSPACE_ID" $BASE/sources
```

## Members and invitations

Admin actions. Run the write commands only when you mean to.

```bash
# List members (members:read)
curl -s -H "$AUTH" $BASE/members

# Invite by email or by phone, exactly one of them (members:manage, admin role). 201.
# role is viewer, user (the default) or admin; never owner.
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"email": "teammate@example.com", "role": "user"}' $BASE/invitations
# A phone invitation returns join_code, join_message and join_url once, in this response only
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"phone": "+910000000000", "role": "user"}' $BASE/invitations

# List pending invitations (members:read, admin role)
curl -s -H "$AUTH" $BASE/invitations

# Revoke an invitation (members:manage)
curl -s -X DELETE -H "$AUTH" $BASE/invitations/INVITATION_ID
# -> {"revoked": "INVITATION_ID"}; 409 if it was already accepted, declined or revoked

# Change a member's role (members:manage)
curl -s -X PATCH -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"role": "viewer"}' $BASE/members/MEMBER_ID

# Remove a member (members:manage)
curl -s -X DELETE -H "$AUTH" $BASE/members/MEMBER_ID
# -> {"removed": "MEMBER_ID"}
```

`role` is `viewer`, `user` or `admin`. Owners are made and removed in the Matih app, not here. Each row of `GET /members` says whether you `can_change_role` and `can_remove` it.

## Sources and connectors

```bash
# List sources -> {sources: [...], active_source_id}
curl -s -H "$AUTH" $BASE/sources

# One source, including readiness: state, phase, can_ask (sources:read)
curl -s -H "$AUTH" $BASE/sources/SOURCE_ID

# Activate a source (sources:write)
curl -s -X POST -H "$AUTH" $BASE/sources/SOURCE_ID/activate

# Delete a source (sources:write). Destructive.
curl -s -X DELETE -H "$AUTH" $BASE/sources/SOURCE_ID

# List connector types and the fields each needs
curl -s -H "$AUTH" $BASE/connectors

# Test a connection (sources:write, admin role). The config fields come from /connectors.
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"config": {"connector_type": "postgres", "host": "db.example.com", "port": 5432, "database": "sales", "user": "reader", "password": "REDACTED"}}' \
  $BASE/sources/test

# Add a source (admin role and sources:write); activate it right away.
# 201 on success; its catalog is read in the background (readiness.phase: building).
# 422, category connection, with the test result if the test fails (nothing is saved).
curl -s -i -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"config": {"connector_type": "postgres", "host": "db.example.com", "port": 5432, "database": "sales", "user": "reader", "password": "REDACTED"}, "activate": true}' \
  $BASE/sources
```

The config above is illustrative. Use the exact connector `type` (as `connector_type`) and field names returned by `GET /connectors`; secret fields are flagged and never returned.

Connecting a source is not a Job. To get the answer back only when Ask can use the source, add `-H "Prefer: wait=60"` (up to 120): the 201 then carries `readiness.phase: ready` and `can_ask: true`, or `building` if the wait ran out. Otherwise poll:

```bash
until [ "$(curl -s -H "$AUTH" $BASE/sources/SOURCE_ID | jq -r .readiness.can_ask)" = true ]; do sleep 3; done
```

## Files (CSV and Excel upload)

```bash
# Upload (files:write, user role). 201. Optional form field on_duplicate: ask (default) or keep_both.
curl -s -H "$AUTH" -F file=@sales.csv $BASE/files
# -> {"id": "file_...", "status": "processing", "ready": false, ...}

# Wait for it (up to 120 s): 201 when ready, 202 with the file still processing
curl -si -H "$AUTH" -H "Prefer: wait=60" -F file=@sales.csv $BASE/files

# List files (files:read)
curl -s -H "$AUTH" $BASE/files

# One file: status, ready, analysis_state, decision_required
curl -s -H "$AUTH" $BASE/files/FILE_ID

# If decision_required is "duplicate", send the user's choice (files:write):
# use_existing, keep_both or cancel. 409 if the file is not waiting for one.
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"decision": "keep_both"}' $BASE/files/FILE_ID/duplicate

# Delete a file (files:write). Destructive.
curl -s -X DELETE -H "$AUTH" $BASE/files/FILE_ID

# Poll in a loop until it is ready (ready=true), or stops: needs_attention, failed,
# or waiting on a duplicate decision
while :; do
  F=$(curl -s -H "$AUTH" $BASE/files/FILE_ID)
  [ "$(echo "$F" | jq -r '.ready or (.status == "needs_attention") or (.status == "failed") or (.decision_required != null)')" = true ] && break
  sleep 3
done
echo "$F" | jq '{status, ready, decision_required, error_message}'
```

The type comes from the file name (csv, tsv, txt, parquet, json, jsonl, xlsx and the other formats the app takes). A file over the size limit is 413, an unsupported type 415. Once the file is ready, its tables can be asked about.

## Ask

```bash
# Simple question
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"question": "Top 5 products by revenue last month", "source_id": "SOURCE_ID"}' \
  $BASE/ask

# Follow-up in the same conversation
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"question": "Now split that by region", "conversation_id": "CONVERSATION_ID"}' \
  $BASE/ask

# Ask in Hindi and get the reply in Hindi
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -H "Accept-Language: hi-IN" \
  -d '{"question": "पिछले महीने की कुल बिक्री कितनी थी?"}' \
  $BASE/ask

# Force a response language from the body
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"question": "Total sales last month", "language": "ta-IN"}' $BASE/ask

# Answer in the background: 202 with a Job of kind ask (see Sync or background below)
curl -s -H "$AUTH" -H 'Content-Type: application/json' -H 'Prefer: respond-async' \
  -d '{"question": "Top customers this year"}' $BASE/ask

# Show only the status, answer and conversation id
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"question": "How many orders yesterday?"}' $BASE/ask \
  | jq '{status, answer, conversation_id, clarification, follow_ups}'
```

### Streaming (server-sent events)

Events: `started`, any number of `progress` (`{stage, message, status}`), then one `answer` (the Answer) or `error` (`{category, message}`). A 402 is returned before the stream opens.

```bash
curl -N -H "$AUTH" -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"question": "Revenue by month this year", "stream": true}' \
  $BASE/ask
```

`-N` turns off curl's buffering so events print as they arrive.

### Audio (voice note)

```bash
curl -s -H "$AUTH" \
  -F file=@question.ogg \
  -F source_id=SOURCE_ID \
  -F conversation_id=CONVERSATION_ID \
  -F language=hi-IN \
  $BASE/ask/audio
```

`source_id`, `conversation_id` and `language` are optional (scope `ask`); `language` names the language spoken and skips detection. The recording is any common audio format, 5 MB at most, and is not stored. The call does not honour `Idempotency-Key`. The response is an Answer plus `heard`, for example `{"transcript": "...", "language": "hi-IN"}`:

```bash
curl -s -H "$AUTH" -F file=@question.ogg $BASE/ask/audio | jq '{heard, status, answer}'
```

### Conversations

```bash
# Your conversations, most recent first (including those started in Matih's apps)
curl -s -H "$AUTH" $BASE/conversations
# One conversation with its messages, oldest first
curl -s -H "$AUTH" $BASE/conversations/CONVERSATION_ID
```

## Gems

```bash
# The Gem feed of a source (the active one if source_id is left out) -> {state, gems, generated_at}
curl -s -H "$AUTH" "$BASE/gems?source_id=SOURCE_ID"

# Read one gem
curl -s -H "$AUTH" "$BASE/gems/GEM_ID?source_id=SOURCE_ID"

# Download a gem's image (with auth); 404 when it has nothing worth drawing
curl -s -H "$AUTH" -o gem.png "$BASE/gems/GEM_ID/image.png?source_id=SOURCE_ID"

# Generate gems (gems:generate): 202 with a Job. The body and source_id are optional.
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"source_id": "SOURCE_ID"}' $BASE/gems/generate

# Or wait up to 30 s: 200 with the finished Job (result: source_id, state, gem_count), else 202
curl -si -X POST -H "$AUTH" "$BASE/gems/generate?wait=30"
```

## Dashboards

```bash
# List
curl -s -H "$AUTH" $BASE/dashboards

# Read one
curl -s -H "$AUTH" $BASE/dashboards/DASHBOARD_ID

# Render as an image (202 with a Job; result has image_url, width, height).
# Optional body {"width": 400-3200}, default 1600. Add ?wait=20 to wait for the finished Job.
curl -s -X POST -H "$AUTH" "$BASE/dashboards/DASHBOARD_ID/image?wait=20"

# Download the PNG. 303 to the image when one was drawn recently, else 202 with a Job.
curl -sL -H "$AUTH" -o dashboard.png $BASE/dashboards/DASHBOARD_ID/image.png
```

If the last call wrote a small JSON file instead of a PNG, a render job was started. Check `dashboard.png` with `head -c 200` and poll the job as shown below.

## Predictions

```bash
# Start (predict scope): 202 with a Job. Takes minutes; the server gives up after 30.
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"question": "Forecast monthly revenue for the next 6 months", "source_id": "SOURCE_ID"}' \
  $BASE/predictions
```

The finished Job's `result` is `{conversation_id, answer}`: `answer` is a string, and `conversation_id` continues the prediction conversation (send it back as `conversation_id` to `POST /predictions`).

## Sync or background (Prefer)

Long calls take standard `Prefer` headers. `Preference-Applied` in the response says what the
server honoured.

```bash
# Wait up to 60 s for a forecast: 200 with the finished Job, otherwise 202 with the Job so far
curl -si https://workspace.matih.ai/api/v1/predictions \
  -H "Authorization: Bearer $MATIH_API_KEY" -H "Content-Type: application/json" \
  -H "Prefer: wait=60" -H "Idempotency-Key: $(uuidgen)" \
  -d '{"question": "Forecast next quarter revenue"}'

# Ask in the background: 202 with a Job of kind "ask"; poll it, result is the Answer
curl -s https://workspace.matih.ai/api/v1/ask \
  -H "Authorization: Bearer $MATIH_API_KEY" -H "Content-Type: application/json" \
  -H "Prefer: respond-async" -d '{"question": "Top customers this year"}'
```

`wait` also works as `?wait=N` on `POST /gems/generate`, `/predictions` and
`/dashboards/{id}/image` (up to 60; a larger `?wait=` is a 422, a larger header is capped).
On `POST /sources` and `POST /files` it goes up to 120, but those return the source or the file,
not a Job: poll `GET /sources/{id}` or `GET /files/{id}`.

## Jobs

```bash
# One look
curl -s -H "$AUTH" $BASE/jobs/JOB_ID

# Cancel
curl -s -X POST -H "$AUTH" $BASE/jobs/JOB_ID/cancel
```

### Poll a job in a bash loop

Starts at 5 seconds, slows to 15 then 30, gives up after 30 minutes (the maximum for a prediction), and prints the result.

```bash
JOB_ID=job_...
START=$(date +%s)
DELAY=5
while :; do
  JOB=$(curl -s -H "$AUTH" $BASE/jobs/$JOB_ID)
  STATE=$(echo "$JOB" | jq -r .state)
  case "$STATE" in
    succeeded) echo "$JOB" | jq .result; break ;;
    failed)    echo "$JOB" | jq .error >&2; exit 1 ;;
    cancelled) echo "cancelled" >&2; exit 1 ;;
  esac
  ELAPSED=$(( $(date +%s) - START ))
  if [ "$ELAPSED" -ge 1800 ]; then
    echo "gave up after 30 minutes; job $JOB_ID is still $STATE" >&2
    exit 2
  fi
  [ "$ELAPSED" -ge 60 ]  && DELAY=15
  [ "$ELAPSED" -ge 300 ] && DELAY=30
  sleep "$DELAY"
done
```

## Images

`image_url` values are public, unguessable URLs that expire after 15 minutes and need no auth header:

```bash
URL=$(curl -s -H "$AUTH" "$BASE/gems/GEM_ID?source_id=SOURCE_ID" | jq -r .image_url)
curl -s -o image.png "$URL"
```

If it has expired, fetch the gem or job again for a new URL, or use the authenticated `.png` endpoints above.

## Webhooks

Events: `gems.ready`, `prediction.completed`, `job.completed`, `dashboard_image.ready`. Needs `webhooks:manage`.

```bash
# Create (admin role). 201. At most 20 per workspace; the URL must be a public https one.
# The signing secret (whsec_...) is returned ONCE; store it now.
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com/hooks/matih", "events": ["job.completed", "prediction.completed"]}' \
  $BASE/webhooks

# List -> {webhooks: [...]}; secrets are never listed
curl -s -H "$AUTH" $BASE/webhooks

# Send a ping now and see how it went (delivered, status, error)
curl -s -X POST -H "$AUTH" $BASE/webhooks/WEBHOOK_ID/test

# The last 50 deliveries and their outcomes (kept 30 days)
curl -s -H "$AUTH" $BASE/webhooks/WEBHOOK_ID/deliveries

# Delete (204)
curl -s -X DELETE -H "$AUTH" $BASE/webhooks/WEBHOOK_ID
```

### Verify a signature

Each delivery carries three headers:

```
Matih-Signature: t=<unix timestamp>,v1=<hex hmac-sha256>
Matih-Event: <event name, for example job.completed>
Matih-Delivery: <delivery id>
```

The body's `id` is the event id, the same on every retry: use it to ignore duplicates. `Matih-Delivery` identifies the delivery to this endpoint. Answer with any 2xx within 10 seconds; a redirect counts as a failure.

The signed string is `"<t>.<raw body>"`, HMAC-SHA256 keyed with the whole `whsec_...` secret string.

Shell check, with the raw body saved to `body.json`:

```bash
SIG='t=1767225600,v1=abc123...'       # value of the Matih-Signature header
SECRET='whsec_...'                    # returned when you created the webhook
T=${SIG#t=}; T=${T%%,*}
V1=${SIG##*v1=}
EXPECTED=$( { printf '%s.' "$T"; cat body.json; } | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
[ "$EXPECTED" = "$V1" ] && echo valid || echo INVALID
```

In your receiver, also compare in constant time, use the raw bytes of the body (not a re-serialised copy), and reject timestamps older than about 5 minutes to stop replays.

## OAuth discovery

```bash
curl -s https://workspace.matih.ai/.well-known/oauth-authorization-server | jq .
curl -s https://workspace.matih.ai/.well-known/oauth-protected-resource | jq .
curl -s https://workspace.matih.ai/.well-known/oauth-protected-resource/api/v1/mcp | jq .
```

OAuth 2.1 with authorization code and PKCE (`S256`), plus dynamic client registration (`POST /api/v1/oauth/register`). Access tokens start with `mto_` and last an hour; refresh tokens (`mtr_`) last 30 days and rotate: each refresh returns a new one and the old one stops working. Use the access token exactly like an API key:

```bash
curl -s -H "Authorization: Bearer mto_..." -H "X-Matih-Workspace: WORKSPACE_ID" $BASE/sources
```

## MCP over curl (smoke test)

```bash
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  $BASE/mcp
```

The server is stateless: every POST is a complete exchange. For real use, connect with an MCP client. See `../../mcp/README.md`.
