"""Mint Matih embed tokens on your backend and serve a page that shows them with <matih-embed>.

Standard library HTTP server plus the Matih Python SDK: the same shape in FastAPI, Flask or
Django is one route. The API key stays in this process; the browser only gets a short-lived
token (valid for one resource, the filters you chose, and your page's origin).

    MATIH_API_KEY=mtk_... EMBED_RESOURCE_ID=d_123 python server.py

Then open http://localhost:3000.
"""

from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from mitra import EmbedNotFoundError, EmbedRefusedError, Mitra, MitraError, embed_src

HERE = Path(__file__).parent
MAX_BODY = 4096
# Where the <matih-embed> module comes from. In your own app serve the file from the
# @matihlabs/embed npm package (dist/index.js) with your other static assets.
DEFAULT_ELEMENT_FILE = HERE.parent.parent.parent / "sdks" / "embed" / "dist" / "index.js"


def viewer_for(_handler: BaseHTTPRequestHandler) -> dict[str, str]:
    """Who is looking at the page, and which rows they may see. REPLACE THIS with your own
    session lookup (cookie, JWT, ...). Filters come from your session, never from the request
    body: a viewer must not be able to choose the rows they are shown."""
    return {"customer_id": "C123"}


def make_handler(
    mitra: Mitra,
    resource: dict[str, str],
    app_origin: str,
    filter_param: str = "customer_id",
    element_file: Path = DEFAULT_ELEMENT_FILE,
) -> type[BaseHTTPRequestHandler]:
    def mint(handler: BaseHTTPRequestHandler) -> dict[str, str]:
        viewer = viewer_for(handler)
        embed = mitra.embeds.create(
            resource=resource,
            # Gems cannot be filtered: send filters only for a dashboard.
            filters={filter_param: viewer["customer_id"]} if resource["type"] == "dashboard" else None,
            origins=[app_origin],  # only this page may frame the embed
            ttl_seconds=300,  # a token is never renewed: the element asks again before it expires
        )
        # Do not log `embed`: the token is a secret. Send the browser the token and the page it is for.
        return {"token": embed.token, "src": embed_src(embed.url)}

    class Handler(BaseHTTPRequestHandler):
        server_version = "matih-embed-example"

        def log_message(self, format: str, *args: Any) -> None:
            sys.stderr.write(f"{self.command} {urlsplit(self.path).path}\n")

        # ---------------------------------------------------------------- helpers
        def _json(self, status: int, body: dict[str, Any], extra: dict[str, str] | None = None) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            for key, value in (extra or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(data)

        def _file(self, path: Path, content_type: str, cache: str) -> None:
            try:
                data = path.read_bytes()
            except OSError:
                self._json(404, {"error": "not_found"})
                return
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", cache)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)

        # ---------------------------------------------------------------- routes
        def do_GET(self) -> None:
            path = urlsplit(self.path).path
            if path in ("/", "/index.html"):
                self._file(HERE / "public" / "index.html", "text/html; charset=utf-8", "no-cache")
            elif path == "/matih-embed.js":
                self._file(element_file, "text/javascript; charset=utf-8", "public, max-age=300")
            elif path == "/api/matih-embed-token":
                self._json(405, {"error": "method_not_allowed"}, {"Allow": "POST"})
            else:
                self._json(404, {"error": "not_found"})

        do_HEAD = do_GET

        def do_POST(self) -> None:
            if urlsplit(self.path).path != "/api/matih-embed-token":
                self._json(404, {"error": "not_found"})
                return
            # The element sends JSON; a cross-site form post cannot, and a cross-site fetch is
            # held by CORS. Checking both keeps another site from minting with your visitor's session.
            if not (self.headers.get("Content-Type") or "").startswith("application/json"):
                self._json(415, {"error": "json_required"})
                return
            origin = self.headers.get("Origin")
            if origin is not None and origin != app_origin:
                self._json(403, {"error": "bad_origin"})
                return
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                self._json(413, {"error": "too_large"})
                return
            self.rfile.read(length)  # {} first, {"embed": "emt_..."} on a refresh; nothing in it is trusted
            try:
                body = mint(self)
            except EmbedRefusedError as err:
                sys.stderr.write(f"embed refused: {err.code or 422}: {err.message}\n")
                self._json(502, {"error": err.code or "refused"})
            except EmbedNotFoundError as err:
                sys.stderr.write(f"embed resource not found: {err.message}\n")
                self._json(502, {"error": "resource_not_found"})
            except MitraError as err:
                sys.stderr.write(f"mint failed: HTTP {err.status} {err.category}: {err.message}\n")
                self._json(502, {"error": "mint_failed"})
            else:
                self._json(200, body, {"Cache-Control": "no-store"})

    return Handler


def main() -> None:
    kind = os.environ.get("EMBED_RESOURCE_TYPE", "dashboard")
    resource_id = os.environ.get("EMBED_RESOURCE_ID")
    api_key = os.environ.get("MATIH_API_KEY")
    if not api_key or not resource_id or kind not in ("dashboard", "gems"):
        sys.exit(
            "Set MATIH_API_KEY (a key with the embeds:create scope), EMBED_RESOURCE_ID (a dashboard id, or a\n"
            "source id with EMBED_RESOURCE_TYPE=gems) and, optionally, APP_ORIGIN (default http://localhost:3000)."
        )
    port = int(os.environ.get("PORT", "3000"))
    app_origin = os.environ.get("APP_ORIGIN", f"http://localhost:{port}")
    handler = make_handler(
        Mitra(api_key),  # MATIH_BASE_URL is read by the SDK too
        {"type": kind, "id": resource_id},
        app_origin,
        os.environ.get("EMBED_FILTER_PARAM", "customer_id"),
    )
    print(f"open {app_origin}")
    ThreadingHTTPServer(("", port), handler).serve_forever()


if __name__ == "__main__":
    main()
