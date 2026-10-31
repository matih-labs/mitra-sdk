# Switch workspaces

A person can belong to several workspaces (their own, their company's, a client's). Which workspace a request runs in depends on the credential.

!!! info "You need"
    - Product: **Workspaces** (scope `workspaces:read`).
    - For switching: an **OAuth token** (`mto_...`). API keys are pinned to one workspace and cannot switch.

## Who decides the workspace

| Credential | Workspace |
|---|---|
| `mtk_` API key or MCP connector | **Pinned** to the workspace the key was made in. A different `X-Matih-Workspace` header is refused. |
| `mto_` OAuth access token | The `X-Matih-Workspace` header on the request, else the person's default workspace (picked on the consent screen, changed with `PUT /me/workspace`). |

So a single-workspace integration, such as a company Slack bot, should use an API key and never think about this. A multi-user app that signs people in with OAuth needs to ask which workspace each person wants. See [OAuth for multi-user apps](oauth.md).

## List the workspaces the person can reach

The response has `current` (the id of the current workspace), `workspaces`, each with `id`, `name`, `role` and `kind`, and, for a signed-in person, any open `invitations` addressed to them (`id`, `workspace_name`, `role`, `invited_by`, `expires_at`).

=== "curl"

    ```bash
    curl -s https://workspace.matih.ai/api/v1/workspaces \
      -H "Authorization: Bearer $MATIH_TOKEN"
    ```

=== "Python"

    ```python
    from mitra import Mitra

    client = Mitra(access_token="mto_...")

    listing = client.workspaces.list()
    print("current:", listing.current)
    for w in listing.workspaces:
        print(w.id, w.name, w.role)
    ```

=== "Python async"

    ```python
    import asyncio
    from mitra import AsyncMitra


    async def main():
        async with AsyncMitra(access_token="mto_...") as client:
            listing = await client.workspaces.list()
            for w in listing.workspaces:
                print(w.id, w.name, w.role, "(current)" if w.id == listing.current else "")


    asyncio.run(main())
    ```

=== "TypeScript"

    ```ts
    import { Mitra } from "@matihlabs/mitra";

    const mitra = new Mitra({ accessToken: process.env.MATIH_ACCESS_TOKEN });

    const { current, workspaces } = await mitra.workspaces.list();
    for (const w of workspaces) console.log(w.id, w.name, w.role, w.id === current ? "(current)" : "");
    ```

=== "JavaScript (fetch)"

    ```js
    const res = await fetch("https://workspace.matih.ai/api/v1/workspaces", {
      headers: { Authorization: `Bearer ${process.env.MATIH_ACCESS_TOKEN}` },
    });
    const { current, workspaces } = await res.json();
    console.log(current, workspaces);
    ```

## Change the default workspace

`PUT /me/workspace` changes the person's current workspace on the server and answers `{current, name}`. Every later request with that token that carries no `X-Matih-Workspace` runs there until it is changed again.

=== "curl"

    ```bash
    curl -s -X PUT https://workspace.matih.ai/api/v1/me/workspace \
      -H "Authorization: Bearer $MATIH_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"workspace_id": "WORKSPACE_ID"}'
    ```

=== "Python"

    ```python
    client.workspaces.use("WORKSPACE_ID")   # the Python client does not adopt it; pass workspace_id= per client or call
    ```

=== "TypeScript"

    ```ts
    await mitra.workspaces.use("WORKSPACE_ID"); // also becomes this client's default
    ```

## Choose per request (recommended for bots)

A server handling many people should not flip a global default: two requests in flight would race. Send the workspace on each request instead.

=== "curl"

    ```bash
    curl -s https://workspace.matih.ai/api/v1/sources \
      -H "Authorization: Bearer $MATIH_TOKEN" \
      -H "X-Matih-Workspace: WORKSPACE_ID"
    ```

=== "Python"

    ```python
    # Per client...
    client = Mitra(access_token=user_token, workspace_id="WORKSPACE_ID")

    # ...or per call
    sources = client.sources.list(workspace_id="WORKSPACE_ID")
    answer = client.ask("Orders today?", workspace_id="WORKSPACE_ID")
    ```

=== "TypeScript"

    ```ts
    // Per client...
    const mitra = new Mitra({ accessToken: userToken, workspaceId: "WORKSPACE_ID" });

    // ...or per call
    const sources = await mitra.sources.list({ workspaceId: "WORKSPACE_ID" });
    const answer = await mitra.ask("Orders today?", { workspaceId: "WORKSPACE_ID" });
    ```

=== "JavaScript (fetch)"

    ```js
    const res = await fetch("https://workspace.matih.ai/api/v1/ask", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userToken}`,
        "X-Matih-Workspace": "WORKSPACE_ID",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ question: "Orders today?" }),
    });
    ```

A workspace the person does not belong to is refused (and an API key naming a workspace other than its own gets `403` with category `workspace`), and the role they hold in that workspace decides what the request may do, exactly as in the app.

## A workspace picker for a chat bot

A typical flow for a bot used by many people through OAuth:

1. After sign-in, call `workspaces.list()` with that person's token.
2. If there is one workspace, store its id and move on. If there are several, show them as buttons (name and role) and store the choice per person (or per channel).
3. On every later request, build the client with `workspace_id=<stored id>` so the choice is explicit.
4. Offer a "switch workspace" command that repeats step 2.

```python
from mitra import Mitra


def client_for(user_token: str, workspace_id: str | None) -> Mitra:
    return Mitra(access_token=user_token, workspace_id=workspace_id)


def choices(user_token: str) -> list[tuple[str, str]]:
    listing = Mitra(access_token=user_token).workspaces.list()
    return [(w.id, f"{w.name} ({w.role})") for w in listing.workspaces]
```

With an API key the list contains the single pinned workspace, so the same code works; the picker just has nothing to pick. An `X-Matih-Workspace` for another workspace on a key is refused.

## MCP

In an MCP client signed in with OAuth, the `use_workspace` tool does the same as `PUT /me/workspace`. It is not for connector keys, which are pinned. See [MCP tools](../mcp/tools.md).

## Related

- [Concepts: workspaces](../concepts/workspaces.md)
- [Concepts: credentials and products](../concepts/credentials.md)
- [OAuth for multi-user apps](oauth.md)
