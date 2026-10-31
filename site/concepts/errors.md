# Errors

Errors use one envelope:

```json
{"detail": {"category": "scope", "message": "This credential is not allowed to do that: it needs ask.", "code": "optional_machine_code"}}
```

Read `category` first, then `message`. `code` is a finer, stable reason where one exists. Failed jobs
carry an `error` object with `category` and `message` in the same style.

Two things do not use this envelope: a request that fails validation is a plain `422` with `detail` as a
**list** (see below), and the OAuth endpoints answer `{"error", "error_description"}`
([OAuth](../guides/oauth.md#oauth-errors)).

| Status | `category` | Meaning | What to do |
|---|---|---|---|
| 400 | `invalid` | The request is wrong in a way the schema cannot say: a bad `on_duplicate` (`ask` or `keep_both`) or `decision` (`use_existing`, `keep_both` or `cancel`), no `file` part, more than one file. | Fix the request. |
| 400 | `workspace` | The workspace operation cannot be done, for example inviting with both or neither of `email` and `phone`, or choosing a role that is not `admin`, `user` or `viewer`. | Fix the request. |
| 401 | `authentication` | Missing, unknown, expired or revoked credential, or a key sent to a path it is not allowed on. `WWW-Authenticate: Bearer resource_metadata="..."` is set. | API key: make a new one. OAuth: refresh once, then sign in again. Never loop. |
| 402 | `not_ready` | The workspace has no Matih Credits left. Nothing ran and nothing was charged. | Stop; an admin must add credits. See [Credits](credits.md). |
| 402 | `member_cap` | The member the key acts as reached the monthly cap an admin set. | Tell an admin to raise it. |
| 403 | `scope` | The credential lacks the scope; the message names it. | Switch the Product (and *Allow changes*) on for the key. See [Scopes](scopes.md). |
| 403 | `workspace_role` | The member's role is too low for this action, or has dropped below what the key's scopes need. | Do not work around it; ask an admin. |
| 403 | `workspace` | An API key is pinned to one workspace and `X-Matih-Workspace` (or `PUT /me/workspace`) named another. | Make a key in the other workspace, or use OAuth. |
| 403 | `workspace_membership` | The member the credential acts as is no longer in the workspace. | The key is dead: remove it. |
| 403 | `source_access` | The member cannot use that source. | List sources again and choose another. |
| 404 | `not_found` | No such resource in this workspace. Another member's or workspace's resource is the same `404`. | Check the id. |
| 409 | varies | The target is not in a state for it: an invitation already accepted or revoked, a file not waiting for a duplicate decision, or the workspace already has 20 webhooks (`limit`). | Re-read the resource. |
| 413 | `too_large`, `audio_too_large` | The file or recording is over the limit; refused before it is read in full. | Send a smaller one. |
| 415 | `unsupported_audio_type` | Not a supported file type. | Send a supported type. |
| 422 | (none) | Validation failed: `detail` is a list of `{loc, msg, type}`. | Fix the field in `loc`; do not retry unchanged. |
| 422 | `connection` | `POST /sources`: the connection test failed. Nothing was saved; `detail.test` has the result. | Fix the connection details. |
| 422 | `validation`, `not_heard` | A webhook URL or events list is invalid; a recording had no speech. | Fix the request. |
| 429 | `rate_limit` | Too many requests. `Retry-After` gives seconds. | See [Rate limits](rate-limits.md). |
| 500 | `internal` | Unexpected server error. | Retry up to three times with backoff; then report the time and the request. |
| 503 | `unavailable`, `disabled`, `language_unavailable`, `speech_unavailable` | The public API, uploads, voice or the speech service is off or busy on this deployment. | Retry later. |

!!! note "`rate_limit`"
    The OpenAPI document calls the 429 category `rate_limited`; the server sends `rate_limit`. Branch on the
    status code, not the category, for `429`.

An HTTP `200` Answer with `status: "error"`, `"empty"`, `"clarification"` or `"cancelled"` is **not** an
HTTP error. See the [Quickstart](../quickstart.md) for what to do with each. A question that fails, is
cancelled or is refused is never charged.

## Handle them in code

=== "Python"

    ```python
    from mitra import (
        Mitra, AuthError, CreditsError, MitraError, PermissionDeniedError, RateLimitError,
    )

    client = Mitra()
    try:
        answer = client.ask("How many orders today?")
    except RateLimitError as err:
        print("slow down, retry in", err.retry_after, "seconds")
    except CreditsError as err:
        print("out of credits:", err.category)       # not_ready | member_cap
    except PermissionDeniedError as err:
        print("not allowed:", err.category, err)     # scope | workspace_role | source_access
    except AuthError:
        print("key rejected: replace it")
    except MitraError as err:
        print(err.status, err.category, err.code, err.request_id)
    ```

=== "TypeScript"

    ```ts
    import { Mitra, AuthError, CreditsError, MitraError, PermissionError, RateLimitError } from "@matihlabs/mitra";

    const client = new Mitra({ apiKey: process.env.MATIH_API_KEY });
    try {
      await client.ask("How many orders today?");
    } catch (err) {
      if (err instanceof RateLimitError) console.error("retry after", err.retryAfter);
      else if (err instanceof CreditsError) console.error("credits", err.category);
      else if (err instanceof PermissionError) console.error("forbidden", err.category);
      else if (err instanceof AuthError) console.error("key rejected");
      else if (err instanceof MitraError) console.error(err.status, err.category);
      else throw err;
    }
    ```

=== "JavaScript (fetch)"

    ```js
    const res = await fetch(url, init);
    if (!res.ok) {
      const { detail } = await res.json().catch(() => ({ detail: {} }));
      if (res.status === 429) {
        const wait = Number(res.headers.get("Retry-After") ?? 5);
        /* sleep wait seconds, then retry once */
      }
      throw new Error(`${res.status} ${detail.category ?? ""} ${detail.message ?? ""}`);
    }
    ```

The exact attribute names for each SDK are in the [Python](../sdk/python.md) and [TypeScript](../sdk/typescript.md) references.

## Telling a person

One sentence on what happened, one on what they can do next. Never put a credential in the message. Include the
`request_id` of the Answer when you have one: it lets Matih support find the request.
