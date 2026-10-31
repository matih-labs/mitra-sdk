# OAuth for multi-user apps

An API key acts as one workspace and one set of permissions: right for your own server talking to your own workspace. When each of your users should reach **their own** Matih data (a Slack bot where everyone sees only what they may see, a SaaS product with a "Connect Matih" button, an MCP client), use OAuth. The app acts for the person who approved it, with that person's workspaces and role.

!!! info "You need"
    - No admin step: your app registers itself (RFC 7591), and each person approves it on a consent screen in their browser. The person signs in to Matih as usual; OAuth adds no other way to sign in.
    - The scopes you request, such as `ask` or `sources:read` (see [Scopes](../concepts/scopes.md)). A token never exceeds the role of the person behind it.
    - A redirect URL your app controls (see the rules below).

## How it works

Matih is an **OAuth 2.1** authorization server for the public API: authorization code flow, **PKCE with `S256` required** (`plain` is refused), dynamic client registration, refresh token rotation and token revocation.

| Step | Endpoint | Standard |
|---|---|---|
| Register your app | `POST /api/v1/oauth/register` (JSON) | RFC 7591 |
| Send the person to approve | `GET /api/v1/oauth/authorize` | OAuth 2.1 |
| Exchange a code, refresh | `POST /api/v1/oauth/token` (form-encoded) | OAuth 2.1 |
| Revoke | `POST /api/v1/oauth/revoke` | RFC 7009 |

All four live under `https://workspace.matih.ai`. They are also listed in the discovery document, and a generic OAuth library can read them from there instead:

- `https://workspace.matih.ai/.well-known/oauth-authorization-server` (RFC 8414): issuer, the four endpoints, scopes, `S256` as the only challenge method, and the client authentication methods `none`, `client_secret_post` and `client_secret_basic`.
- `https://workspace.matih.ai/.well-known/oauth-protected-resource` (RFC 9728): the resource (`https://workspace.matih.ai/api/v1`), its authorization server and the supported scopes. The hosted MCP server has its own at `/.well-known/oauth-protected-resource/api/v1/mcp`.

```bash
curl -s https://workspace.matih.ai/.well-known/oauth-authorization-server | jq .
curl -s https://workspace.matih.ai/.well-known/oauth-protected-resource | jq .
```

The tokens:

| | Prefix | Lifetime |
|---|---|---|
| Access token | `mto_` | 1 hour, and never past the grant |
| Refresh token | `mtr_` | 30 days, sliding (each refresh extends it); the grant as a whole ends **90 days after consent**, then the person approves again |

Tokens are opaque: nothing in them decodes. An access token works on `/api/v1/*` only. It is not pinned to a workspace: the default workspace the person picked on the consent screen is used, and you can send `X-Matih-Workspace` on any request to choose another ([Switch workspaces](switch-workspaces.md)).

## 1. Register your app (once)

POST JSON to `/api/v1/oauth/register`. Do this once at deploy time and keep the result. The endpoint is public and unauthenticated, limited only per IP.

| Field | |
|---|---|
| `client_name` | Shown to people on the consent screen |
| `redirect_uris` | 1 to 10 URIs (rules below) |
| `token_endpoint_auth_method` | `none` (public client, the default for apps that cannot keep a secret), `client_secret_post` or `client_secret_basic` |
| `grant_types` | optional: `authorization_code`, `refresh_token` |
| `scope` | optional, space-separated |

A public client gets a `client_id` starting `mtc_`. A confidential client also gets a `client_secret` starting `mts_`, shown **once** and stored on Matih's side only as a hash.

**Redirect URI rules**

- `https`, or `http` on `localhost`, `127.0.0.1` or `::1` (the port may differ when you make the request, as RFC 8252 allows).
- Public clients may also use a desktop editor's private scheme (`cursor://`, `vscode://`) or a reverse-domain scheme such as `com.example.app:/callback`.
- No fragments, no embedded credentials, never `javascript:`, `data:` or `file:`.
- At the authorize step the `redirect_uri` must be one you registered. An unknown client or unregistered URI is shown to the person as an error and **never redirected to**.

