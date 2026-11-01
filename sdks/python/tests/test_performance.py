"""Connections, timeouts, retries and polling: the behaviour that decides latency and load.

Connection counting runs against a real local HTTP/1.1 server (a mock transport has no connections).
"""

from __future__ import annotations

import asyncio
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest
from conftest import ANSWER, job, json_response, r, seq

from mitra import AsyncMitra, Mitra, MitraError, RateLimitError, _core
from mitra.client import _file_part

# --------------------------------------------------------------------------- a counting server


class CountingServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, delay: float = 0.0) -> None:
        super().__init__(("127.0.0.1", 0), _Handler)
        self.delay = delay
        self.connections = 0
        self.requests = 0
        self.active = 0
        self.peak = 0
        self.lock = threading.Lock()

    def get_request(self):
        request = super().get_request()
        with self.lock:
            self.connections += 1
        return request

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server_address[1]}"


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # keep-alive

    def do_GET(self):
        server: CountingServer = self.server  # type: ignore[assignment]
        with server.lock:
            server.requests += 1
            server.active += 1
            server.peak = max(server.peak, server.active)
        try:
            time.sleep(server.delay)
            body = json.dumps({"connectors": []}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        finally:
            with server.lock:
                server.active -= 1

    def log_message(self, *args):
        pass


@pytest.fixture
def server(monkeypatch):
    monkeypatch.setenv("NO_PROXY", "*")
    monkeypatch.setenv("no_proxy", "*")
    srv = CountingServer()
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield srv
    srv.shutdown()
    srv.server_close()


def test_sequential_calls_share_one_connection(server):
    with Mitra("mtk_test", base_url=server.url) as client:
        for _ in range(20):
            client.connectors.list()
    assert server.requests == 20
    assert server.connections == 1


def test_default_keepalive_outlives_the_polling_interval():
    # httpx's own default is 5 s, so a poll every 15 s reconnected (TCP + TLS) each time. The server
    # closes an idle connection after about 60 s, so 30 s is the safe, useful middle.
    assert 15 < _core.DEFAULT_KEEPALIVE_EXPIRY < 60
    assert _core.DEFAULT_MAX_KEEPALIVE >= 10 and _core.DEFAULT_MAX_CONNECTIONS >= 50


def test_keepalive_expiry_is_configurable_and_closes_idle_connections(server):
    with Mitra("mtk_test", base_url=server.url, keepalive_expiry=0.2) as client:
        client.connectors.list()
        time.sleep(0.6)
        client.connectors.list()
    assert server.connections == 2


def test_pool_limit_caps_concurrent_connections(server):
    server.delay = 0.15
    with Mitra("mtk_test", base_url=server.url, max_connections=2) as client:
        threads = [threading.Thread(target=client.connectors.list) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    assert server.requests == 8
    assert server.peak <= 2
    assert server.connections <= 2


def test_one_client_is_safe_across_threads(server):
    errors: list[BaseException] = []

    def work(client: Mitra) -> None:
        try:
            for _ in range(10):
                assert client.connectors.list().connectors == []
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    with Mitra("mtk_test", base_url=server.url, max_connections=4) as client:
        threads = [threading.Thread(target=work, args=(client,)) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    assert not errors
    assert server.requests == 80
    assert server.connections <= 4


async def test_async_client_shares_a_pool_across_tasks_and_closes_it(server):
    server.delay = 0.1
    async with AsyncMitra("mtk_test", base_url=server.url, max_connections=3) as client:
        await asyncio.gather(*(client.connectors.list() for _ in range(12)))
        http = client._http
    assert server.requests == 12
    assert server.peak <= 3 and server.connections <= 3
    assert http.is_closed


def test_a_client_it_does_not_own_is_left_open():
    http = httpx.Client(transport=httpx.MockTransport(lambda request: json_response({})))
    Mitra("mtk_test", http_client=http).close()
    assert not http.is_closed


def test_http2_is_opt_in_and_names_the_extra_when_missing(monkeypatch):
    Mitra("mtk_test", http2=True).close()  # h2 is in the dev extras
    monkeypatch.setitem(sys.modules, "h2", None)
    with pytest.raises(ImportError, match=r"mitra-sdk\[http2\]"):
        Mitra("mtk_test", http2=True)


# --------------------------------------------------------------------------- timeouts


def timeouts_of(handler) -> list[dict]:
    return [request.extensions["timeout"] for request in handler.calls]


def test_connect_is_bounded_separately_from_read(make_client):
    handler = seq(r({"connectors": []}))
    make_client(handler, timeout=45).connectors.list()
    sent = timeouts_of(handler)[0]
    assert sent["read"] == 45 and sent["write"] == 45 and sent["pool"] == 45
    assert sent["connect"] == 10


def test_connect_timeout_is_configurable_and_never_above_timeout(make_client):
    handler = seq(r({"connectors": []}))
    make_client(handler, timeout=5, connect_timeout=30).connectors.list()
    assert timeouts_of(handler)[0]["connect"] == 5
    handler = seq(r({"connectors": []}))
    make_client(handler, connect_timeout=2).connectors.list()
    assert timeouts_of(handler)[0]["connect"] == 2


def test_an_httpx_timeout_is_used_as_given(make_client):
    handler = seq(r({"connectors": []}))
    given = httpx.Timeout(connect=1, read=7, write=3, pool=2)
    make_client(handler, timeout=given).connectors.list()
    assert timeouts_of(handler)[0] == {"connect": 1, "read": 7, "write": 3, "pool": 2}


def test_per_call_request_timeout(make_client):
    handler = seq(r({"connectors": []}))
    make_client(handler).connectors.list(request_timeout=3)
    assert timeouts_of(handler)[0]["read"] == 3


def test_a_waiting_request_reads_longer_than_the_server_waits_but_connects_fast(make_client):
    handler = seq(r(job("succeeded", kind="gems")))
    make_client(handler).gems.generate("s1", wait=60)
    assert handler.calls[0].headers["prefer"] == "wait=60"
    sent = timeouts_of(handler)[0]
    assert sent["read"] >= 60 + 10  # the server holds the request for up to 60 s
    assert sent["connect"] == 10 and sent["write"] == 60


def test_deadline_caps_every_phase_of_an_attempt(make_client):
    handler = seq(r({"connectors": []}))
    make_client(handler).connectors.list(deadline=5)
    sent = timeouts_of(handler)[0]
    assert max(sent.values()) <= 5


def test_deadline_that_has_passed_raises_without_sending(make_client):
    handler = seq(r({"connectors": []}))
    with pytest.raises(MitraError, match="deadline"):
        make_client(handler).connectors.list(deadline=0)
    assert handler.calls == []


# ---------------------------------------------------------------------------- retries


@pytest.fixture
def sleeps(monkeypatch):
    slept: list[float] = []
    monkeypatch.setattr("time.sleep", slept.append)
    return slept


def always(status: int, headers: dict | None = None):
    return seq(lambda: json_response({"detail": {"category": "server", "message": "x"}},
                                     status, headers))


def test_backoff_is_exponential_and_capped_with_jitter(make_client, sleeps, monkeypatch):
    monkeypatch.setattr("random.random", lambda: 0.0)
    with pytest.raises(MitraError):
        make_client(always(503), max_retries=5).connectors.list()
    assert sleeps == pytest.approx([0.25, 0.5, 1.0, 2.0, 4.0])
    sleeps.clear()
    monkeypatch.setattr("random.random", lambda: 0.999999)
    with pytest.raises(MitraError):
        make_client(always(503), max_retries=6).connectors.list()
    assert sleeps == pytest.approx([0.5, 1.0, 2.0, 4.0, 8.0, 8.0], rel=1e-3)  # capped at 8 s


def test_two_clients_that_fail_together_do_not_retry_together(make_client, sleeps):
    for _ in range(30):
        with pytest.raises(MitraError):
            make_client(always(503), max_retries=1).connectors.list()
    assert len(set(sleeps)) > 20  # jittered, not one fixed value
    assert all(0.25 <= s <= 0.5 for s in sleeps)


def test_retry_after_is_honoured(make_client, sleeps):
    handler = seq(
        lambda: json_response({"detail": {"category": "rate", "message": "x"}}, 429,
                              {"Retry-After": "3"}),
        r({"connectors": []}),
    )
    make_client(handler, max_retries=2).connectors.list()
    assert sleeps == [3.0]


def test_a_retry_after_beyond_a_minute_is_raised_not_slept(make_client, sleeps):
    handler = always(429, {"Retry-After": "120"})
    with pytest.raises(RateLimitError) as info:
        make_client(handler, max_retries=3).connectors.list()
    assert info.value.retry_after == 120
    assert sleeps == [] and len(handler.calls) == 1


def test_total_sleep_stays_inside_the_retry_budget(make_client, sleeps):
    client = make_client(always(503, {"Retry-After": "4"}), max_retries=5)
    client.settings.retry_budget = 5.0
    with pytest.raises(MitraError):
        client.connectors.list()
    assert sleeps == [4.0]


def test_a_call_deadline_stops_retries_that_would_pass_it(make_client, sleeps):
    handler = always(503, {"Retry-After": "2"})
    with pytest.raises(MitraError):
        make_client(handler, max_retries=3).connectors.list(deadline=1.0)
    assert sleeps == [] and len(handler.calls) == 1


def test_per_call_max_retries(make_client, sleeps):
    handler = always(503)
    with pytest.raises(MitraError):
        make_client(handler, max_retries=5).connectors.list(max_retries=1)
    assert len(handler.calls) == 2


@pytest.mark.parametrize("status", [408, 500, 502, 503, 504])
def test_get_retries_transient_statuses(make_client, sleeps, status):
    handler = seq(lambda: json_response({"detail": {"category": "server", "message": "x"}}, status),
                  r({"connectors": []}))
    make_client(handler, max_retries=1).connectors.list()
    assert len(handler.calls) == 2


@pytest.mark.parametrize("status", [400, 401, 403, 404, 409, 422])
def test_client_errors_are_never_retried(make_client, sleeps, status):
    handler = always(status)
    with pytest.raises(MitraError):
        make_client(handler, max_retries=3).connectors.list()
    assert len(handler.calls) == 1 and sleeps == []


def test_a_keyed_post_retries_a_500_and_an_unkeyed_post_does_not(make_client, sleeps):
    handler = seq(lambda: json_response({"detail": {"category": "server", "message": "x"}}, 500),
                  r(ANSWER))
    make_client(handler, max_retries=1).ask("q")  # ask carries an Idempotency-Key
    assert len(handler.calls) == 2
    assert handler.calls[0].headers["idempotency-key"] == handler.calls[1].headers["idempotency-key"]
    unkeyed = always(500)
    with pytest.raises(MitraError):
        make_client(unkeyed, max_retries=3).sources.test({"type": "postgres"})
    assert len(unkeyed.calls) == 1


def test_network_errors_retry_on_safe_calls_only(make_client, sleeps):
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.method)
        if len(calls) == 1:
            raise httpx.ConnectError("reset")
        return json_response({"connectors": []})

    make_client(handler, max_retries=1).connectors.list()
    assert calls == ["GET", "GET"]
    calls.clear()

    def down(request: httpx.Request) -> httpx.Response:
        calls.append(request.method)
        raise httpx.ReadTimeout("slow")

    with pytest.raises(MitraError, match="network error"):
        make_client(down, max_retries=3).sources.test({"type": "postgres"})
    assert calls == ["POST"]


# ---------------------------------------------------------------------------- polling


def test_a_job_that_the_202_just_described_is_not_fetched_again_at_once(make_client, sleeps):
    methods: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        methods.append(request.method)
        if request.method == "POST":
            return json_response(job("queued"), 202, {"Retry-After": "2"})
        return json_response(job("succeeded"))

    done = make_client(handler).predictions.run("forecast", source_id="s1")
    assert done.state == "succeeded"
    assert methods == ["POST", "GET"]
    assert sleeps == [1.0]  # waited first, one poll


def test_polling_delays_grow_to_the_cap(make_client, sleeps):
    states = ["running"] * 8 + ["succeeded"]
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        state = states[min(calls["n"], len(states) - 1)]
        calls["n"] += 1
        return json_response(job(state))

    make_client(handler).jobs.wait("j1")
    assert sleeps[:4] == [1.0, 1.5, 2.25, 3.375]
    assert max(sleeps) <= 15.0 and sleeps == sorted(sleeps)


# ---------------------------------------------------------------------------- streams


class _Stalls(httpx.SyncByteStream):
    def __iter__(self):
        yield b"event: started\ndata: {}\n\n"
        raise httpx.ReadTimeout("no heartbeat")


def test_a_stream_has_a_read_timeout_and_a_stall_is_a_mitra_error():
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.extensions["timeout"])
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=_Stalls())

    client = Mitra("mtk_test", http_client=httpx.Client(transport=httpx.MockTransport(handler)))
    events = []
    with pytest.raises(MitraError, match="network error"):
        for event in client.ask_stream("q"):
            events.append(event.event)
    assert events == ["started"]
    assert seen[0]["read"] == 60  # not None: a silent stream ends


