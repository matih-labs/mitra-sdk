# Invite members

Add people to a workspace by email or phone number, see who is in it, change roles and remove people. This is the guide for an onboarding flow in your own product: "add my teammate to Matih" from a button, a Slack command or an internal admin tool.

!!! info "You need"
    - Product: **Users & members**. Listing needs `members:read`; inviting, changing roles and removing need `members:manage` with **Allow changes** on for that product.
    - To invite, change roles, remove people or list invitations, the credential must act as a workspace **admin** or owner. Scopes only narrow what a key can do: a `members:manage` key made by a non-admin still cannot invite. Listing members needs only `members:read` and any role.
    - An API key is pinned to its workspace. With OAuth, choose the workspace first ([Switch workspaces](switch-workspaces.md)).

!!! warning "Invitations message a third party"
    An invitation sends an email or a message to a real person. Only do it when someone asked for it, and confirm the address in your UI first. An invite that goes to a typo is a message to a stranger.

## List members

=== "curl"

    ```bash
    curl -s https://workspace.matih.ai/api/v1/members \
      -H "Authorization: Bearer $MATIH_API_KEY"
    ```

=== "Python"

    ```python
    from mitra import Mitra

    client = Mitra()

    for m in client.members.list().members:
        print(m.id, m.email, m.role)
    ```

=== "Python async"

    ```python
    import asyncio
    from mitra import AsyncMitra


    async def main():
        async with AsyncMitra() as client:
            members = await client.members.list()
            for m in members.members:
                print(m.id, m.email, m.role)


    asyncio.run(main())
    ```

=== "TypeScript"

    ```ts
    import { Mitra } from "@matihlabs/mitra";

    const mitra = new Mitra({ apiKey: process.env.MATIH_API_KEY });

    const { members } = await mitra.members.list();
    for (const m of members) console.log(m.id, m.email, m.role);
    ```

=== "JavaScript (fetch)"

    ```js
    const res = await fetch("https://workspace.matih.ai/api/v1/members", {
      headers: { Authorization: `Bearer ${process.env.MATIH_API_KEY}` },
    });
    const { members } = await res.json();
    console.log(members);
    ```

Each member has `id` (a `usr_...` user id, the `{member_id}` of the routes below), `name`, `email`, `phone` (masked unless you are an admin), `role`, `whatsapp_only`, `joined_at`, `last_seen_at`, `monthly_cap_credits`, `you`, and `can_change_role` and `can_remove`, which say what the caller may do to that row.

Roles are `owner`, `admin`, `user` and `viewer`. You can give `admin`, `user` or `viewer`; `owner` is never givable. The owner is made and changed in the app, not here.

## Invite by email

=== "curl"

    ```bash
    curl -s https://workspace.matih.ai/api/v1/invitations \
      -H "Authorization: Bearer $MATIH_API_KEY" \
      -H "Content-Type: application/json" \
      -d '{"email": "teammate@example.com", "role": "user"}'
    ```

=== "Python"

    ```python
    invitation = client.invitations.create("user", email="teammate@example.com")
    print(invitation)
    ```

=== "Python async"

    ```python
    invitation = await client.invitations.create("user", email="teammate@example.com")
    ```

=== "TypeScript"

    ```ts
    const invitation = await mitra.invitations.create({
      email: "teammate@example.com",
      role: "user",
    });
    console.log(invitation.id);
    ```

=== "JavaScript (fetch)"

    ```js
    const res = await fetch("https://workspace.matih.ai/api/v1/invitations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MATIH_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: "teammate@example.com", role: "user" }),
    });
    console.log(res.status, await res.json());
    ```

=== "Java"

    ```java
    import java.net.URI;
    import java.net.http.HttpClient;
    import java.net.http.HttpRequest;
    import java.net.http.HttpResponse;

    public class Invite {
        public static void main(String[] args) throws Exception {
            String body = "{\"email\": \"teammate@example.com\", \"role\": \"user\"}";
            HttpRequest req = HttpRequest.newBuilder(URI.create("https://workspace.matih.ai/api/v1/invitations"))
                .header("Authorization", "Bearer " + System.getenv("MATIH_API_KEY"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
            HttpResponse<String> res = HttpClient.newHttpClient()
                .send(req, HttpResponse.BodyHandlers.ofString());
            System.out.println(res.statusCode() + " " + res.body());
        }
    }
    ```

=== "Go"

    ```go
    package main

    import (
    	"fmt"
    	"io"
    	"net/http"
    	"os"
    	"strings"
    )

    func main() {
    	body := `{"email": "teammate@example.com", "role": "user"}`
    	req, _ := http.NewRequest("POST", "https://workspace.matih.ai/api/v1/invitations", strings.NewReader(body))
    	req.Header.Set("Authorization", "Bearer "+os.Getenv("MATIH_API_KEY"))
    	req.Header.Set("Content-Type", "application/json")
    	res, err := http.DefaultClient.Do(req)
    	if err != nil {
    		panic(err)
    	}
    	defer res.Body.Close()
    	out, _ := io.ReadAll(res.Body)
    	fmt.Println(res.StatusCode, string(out))
    }
    ```

