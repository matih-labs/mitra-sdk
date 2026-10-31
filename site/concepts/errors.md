# Errors

Every error uses one envelope:

```json
{"detail": {"category": "scope", "message": "Missing scope: ask", "code": "optional_machine_code"}}
```

Read `category` first, then `message`. `code` is optional and stable for programs. Failed jobs carry
an `error` object with `category` and `message` in the same style.

| Status | `category` | Meaning | What to do |
|---|---|---|---|
| 401 | none | Missing, wrong, expired or revoked credential. `WWW-Authenticate` is set. | API key: get a new key. OAuth: refresh once, then sign in again. Never loop. |
| 402 | `credits` | The workspace pool is empty. | Stop; an admin must add credits. See [Credits](credits.md). |
| 402 | `member_cap` | The acting member hit their monthly cap. | Tell an admin to raise it. |
| 403 | `scope` | The credential lacks the scope. The message names it. | Enable the product (and *Allow changes*) on the key. See [Scopes](scopes.md). |
| 403 | `workspace_role` | The member's role is too low for this action. | Do not work around it; ask an admin. |
| 403 | `source_access` | The member cannot use that source, or it is in another workspace. | List sources again and choose another. |
| 409 | `busy` | A request in the same conversation (or the same long task) is already running. | Wait 3 to 5 s, retry with the same `Idempotency-Key`. |
| 413 / 415 / 422 | varies | Bad upload or input. `422` on `POST /sources` carries the connection test result. | Fix the request; do not retry unchanged. |
| 429 | (varies) | Too many requests. `Retry-After` gives seconds. | See [Rate limits](rate-limits.md). |
| 5xx | varies | Server error. | Retry up to three times with backoff and the same `Idempotency-Key`; then report `request_id`. |

An HTTP `200` Answer with `status: "error"`, `"empty"` or `"clarification"` is **not** an HTTP error. See the
[Quickstart](../quickstart.md) for what to do with each.

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
        print("out of credits:", err.category)       # credits | member_cap
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
`request_id` when you have one: it lets Matih support find the request.
