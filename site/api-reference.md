---
hide:
  - toc
---

# API reference

Every route of `/api/v1`, rendered in your browser from the live OpenAPI 3.1 spec the server
publishes, so it is never behind the deployed API:

```text
https://workspace.matih.ai/api/v1/openapi.json
```

You can also open the server's own interactive docs at
[workspace.matih.ai/api/v1/docs](https://workspace.matih.ai/api/v1/docs), or download the spec:

```bash
curl -s https://workspace.matih.ai/api/v1/openapi.json -o openapi.json
```

A copy of the spec is committed to the [`openapi/`](https://github.com/matih-labs/mitra-sdk/tree/main/openapi) folder of the
SDK repository on every release; the Python and TypeScript SDKs are generated and checked against it.

<div id="redoc-host">
  <p id="redoc-status">Loading the API reference from workspace.matih.ai ...</p>
</div>

<noscript>The interactive reference needs JavaScript. Use the
<a href="https://workspace.matih.ai/api/v1/docs">server's own docs</a> or download the spec above.</noscript>

<script src="https://cdn.jsdelivr.net/npm/redoc@2.1.5/bundles/redoc.standalone.js"></script>
<script>
  (function () {
    var host = document.getElementById("redoc-host");
    var status = document.getElementById("redoc-status");
    if (!host) return;
    var dark = document.body.getAttribute("data-md-color-scheme") === "slate";
    var text = dark ? "#e5e7eb" : "#1f2937";
    function fail(reason) {
      status.textContent =
        "Could not load the live spec (" + reason + "). Open https://workspace.matih.ai/api/v1/docs instead.";
    }
    if (!window.Redoc) { fail("Redoc did not load"); return; }
    fetch("https://workspace.matih.ai/api/v1/openapi.json")
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (spec) {
        status.remove();
        window.Redoc.init(
          spec,
          {
            hideDownloadButton: false,
            expandResponses: "200,201,202",
            pathInMiddlePanel: true,
            scrollYOffset: 100,
            theme: {
              colors: { primary: { main: dark ? "#fbbf24" : "#b45309" }, text: { primary: text } },
              typography: { fontFamily: "Inter, system-ui, sans-serif", code: { fontFamily: "JetBrains Mono, monospace" } },
              sidebar: { backgroundColor: dark ? "#111827" : "#f9fafb", textColor: text },
              rightPanel: { backgroundColor: "#111827" },
            },
          },
          host
        );
      })
      .catch(function (err) { fail(err.message); });
  })();
</script>

!!! tip "Prefer a typed client?"
    The [Python](sdk/python.md) and [TypeScript](sdk/typescript.md) SDKs cover the same operations with typed errors,
    retries and job waiting. For the model behind the routes, start with [Concepts](concepts/workspaces.md).
