from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from http.server import ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest
from mitra import Mitra

from server import make_handler

APP_ORIGIN = "http://localhost:3000"

MINTED = {
    "id": "emt_Ab12",
    "token": "met_secret",
    "expires_at": "2026-10-31T10:05:00Z",
    "url": "https://matih.test/embed/dashboards/d_123?e=emt_Ab12#token=met_secret",
    "resource": {"type": "dashboard", "id": "d_123"},
    "origins": [APP_ORIGIN],
}


class Matih:
    """A fake Matih: records what the SDK sent, answers with `status` and `body`."""

    def __init__(self, status: int = 201, body: dict | None = None) -> None:
        self.status = status
        self.body = MINTED if body is None else body
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(self.status, json=self.body)


@pytest.fixture
def element_file(tmp_path: Path) -> Path:
    """Stand-in for @matihlabs/embed's dist/index.js, so the test needs no build."""
    path = tmp_path / "element.js"
    path.write_text("export const standIn = true;\n")
    return path


def serve(matih: Matih, resource: dict[str, str], element_file: Path) -> tuple[ThreadingHTTPServer, str]:
    client = Mitra(
        "mtk_test",
        base_url="https://matih.test",
        max_retries=0,
        http_client=httpx.Client(transport=httpx.MockTransport(matih)),
    )
    handler = make_handler(client, resource, APP_ORIGIN, element_file=element_file)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}"


@pytest.fixture
def dashboard(element_file: Path) -> Iterator[tuple[Matih, str]]:
    matih = Matih()
    server, base = serve(matih, {"type": "dashboard", "id": "d_123"}, element_file)
    yield matih, base
    server.shutdown()
    server.server_close()


JSON = {"Content-Type": "application/json"}


def test_mints_with_the_viewers_filter_and_this_pages_origin(dashboard):
    matih, base = dashboard
    res = httpx.post(f"{base}/api/matih-embed-token", headers=JSON, content=b"{}")
    assert res.status_code == 200
    assert res.headers["cache-control"] == "no-store"
    assert res.json() == {
        "token": "met_secret",
        "src": "https://matih.test/embed/dashboards/d_123?e=emt_Ab12",
    }
    sent = matih.requests[-1]
    assert (sent.method, str(sent.url)) == ("POST", "https://matih.test/api/v1/embeds")
    assert sent.headers["authorization"] == "Bearer mtk_test"
    assert json.loads(sent.content) == {
        "resource": {"type": "dashboard", "id": "d_123"},
        "origins": [APP_ORIGIN],
        "filters": {"customer_id": "C123"},
        "ttl_seconds": 300,
    }


def test_a_refresh_mints_again_and_ignores_the_body(dashboard):
    matih, base = dashboard
    body = json.dumps({"embed": "emt_Ab12", "filters": {"customer_id": "C999"}}).encode()
    res = httpx.post(f"{base}/api/matih-embed-token", headers=JSON, content=body)
    assert res.status_code == 200
    assert json.loads(matih.requests[-1].content)["filters"] == {"customer_id": "C123"}


def test_refuses_what_the_element_never_sends(dashboard):
    matih, base = dashboard
    url = f"{base}/api/matih-embed-token"
    assert httpx.post(url, headers={"Content-Type": "text/plain"}, content=b"{}").status_code == 415
    evil = {**JSON, "Origin": "https://evil.example"}
    assert httpx.post(url, headers=evil, content=b"{}").status_code == 403
    assert httpx.get(url).status_code == 405
    assert matih.requests == [], "no token was minted for any of them"


def test_serves_the_page_and_the_element_and_nothing_else(dashboard):
    _, base = dashboard
    page = httpx.get(f"{base}/")
    assert page.status_code == 200
    assert '<matih-embed token-endpoint="/api/matih-embed-token"' in page.text
    assert "mtk_" not in page.text and "met_" not in page.text
    js = httpx.get(f"{base}/matih-embed.js")
    assert js.status_code == 200 and "javascript" in js.headers["content-type"]
    assert httpx.get(f"{base}/server.py").status_code == 404


def test_a_refusal_answers_502_with_the_code_only(element_file):
    matih = Matih(
        422,
        {"detail": {"category": "validation", "code": "invalid_value", "message": "secret detail"}},
    )
    server, base = serve(matih, {"type": "dashboard", "id": "d_123"}, element_file)
    try:
        res = httpx.post(f"{base}/api/matih-embed-token", headers=JSON, content=b"{}")
    finally:
        server.shutdown()
        server.server_close()
    assert res.status_code == 502
    assert res.json() == {"error": "invalid_value"}
    assert "secret detail" not in res.text


def test_gems_are_minted_without_filters(element_file):
    matih = Matih(body={**MINTED, "resource": {"type": "gems", "id": "s_1"}})
    server, base = serve(matih, {"type": "gems", "id": "s_1"}, element_file)
    try:
        res = httpx.post(f"{base}/api/matih-embed-token", headers=JSON, content=b"{}")
    finally:
        server.shutdown()
        server.server_close()
    assert res.status_code == 200
    sent = json.loads(matih.requests[0].content)
    assert sent["resource"] == {"type": "gems", "id": "s_1"}
    assert "filters" not in sent