=== "curl"

    ```bash
    curl -s https://workspace.matih.ai/api/v1/oauth/register \
      -H "Content-Type: application/json" \
      -d '{
        "client_name": "Acme Slack bot",
        "redirect_uris": ["https://bot.example.com/oauth/callback"],
        "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code", "refresh_token"]
      }'
    # -> {"client_id": "mtc_...", ...}
    ```

=== "Python"

    ```python
    import httpx

    BASE = "https://workspace.matih.ai"

    reg = httpx.post(
        f"{BASE}/api/v1/oauth/register",
        json={
            "client_name": "Acme Slack bot",
            "redirect_uris": ["https://bot.example.com/oauth/callback"],
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
        },
    )
    reg.raise_for_status()
    print(reg.json()["client_id"])  # mtc_...
    ```

=== "TypeScript"

    ```ts
    const BASE = "https://workspace.matih.ai";

    const res = await fetch(`${BASE}/api/v1/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Acme Slack bot",
        redirect_uris: ["https://bot.example.com/oauth/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
      }),
    });
    if (!res.ok) throw new Error(`register failed: ${res.status}`);
    const reg = await res.json();
    console.log(reg.client_id); // mtc_...
    ```

Use a public client with PKCE unless you have a server that can keep a secret. With a confidential client, send `client_secret` in the body of token requests (`client_secret_post`) or as HTTP Basic (`client_secret_basic`).

## 2. Send the person to approve

For each person, make a fresh **code verifier** (a random string of 43 to 128 URL-safe characters), derive the **code challenge** (`BASE64URL(SHA256(verifier))`), and a random `state`. Keep the verifier and state against that person's session, then redirect them to `GET /api/v1/oauth/authorize`:

| Parameter | |
|---|---|
| `response_type` | `code` |
| `client_id` | your `mtc_...` |
| `redirect_uri` | one you registered |
| `code_challenge`, `code_challenge_method` | the challenge and `S256` (**required**) |
| `scope` | optional, space-separated. Default: read and ask. Request only what you need. |
| `state` | your random value, returned unchanged |
| `resource` | optional; if sent, must be `https://workspace.matih.ai/api/v1` (or `https://workspace.matih.ai/api/v1/mcp` for MCP) |

Every refusal other than an unknown client or redirect URI comes back to your `redirect_uri` as `?error=...&state=...`. A valid request is kept for **10 minutes** while the person decides.

=== "Python"

    ```python
    import base64
    import hashlib
    import secrets
    from urllib.parse import urlencode

    BASE = "https://workspace.matih.ai"
    CLIENT_ID = "mtc_..."  # from registration
    REDIRECT_URI = "https://bot.example.com/oauth/callback"


    def b64url(raw: bytes) -> str:
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


    def start_login(session: dict) -> str:
        verifier = b64url(secrets.token_bytes(48))
        challenge = b64url(hashlib.sha256(verifier.encode()).digest())
        state = secrets.token_urlsafe(24)
        session["verifier"], session["state"] = verifier, state
        query = urlencode({
            "response_type": "code",
            "client_id": CLIENT_ID,
            "redirect_uri": REDIRECT_URI,
            "scope": "ask sources:read workspaces:read",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": state,
            "resource": f"{BASE}/api/v1",
        })
        return f"{BASE}/api/v1/oauth/authorize?{query}"  # redirect the browser here
    ```

=== "TypeScript"

    ```ts
    import { createHash, randomBytes } from "node:crypto";

    const BASE = "https://workspace.matih.ai";
    const CLIENT_ID = "mtc_..."; // from registration
    const REDIRECT_URI = "https://bot.example.com/oauth/callback";

    const b64url = (buf: Buffer) => buf.toString("base64url");

    export function startLogin(session: { verifier?: string; state?: string }): string {
      const verifier = b64url(randomBytes(48));
      const challenge = b64url(createHash("sha256").update(verifier).digest());
      const state = b64url(randomBytes(24));
      session.verifier = verifier;
      session.state = state;
      const query = new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: "ask sources:read workspaces:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        resource: `${BASE}/api/v1`,
      });
      return `${BASE}/api/v1/oauth/authorize?${query}`; // redirect the browser here
    }
    ```

### What the person sees

The browser lands on Matih's consent page. A signed-out person signs in first and is returned to it. The page shows:

- your app's name, and the host the answer will return to;
- the scopes in plain words, flagging what **changes things** or **uses credits**;
- a **default workspace picker**: the workspace that requests use when you do not send `X-Matih-Workspace`.

Approving redirects to your `redirect_uri` with `?code=...&state=...`; denying redirects with `?error=access_denied&state=...`. Consent is not available inside a staff Support View session.

## 3. Exchange the code

In your callback, check that `state` matches (and that there is no `error`), then `POST /api/v1/oauth/token`, **form-encoded**, with the code and the **original verifier**.

!!! warning "The code is single use and lasts 60 seconds"
    It is bound to your client, the redirect URI, the PKCE challenge, the person, the scopes and the resource. Using it a second time **revokes the grant the first use created**. Exchange it once, immediately, and never retry the exchange on a network error without starting the login again.

=== "curl"

    ```bash
    curl -s https://workspace.matih.ai/api/v1/oauth/token \
      -d grant_type=authorization_code \
      -d code="$CODE" \
      -d redirect_uri="https://bot.example.com/oauth/callback" \
      -d client_id="$CLIENT_ID" \
      -d code_verifier="$VERIFIER"
    # confidential client: add  -d client_secret="$CLIENT_SECRET"
    ```

=== "Python"

    ```python
    import httpx


    def finish_login(session: dict, params: dict) -> dict:
        if "error" in params:
            raise PermissionError(params["error"])
        if params.get("state") != session.get("state"):
            raise ValueError("state mismatch")
        res = httpx.post(
            f"{BASE}/api/v1/oauth/token",
            data={
                "grant_type": "authorization_code",
                "code": params["code"],
                "redirect_uri": REDIRECT_URI,
                "client_id": CLIENT_ID,
                "code_verifier": session["verifier"],
            },
        )
        res.raise_for_status()
        return res.json()  # access_token (mto_...), refresh_token (mtr_...), expires_in, scope
    ```

