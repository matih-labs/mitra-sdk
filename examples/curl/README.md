<p align="center"><img src="https://raw.githubusercontent.com/matih-labs/mitra-sdk/main/assets/matih-logo.png" alt="Matih" width="160"></p>

# Matih API: curl recipes

Copy-paste recipes for every endpoint of the public API. Needs `curl`, and `jq` for a few of the loops.

```bash
export MATIH_API_KEY=mtk_...            # create under `Settings › API & MCP` in Matih
export BASE=https://workspace.matih.ai/api/v1
AUTH="Authorization: Bearer $MATIH_API_KEY"
```

Errors look like `{"detail": {"category": "...", "message": "..."}}`. Add `-i` to any command to see status and headers, or `-sS --fail-with-body` to make scripts fail on HTTP errors.

Credit-costing POSTs accept an `Idempotency-Key` header. Retries with the same key are not charged twice.

Full machine-readable spec: `curl -s $BASE/openapi.json`. Interactive docs: `https://workspace.matih.ai/docs`.

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

# Invite by email or by phone (members:manage, admin role)
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"email": "teammate@example.com", "role": "ROLE"}' $BASE/invitations
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"phone": "+910000000000", "role": "ROLE"}' $BASE/invitations

# List pending invitations (members:read)
curl -s -H "$AUTH" $BASE/invitations

# Revoke an invitation (members:manage)
curl -s -X DELETE -H "$AUTH" $BASE/invitations/INVITATION_ID

# Change a member's role (members:manage)
curl -s -X PATCH -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"role": "ROLE"}' $BASE/members/MEMBER_ID

# Remove a member (members:manage)
curl -s -X DELETE -H "$AUTH" $BASE/members/MEMBER_ID
```

Take valid role values from `GET /members`. A 402 with category `member_cap` means the workspace has no seats left.

## Sources and connectors

```bash
# List sources
curl -s -H "$AUTH" $BASE/sources

# One source, including readiness (sources:read)
curl -s -H "$AUTH" $BASE/sources/SOURCE_ID

# Activate a source (sources:write)
curl -s -X POST -H "$AUTH" $BASE/sources/SOURCE_ID/activate

# Delete a source (sources:write). Destructive.
curl -s -X DELETE -H "$AUTH" $BASE/sources/SOURCE_ID

# List connector types and the fields each needs
curl -s -H "$AUTH" $BASE/connectors

# Test a connection (needs sources:write). The config fields come from /connectors.
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"config": {"type": "postgres", "host": "db.example.com", "port": 5432, "database": "sales", "user": "reader", "password": "REDACTED"}}' \
  $BASE/sources/test

# Add a source (admin role and sources:write); activate it right away.
# 201 on success. 422 with the test result if the connection test fails (nothing is created).
curl -s -i -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"config": {"type": "postgres", "host": "db.example.com", "port": 5432, "database": "sales", "user": "reader", "password": "REDACTED"}, "activate": true}' \
  $BASE/sources
```

The config above is illustrative. Use the exact `type` and field names returned by `GET /connectors`.

## Files (CSV and Excel upload)

```bash
# Upload (files:write). Optional form field on_duplicate: see /openapi.json for allowed values.
curl -s -H "$AUTH" -F file=@sales.csv $BASE/files
# -> {"id": "file_...", "status": "processing", ...}

# List files (files:read)
curl -s -H "$AUTH" $BASE/files

# One file: status, analysis state, decision_required
curl -s -H "$AUTH" $BASE/files/FILE_ID

# If decision_required is true, send the user's choice (files:write)
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"decision": "DECISION"}' $BASE/files/FILE_ID/duplicate

# Delete a file (files:write). Destructive.
curl -s -X DELETE -H "$AUTH" $BASE/files/FILE_ID

# Poll in a loop
until [ "$(curl -s -H "$AUTH" $BASE/files/FILE_ID | jq -r .status)" != "processing" ]; do sleep 3; done
curl -s -H "$AUTH" $BASE/files/FILE_ID
```

Once the file is ready, it shows up in `GET /sources`.

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

# Show only the status, answer and conversation id
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"question": "How many orders yesterday?"}' $BASE/ask \
  | jq '{status, answer, conversation_id, clarification, follow_ups}'
```

### Streaming (server-sent events)

Events: `started`, `progress`, `answer`, `error`.

```bash
curl -N -H "$AUTH" -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"question": "Revenue by month this year", "stream": true}' \
  $BASE/ask
```

`-N` turns off curl's buffering so events print as they arrive.

### Audio (voice note)

```bash
curl -s -H "$AUTH" -H "Idempotency-Key: $(uuidgen)" \
  -F file=@question.ogg \
  -F source_id=SOURCE_ID \
  -F conversation_id=CONVERSATION_ID \
  -F language=hi-IN \
  $BASE/ask/audio
```

`source_id`, `conversation_id` and `language` are optional (scope `ask`). The speech language is detected automatically. The response is an Answer plus `heard`, for example `{"transcript": "...", "language": "hi-IN"}`:

```bash
curl -s -H "$AUTH" -F file=@question.ogg $BASE/ask/audio | jq '{heard, status, answer}'
```

### Conversations

```bash
curl -s -H "$AUTH" $BASE/conversations
curl -s -H "$AUTH" $BASE/conversations/CONVERSATION_ID
```

## Gems

```bash
# List gems for a source
curl -s -H "$AUTH" "$BASE/gems?source_id=SOURCE_ID"

# Read one gem
curl -s -H "$AUTH" $BASE/gems/GEM_ID

# Download a gem's image (with auth)
curl -s -H "$AUTH" -o gem.png $BASE/gems/GEM_ID/image.png

# Generate gems (202 with a Job)
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"source_id": "SOURCE_ID"}' $BASE/gems/generate
```

## Dashboards

```bash
# List
curl -s -H "$AUTH" $BASE/dashboards

# Read one
curl -s -H "$AUTH" $BASE/dashboards/DASHBOARD_ID

# Render as an image (202 with a Job; result has image_url, width, height)
curl -s -X POST -H "$AUTH" -H "Idempotency-Key: $(uuidgen)" \
  $BASE/dashboards/DASHBOARD_ID/image

# Download the PNG. Redirects to a fresh image when cached, else returns 202 with a Job.
curl -sL -H "$AUTH" -o dashboard.png $BASE/dashboards/DASHBOARD_ID/image.png
```

If the last call wrote a small JSON file instead of a PNG, a render job was started. Check `dashboard.png` with `head -c 200` and poll the job as shown below.

## Predictions

```bash
# Start (202 with a Job; can take up to 30 minutes)
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"question": "Forecast monthly revenue for the next 6 months", "source_id": "SOURCE_ID"}' \
  $BASE/predictions
```

The result is `{answer, attachments:[{type: forecast|table|model|what_if, ...}], image_url?}`.

## Sync or background (Prefer)

Long calls take standard `Prefer` headers. `Preference-Applied` in the response says what the
server honoured.

```bash
# Wait up to 60 s for a forecast: 201/200 if finished in time, otherwise 202 with a Job
curl -si https://workspace.matih.ai/api/v1/predictions \
  -H "Authorization: Bearer $MATIH_API_KEY" -H "Content-Type: application/json" \
  -H "Prefer: wait=60" -H "Idempotency-Key: $(uuidgen)" \
  -d '{"question": "Forecast next quarter revenue"}'

# Ask in the background: 202 with a Job of kind "ask"; poll it, result is the Answer
curl -s https://workspace.matih.ai/api/v1/ask \
  -H "Authorization: Bearer $MATIH_API_KEY" -H "Content-Type: application/json" \
  -H "Prefer: respond-async" -d '{"question": "Top customers this year"}'
```

`wait` also works as `?wait=N` on `POST /gems/generate`, `/predictions`,
`/dashboards/{id}/image` (up to 60), `POST /sources` (up to 120) and `POST /files`.

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

`image_url` values are short-lived signed URLs (15 minutes) and need no auth header:

```bash
URL=$(curl -s -H "$AUTH" $BASE/gems/GEM_ID | jq -r .image_url)
curl -s -o image.png "$URL"
```

If it has expired, fetch the gem or job again for a new URL, or use the authenticated `.png` endpoints above.

## Webhooks

Events: `gems.ready`, `prediction.completed`, `job.completed`, `dashboard_image.ready`. Needs `webhooks:manage`.

```bash
# Create. The signing secret (whsec_...) is returned ONCE; store it now.
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com/hooks/matih", "events": ["job.completed", "prediction.completed"]}' \
  $BASE/webhooks

# List
curl -s -H "$AUTH" $BASE/webhooks

# Send a test delivery
curl -s -X POST -H "$AUTH" $BASE/webhooks/WEBHOOK_ID/test

# Recent deliveries and their outcomes
curl -s -H "$AUTH" $BASE/webhooks/WEBHOOK_ID/deliveries

# Delete
curl -s -X DELETE -H "$AUTH" $BASE/webhooks/WEBHOOK_ID
```

### Verify a signature

Each delivery carries three headers:

```
Matih-Signature: t=<unix timestamp>,v1=<hex hmac-sha256>
Matih-Event: <event name, for example job.completed>
Matih-Delivery: <delivery id>
```

Use `Matih-Delivery` to deduplicate repeated deliveries.

The signed string is `"<t>.<raw body>"`, HMAC-SHA256 with your webhook secret.

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
```

OAuth 2.1 with authorization code and PKCE, plus dynamic client registration. Access tokens start with `mto_`; refresh tokens (`mtr_`) rotate. Use the access token exactly like an API key:

```bash
curl -s -H "Authorization: Bearer mto_..." -H "X-Matih-Workspace: WORKSPACE_ID" $BASE/sources
```

## MCP over curl (smoke test)

```bash
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  $BASE/mcp
```

For real use, connect with an MCP client. See `../../mcp/README.md`.