=== "C#"

    ```csharp
    using System;
    using System.Net.Http;
    using System.Net.Http.Headers;
    using System.Text;

    var http = new HttpClient();
    http.DefaultRequestHeaders.Authorization =
        new AuthenticationHeaderValue("Bearer", Environment.GetEnvironmentVariable("MATIH_API_KEY"));

    var res = await http.PostAsync(
        "https://workspace.matih.ai/api/v1/invitations",
        new StringContent("{\"email\": \"teammate@example.com\", \"role\": \"user\"}",
            Encoding.UTF8, "application/json"));
    Console.WriteLine($"{(int)res.StatusCode} {await res.Content.ReadAsStringAsync()}");
    ```

=== "PHP"

    ```php
    <?php
    $ch = curl_init("https://workspace.matih.ai/api/v1/invitations");
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => [
            "Authorization: Bearer " . getenv("MATIH_API_KEY"),
            "Content-Type: application/json",
        ],
        CURLOPT_POSTFIELDS => json_encode(["email" => "teammate@example.com", "role" => "user"]),
    ]);
    echo curl_exec($ch);
    ```

=== "Ruby"

    ```ruby
    require "net/http"
    require "json"

    uri = URI("https://workspace.matih.ai/api/v1/invitations")
    req = Net::HTTP::Post.new(uri, {
      "Authorization" => "Bearer #{ENV['MATIH_API_KEY']}",
      "Content-Type" => "application/json"
    })
    req.body = { email: "teammate@example.com", role: "user" }.to_json
    res = Net::HTTP.start(uri.host, uri.port, use_ssl: true) { |h| h.request(req) }
    puts "#{res.code} #{res.body}"
    ```

## Invite by phone

Pass `phone` in international format instead of `email`. Send exactly one of the two. A phone invitation goes out on WhatsApp. If it cannot be delivered, the response carries `join_code`, `join_message` and `join_url` **once**: pass them on by hand, because they are never shown again. `whatsapp_only: true` lets the person use the workspace on WhatsApp only (not with `admin`).

=== "curl"

    ```bash
    curl -s https://workspace.matih.ai/api/v1/invitations \
      -H "Authorization: Bearer $MATIH_API_KEY" \
      -H "Content-Type: application/json" \
      -d '{"phone": "+919800000000", "role": "user"}'
    ```

=== "Python"

    ```python
    inv = client.invitations.create("user", phone="+919800000000")
    if inv.join_code:
        print(inv.join_message)   # WhatsApp delivery failed: share this yourself
    ```

=== "TypeScript"

    ```ts
    const inv = await mitra.invitations.create({ phone: "+919800000000", role: "user" });
    if (inv.join_code) console.log(inv.join_message); // WhatsApp delivery failed: share this yourself
    ```

## List and revoke pending invitations

=== "curl"

    ```bash
    BASE=https://workspace.matih.ai/api/v1
    AUTH="Authorization: Bearer $MATIH_API_KEY"

    curl -s -H "$AUTH" $BASE/invitations
    curl -s -X DELETE -H "$AUTH" $BASE/invitations/INVITATION_ID
    ```

=== "Python"

    ```python
    pending = client.invitations.list()
    client.invitations.revoke("INVITATION_ID")
    ```

=== "TypeScript"

    ```ts
    const { invitations } = await mitra.invitations.list();
    await mitra.invitations.revoke(invitations[0].id);
    ```

## Change a role, remove a member

`PATCH /members/{member_id}` takes `{"role": "admin" | "user" | "viewer"}` and returns the member. Nobody can be made owner here and the owner's role cannot be changed. `DELETE /members/{member_id}` removes someone else (you cannot remove yourself, and the owner cannot be removed); their own content stays theirs. Both are admin-only.

=== "curl"

    ```bash
    BASE=https://workspace.matih.ai/api/v1
    AUTH="Authorization: Bearer $MATIH_API_KEY"

    curl -s -X PATCH -H "$AUTH" -H "Content-Type: application/json" \
      -d '{"role": "admin"}' $BASE/members/MEMBER_ID

    curl -s -X DELETE -H "$AUTH" $BASE/members/MEMBER_ID
    ```

=== "Python"

    ```python
    client.members.update("MEMBER_ID", "admin")
    client.members.remove("MEMBER_ID")
    ```

=== "TypeScript"

    ```ts
    await mitra.members.update("MEMBER_ID", { role: "admin" });
    await mitra.members.remove("MEMBER_ID");
    ```

## Errors you will meet

| Status | Category | Meaning |
|---|---|---|
| 403 | `scope` | The key lacks `members:read` or `members:manage`. Edit the key's products in Settings › API & MCP. |
| 403 | `workspace_role` | The person the key acts as is not an admin or owner. |
| 400 | `workspace` | Both or neither of `email` and `phone`, a bad invitation, or removing yourself (leave from the app). |
| 404 | `not_found` | No such member or invitation in this workspace. |
| 409 | | Revoking an invitation that is no longer open (already accepted, declined or revoked). |
| 422 | | The body is invalid, for example a role that is not `admin`, `user` or `viewer` (`owner` and `member` are refused). |

See [Errors](../concepts/errors.md) for the full envelope.

## Related

- [Credentials and products](../concepts/credentials.md), [Scopes](../concepts/scopes.md)
- [Switch workspaces](switch-workspaces.md)
- The same operations are MCP tools: `list_members` and `invite_member` ([tools](../mcp/tools.md)).
