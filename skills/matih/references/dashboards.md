# Dashboards

Scope: `dashboards:read`.

## List and read

MCP: `list_dashboards`. REST: `GET /dashboards` returns `{"dashboards": [{"id", "title", "source_id", "status", "revision", "widget_count", "created_at", "updated_at"}]}` (`status` is `draft` or `saved`). `GET /dashboards/{id}` returns one dashboard with its `widgets` (`id`, `title`, `visual`, `question`).

Match the user's wording to `title`. If several are close, list them and ask.

## Render as an image

MCP: `dashboard_image` with `dashboard_id`. REST:

- `POST /dashboards/{id}/image` with an optional body `{"width": 1600}` (400 to 3200) returns 202 and a Job (`kind: "dashboard_image"`). Add `?wait=20` (or `Prefer: wait=20`) to get the finished Job when it is quick. On success `result` is `{"image_url", "width", "height"}`. A dashboard drawn in the last ten minutes at the same width is reused.
- `GET /dashboards/{id}/image.png?width=` with auth: `303` to the image when one was drawn recently, else it starts a drawing and returns 202 with a Job. Follow redirects (`curl -L`).

Drawing uses no credits and the POST does not honour `Idempotency-Key`.

## Flow

1. Find the dashboard id (`list_dashboards`).
2. Call `dashboard_image`. Over MCP it waits up to 20 seconds and returns the picture. If it does, show it.
3. If it returns a job id, poll `get_job` every 10 to 15 seconds. Rendering is usually 5 to 20 seconds; a failed render has category `render_unavailable`.
4. When `state` is `succeeded`, show or download `result.image_url`.

`image_url` is a public, unguessable URL that expires after 15 minutes and needs no auth. Download or display immediately, and request a new render if it expired. A `dashboard_image.ready` webhook is available (REST only).

## Notes

- The image is a snapshot of the dashboard as of render time. State the time (`updated_at` or job `updated_at`) if the user is making a decision on it.
- If the user wants a number from the dashboard, ask the underlying question with `ask` instead of reading it off the picture.
- If MCP images are not displayed by your client, give the user the `image_url` and say it expires in 15 minutes.