# ---------------------------------------------------------------------------- uploads


def test_a_path_is_streamed_from_disk_and_closed(tmp_path):
    path = tmp_path / "sales.csv"
    path.write_bytes(b"a,b\n1,2\n")
    with _file_part(path, None, "text/csv") as (name, content, content_type):
        assert name == "sales.csv" and content_type == "text/csv"
        assert not isinstance(content, bytes) and not content.closed
        handle = content
    assert handle.closed


def test_upload_from_a_path_sends_the_bytes(make_client, tmp_path):
    path = tmp_path / "sales.csv"
    path.write_bytes(b"a,b\n1,2\n")
    handler = seq(r({"id": "f1", "name": "sales.csv", "format": "csv", "size_bytes": 8,
                     "status": "ready", "ready": True, "decision_options": [], "tables": [],
                     "created_at": "2026-10-31T00:00:00Z", "updated_at": "2026-10-31T00:00:01Z"},
                    201))
    make_client(handler).files.upload(path)
    assert b"a,b\n1,2\n" in handler.calls[0].content


async def test_async_upload_keeps_the_file_open_until_the_request_is_done(make_async_client, tmp_path):
    path = tmp_path / "sales.csv"
    path.write_bytes(b"a,b\n1,2\n")
    bodies: list[bytes] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(await request.aread())
        return json_response({"id": "f1", "name": "sales.csv", "format": "csv", "size_bytes": 8,
                              "status": "ready", "ready": True, "decision_options": [],
                              "tables": [], "created_at": "2026-10-31T00:00:00Z",
                              "updated_at": "2026-10-31T00:00:01Z"}, 201)

    out = await make_async_client(handler).files.upload(path)
    assert out.ready and b"a,b\n1,2\n" in bodies[0]
