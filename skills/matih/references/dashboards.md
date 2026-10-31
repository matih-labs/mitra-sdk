# Dashboards

Scope: `dashboards:read`.

## List and read

MCP: `list_dashboards`. REST: `GET /dashboards` returns `{"dashboards": [{"id", "title", "updated_at"}]}`. `GET /dashboards/{id}` returns one dashboard's details.

Match the user's wording to `title`. If several are close, list them and ask.

## Render as an image

MCP: `dashboard_image` with `dashboard_id`. REST:

- `POST /dashboards/{id}/image` returns 202 and a Job (`kind: "dashboard_image"`). On success `result` is `{"image_url", "width", "height"}`.
- `GET /dashboards/{id}/image.png` with auth: redirects to a fresh image when one is cached, else returns 202 with a Job. Follow redirects (`curl -L`).

Send an `Idempotency-Key` on the POST.

## Flow

1. Find the dashboard id (`list_dashboards`).
2. Call `dashboard_image`. If the response is the image, show it.
3. If it is a job, poll `get_job` every 3 seconds for the first 30 seconds, then every 5 to 10 seconds. Rendering normally takes seconds to a minute.
4. When `state` is `succeeded`, show or download `result.image_url`.

`image_url` is signed, short-lived (15 minutes) and needs no auth. Download or display immediately, and request a new render if it expired. A `dashboard_image.ready` webhook is available (REST only).

## Notes

- The image is a snapshot of the dashboard as of render time. State the time (`updated_at` or job `updated_at`) if the user is making a decision on it.
- If the user wants a number from the dashboard, ask the underlying question with `ask` instead of reading it off the picture.
- If MCP images are not displayed by your client, give the user the `image_url` and say it expires in 15 minutes.