=== "TypeScript"

    ```ts
    export async function finishLogin(
      session: { verifier?: string; state?: string },
      params: URLSearchParams,
    ) {
      const error = params.get("error");
      if (error) throw new Error(`authorization refused: ${error}`);
      if (params.get("state") !== session.state) throw new Error("state mismatch");
      const res = await fetch(`${BASE}/api/v1/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: params.get("code")!,
          redirect_uri: REDIRECT_URI,
          client_id: CLIENT_ID,
          code_verifier: session.verifier!,
        }),
      });
      if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
      return res.json(); // { access_token, refresh_token, expires_in, scope, ... }
    }
    ```

Store the token pair **per person**, encrypted at rest.

## 4. Call the API as the person

=== "Python"

    ```python
    from mitra import Mitra

    client = Mitra(access_token=tokens["access_token"])  # default workspace from consent
    print(client.ask("How many orders today?").answer)

    # Or choose the workspace explicitly
    client = Mitra(access_token=tokens["access_token"], workspace_id="WORKSPACE_ID")
    ```

=== "Python async"

    ```python
    from mitra import AsyncMitra

    async with AsyncMitra(access_token=tokens["access_token"], workspace_id="WORKSPACE_ID") as client:
        print((await client.ask("How many orders today?")).answer)
    ```

=== "TypeScript"

    ```ts
    import { Mitra } from "@matihlabs/mitra";

    const mitra = new Mitra({ accessToken: tokens.access_token, workspaceId: "WORKSPACE_ID" });
    console.log((await mitra.ask("How many orders today?")).answer);
    ```

=== "curl"

    ```bash
    curl -s https://workspace.matih.ai/api/v1/ask \
      -H "Authorization: Bearer $ACCESS_TOKEN" \
      -H "X-Matih-Workspace: WORKSPACE_ID" \
      -H "Content-Type: application/json" \
      -d '{"question": "How many orders today?"}'
    ```

List the person's workspaces with `GET /workspaces` to let them switch: see [Switch workspaces](switch-workspaces.md).

An expired, revoked or unknown token gets `401` with a `WWW-Authenticate: Bearer` challenge pointing at the protected resource metadata (`resource_metadata="https://workspace.matih.ai/.well-known/oauth-protected-resource"`). That is how MCP clients find the sign-in on their own.

## 5. Refresh, and save the new refresh token

Access tokens last an hour. When one expires, `POST /api/v1/oauth/token` with `grant_type=refresh_token`.

!!! danger "Refresh tokens rotate, and reuse kills the grant"
    Each refresh issues a **new** `mtr_` and revokes the old one. Presenting an already-rotated refresh token **revokes the whole grant**, because Matih cannot tell which of two holders is your app. The person must then approve again.

    So: write the new pair to storage **before** using the new access token, and serialise refreshes per person (a lock or a single-flight map). Two workers refreshing the same person at once, or an app that retries a refresh without having saved the first answer, will sign the person out.

A refresh may send `scope` to **narrow** the token, never to widen it. To get more scopes, send the person through consent again.

=== "Python"

    ```python
    import httpx


    def refresh(tokens: dict) -> dict:
        res = httpx.post(
            f"{BASE}/api/v1/oauth/token",
            data={
                "grant_type": "refresh_token",
                "refresh_token": tokens["refresh_token"],
                "client_id": CLIENT_ID,
            },
        )
        res.raise_for_status()
        return res.json()  # save this whole object, replacing the old one
    ```

=== "TypeScript"

    ```ts
    export async function refresh(tokens: { refresh_token: string }) {
      const res = await fetch(`${BASE}/api/v1/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: CLIENT_ID,
        }),
      });
      if (!res.ok) throw new Error(`refresh failed: ${res.status}`); // send the person through login again
      return res.json(); // save this whole object, replacing the old one
    }
    ```

If the refresh fails, restart from step 2. Do not loop on a `401`.

### A wrapper that retries once

```python
from mitra import AuthError, Mitra


def ask_for(person_id: str, question: str):
    tokens = load_tokens(person_id)
    client = Mitra(access_token=tokens["access_token"], workspace_id=load_workspace(person_id))
    try:
        return client.ask(question)
    except AuthError:
        tokens = refresh(tokens)
        save_tokens(person_id, tokens)  # before using it
        client = Mitra(access_token=tokens["access_token"], workspace_id=load_workspace(person_id))
        return client.ask(question)     # a second AuthError means: log in again
```

## 6. Revoke (sign out of your app)

`POST /api/v1/oauth/revoke` (RFC 7009), form-encoded. Revoking a **refresh token** ends the whole grant; revoking an **access token** ends only that token. It answers 200 whether or not the token existed, and does nothing for another client's token.

=== "curl"

    ```bash
    curl -s https://workspace.matih.ai/api/v1/oauth/revoke \
      -d token="$REFRESH_TOKEN" \
      -d client_id="$CLIENT_ID"
    ```

=== "Python"

    ```python
    httpx.post(
        f"{BASE}/api/v1/oauth/revoke",
        data={"token": tokens["refresh_token"], "client_id": CLIENT_ID},
    )
    ```

=== "TypeScript"

    ```ts
    await fetch(`${BASE}/api/v1/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokens.refresh_token, client_id: CLIENT_ID }),
    });
    ```

## Connected apps: what people and admins see

- **A person:** Settings › **Connected apps** lists the apps they approved. Disconnecting one revokes its grant: its access and refresh tokens stop working at once.
- **A workspace admin:** the Settings › API & MCP tab lists OAuth-connected apps whose last use was in that workspace (or that were never used, with this workspace as the consent default), and an admin can disconnect them.
- **Every request** re-resolves the person's membership and role, so removing someone from a workspace stops their apps there at once, and an app never exceeds its person's role.

## Choosing: key or OAuth

| | API key (`mtk_`) | OAuth (`mto_`) |
|---|---|---|
| Acts as | the member who made the key | the person who approved |
| Workspace | pinned | default from consent, or per request |
| Made by | an admin, by hand | your app, per person, in the browser |
| Lifetime | never expires by default | access 1 hour; refresh 30 days sliding; grant 90 days |
| Best for | your own server, one workspace, CI | apps with many users, each seeing their own data |

## Related

- [Credentials and products](../concepts/credentials.md)
- [Switch workspaces](switch-workspaces.md)
- [Security](../security.md)
- [MCP](../mcp/index.md): MCP clients discover and run this flow by themselves from the `401` challenge.
